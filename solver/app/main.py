from __future__ import annotations

import json
import os
import secrets
from typing import cast
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from redis import Redis
from redis.exceptions import RedisError

from app.schemas import Diagnostic, Outcome, ScheduleRequest, ScheduleResponse, ValidationRequest
from engine.solver import solve
from engine.validator import validate_schedule

app = FastAPI(title="RGIT Timetable Solver", version="1.0.0")
_redis = Redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True, socket_connect_timeout=2, socket_timeout=2)


def require_solver_key(x_solver_key: str | None = Header(default=None, alias="X-Solver-Key")):
    expected = os.getenv("SOLVER_API_KEY")
    if not expected:
        raise HTTPException(status_code=503, detail="Solver API key is not configured.")
    if not x_solver_key or not secrets.compare_digest(x_solver_key, expected):
        raise HTTPException(status_code=401, detail="Unauthorized solver request.")


@app.exception_handler(RequestValidationError)
async def request_validation_error(request: Request, exc: RequestValidationError):
    diagnostics = [Diagnostic(code="REQUEST_VALIDATION", message="Request schema validation failed.", related_ids=[], suggestion=str(error.get("loc", "input"))) for error in exc.errors()]
    return JSONResponse(status_code=422, content=ScheduleResponse(outcome=Outcome.VALIDATION_ERROR, status_message="Request validation failed.", diagnostics=diagnostics).model_dump(mode="json"))


@app.get("/health")
def health():
    try:
        _redis.ping()
    except RedisError as exc:
        raise HTTPException(status_code=503, detail="Solver queue is unavailable.") from exc
    return {"status": "ok", "service": "rgit-timetable-solver", "queue": "ready"}


@app.post("/v1/schedules/generate", response_model=ScheduleResponse, dependencies=[Depends(require_solver_key)])
def generate(request: ScheduleRequest):
    try:
        response = solve(request)
        if response.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL):
            report = validate_schedule(request, response.sessions)
            response.validation = report
            if not report.valid:
                response.outcome = Outcome.EXECUTION_ERROR
                response.status_message = "Solver output failed independent validation; no schedule is published."
                response.sessions = []
        return response
    except Exception as exc:
        return JSONResponse(status_code=500, content=ScheduleResponse(outcome=Outcome.EXECUTION_ERROR, status_message="Solver execution failed.", diagnostics=[Diagnostic(code="EXECUTION_ERROR", message=str(exc))]).model_dump(mode="json"))


@app.post("/v1/jobs", status_code=202, dependencies=[Depends(require_solver_key)])
def create_job(request: ScheduleRequest):
    job_id = str(uuid4())
    try:
        _redis.hset(f"solver:job:{job_id}", mapping={"job_id": job_id, "status": "queued"})
        _redis.expire(f"solver:job:{job_id}", 259200)
        _redis.lpush("solver:queue", json.dumps({"job_id": job_id, "request": request.model_dump(mode="json")}))
    except RedisError as exc:
        raise HTTPException(status_code=503, detail="Solver queue is unavailable.") from exc
    return {"job_id": job_id, "status": "queued"}


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_solver_key)])
def get_job(job_id: str):
    try:
        stored = cast(dict[str, str], _redis.hgetall(f"solver:job:{job_id}"))
    except RedisError as exc:
        raise HTTPException(status_code=503, detail="Solver queue is unavailable.") from exc
    job = dict(stored)
    if not job:
        return JSONResponse(status_code=404, content={"detail": "job not found"})
    if job.get("result"):
        job["result"] = json.loads(job["result"])
    return job


@app.post("/v1/schedules/validate", dependencies=[Depends(require_solver_key)])
def validate(request: ValidationRequest):
    return validate_schedule(request.schedule, request.sessions)
