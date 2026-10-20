from __future__ import annotations

import json
import os
import time
from typing import cast

from redis import Redis
from redis.exceptions import RedisError
from fastapi.responses import JSONResponse

from .main import generate
from app.schemas import Diagnostic, Outcome, ScheduleRequest, ScheduleResponse

QUEUE = "solver:queue"
PROCESSING = "solver:processing"
REDIS_URL = os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0")


def _client() -> Redis:
    return Redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2, socket_timeout=2)


def _result_payload(request: ScheduleRequest) -> dict:
    result = generate(request)
    if isinstance(result, JSONResponse):
        return json.loads(bytes(result.body).decode("utf-8"))
    return result.model_dump(mode="json")


def _recover_processing(client: Redis) -> None:
    # The deployment uses one worker replica. Re-queue its in-flight message after a restart.
    while True:
        item = cast(str | None, client.rpop(PROCESSING))
        if not item:
            break
        try:
            job_id = json.loads(str(item))["job_id"]
            client.hset(f"solver:job:{job_id}", mapping={"status": "queued"})
        finally:
            client.lpush(QUEUE, item)


def run() -> None:
    client = _client()
    while True:
        try:
            _recover_processing(client)
            item = cast(str | None, client.brpoplpush(QUEUE, PROCESSING, timeout=5))
        except RedisError:
            time.sleep(2)
            continue
        if not item:
            continue
        try:
            envelope = json.loads(str(item))
            job_id = str(envelope["job_id"])
            client.hset(f"solver:job:{job_id}", mapping={"status": "running"})
            request = ScheduleRequest.model_validate(envelope["request"])
            payload = _result_payload(request)
        except Exception as exc:
            payload = ScheduleResponse(
                outcome=Outcome.EXECUTION_ERROR,
                status_message="Background solver execution failed.",
                diagnostics=[Diagnostic(code="EXECUTION_ERROR", message=str(exc))],
            ).model_dump(mode="json")
        try:
            job_id = str(json.loads(str(item))["job_id"])
            client.hset(f"solver:job:{job_id}", mapping={"status": "finished", "result": json.dumps(payload)})
            client.expire(f"solver:job:{job_id}", 259200)
            client.lrem(PROCESSING, 1, cast(str, item))
        except RedisError:
            # Keep the item in the processing list; the next worker start will recover it.
            time.sleep(2)


if __name__ == "__main__":
    run()
