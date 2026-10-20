from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, Iterable, List, Tuple

from ortools.sat.python import cp_model

from app.schemas import (
    Diagnostic, FixedSession, GenerationOptions, Outcome, Requirement,
    ScheduleRequest, ScheduleResponse, ScheduledSession, SessionType,
)


@dataclass(frozen=True)
class Candidate:
    day_id: str
    day_label: str
    start_index: int
    end_index: int
    start_minute: int
    end_minute: int
    period_ids: Tuple[str, ...]
    room_id: str
    faculty_id: str


@dataclass(frozen=True)
class ExpandedSession:
    session_id: str
    requirement: Requirement


def _period_candidates(request: ScheduleRequest, requirement: Requirement) -> List[Tuple[str, str, int, int, int, int, Tuple[str, ...]]]:
    result = []
    for day in request.days:
        if not day.enabled:
            continue
        periods = day.periods
        for start in range(len(periods)):
            covered: List = []
            total = 0
            for end in range(start, len(periods)):
                p = periods[end]
                if end > start and periods[end - 1].break_after:
                    break
                if end > start and periods[end - 1].end_minute != p.start_minute:
                    break
                if p.blocked:
                    break
                covered.append(p)
                total += p.end_minute - p.start_minute
                if total >= requirement.duration_minutes:
                    # A candidate may consume whole configured periods; this supports multi-period labs.
                    if day.working_start_minute is not None and periods[start].start_minute < day.working_start_minute:
                        break
                    if day.working_end_minute is not None and p.end_minute > day.working_end_minute:
                        break
                    result.append((day.id, day.label, start, end, periods[start].start_minute,
                                   p.end_minute, tuple(x.id for x in covered)))
                    break
    return result


def expand_requirements(request: ScheduleRequest) -> List[ExpandedSession]:
    expanded = []
    for req in request.requirements:
        for n in range(req.sessions_per_week):
            occurrence = n + 1
            group_ids = req.group_ids_by_occurrence.get(occurrence, req.group_ids)
            expanded.append(ExpandedSession(f"{req.id}__{occurrence}", req.model_copy(update={"group_ids": group_ids})))
    return expanded


def _fixed_for(expanded: ExpandedSession, request: ScheduleRequest) -> List[FixedSession]:
    return [f for f in request.fixed_sessions if f.session_id == expanded.session_id]


def _lookup_groups(request):
    return {g.id: g for g in request.groups}


def _required_group_capacity(group_ids: List[str], groups) -> int:
    selected = [groups[group_id] for group_id in group_ids if group_id in groups]
    actual_participants = {participant for group in selected for participant in group.participant_ids}
    if actual_participants:
        return len(actual_participants)
    selected_ids = {group.id for group in selected}
    covered_children = {child_id for group in selected for child_id in set(group.overlapping_group_ids) & selected_ids}
    return sum(group.size for group in selected if group.id not in covered_children)


def _groups_conflict(req_a: Requirement, req_b: Requirement, groups) -> bool:
    a = set(req_a.group_ids) | set(req_a.conflict_group_ids)
    b = set(req_b.group_ids) | set(req_b.conflict_group_ids)
    if a & b:
        return True
    for ga in req_a.group_ids:
        for gb in req_b.group_ids:
            if ga in groups and gb in groups:
                if gb in groups[ga].overlapping_group_ids or ga in groups[gb].overlapping_group_ids:
                    return True
                if set(groups[ga].conflict_group_ids) & (set(groups[gb].conflict_group_ids) | {gb}):
                    return True
                if set(groups[gb].conflict_group_ids) & {ga}:
                    return True
                if set(groups[ga].participant_ids) & set(groups[gb].participant_ids):
                    return True
    return False


def _availability_ok(ids: Iterable[str], allowed: List[str] | None, blocked: List[str]) -> bool:
    ids = set(ids)
    if ids & set(blocked):
        return False
    return allowed is None or ids <= set(allowed)


def _diagnostics(request: ScheduleRequest) -> List[Diagnostic]:
    d: List[Diagnostic] = []
    group_ids = {g.id for g in request.groups}
    faculty_ids = {f.id for f in request.faculty}
    room_ids = {r.id for r in request.rooms}
    day_ids = {x.id for x in request.days}
    if len(day_ids) != len(request.days):
        d.append(Diagnostic(code="DUPLICATE_DAY", message="Day identifiers must be unique."))
    for req in request.requirements:
        referenced_groups = set(req.group_ids) | {group_id for selected in req.group_ids_by_occurrence.values() for group_id in selected}
        missing = referenced_groups - group_ids
        if missing:
            d.append(Diagnostic(code="UNKNOWN_GROUP", message=f"Requirement {req.id} references unknown groups: {sorted(missing)}", related_ids=[req.id]))
        if not set(req.faculty_ids) <= faculty_ids:
            d.append(Diagnostic(code="UNKNOWN_FACULTY", message=f"Requirement {req.id} references unknown faculty.", related_ids=[req.id]))
    for f in request.fixed_sessions:
        if f.day_id not in day_ids or f.room_id not in room_ids or f.faculty_id not in faculty_ids:
            d.append(Diagnostic(code="INVALID_LOCK", message=f"Fixed session {f.session_id} references an unknown day, room, or faculty.", related_ids=[f.session_id]))
    for room in request.rooms:
        if room.capacity <= 0:
            d.append(Diagnostic(code="INVALID_ROOM", message=f"Room {room.id} has invalid capacity.", related_ids=[room.id]))
    for day in request.days:
        for i, p in enumerate(day.periods[1:], 1):
            prev = day.periods[i - 1]
            if p.start_minute < prev.end_minute:
                d.append(Diagnostic(code="OVERLAPPING_PERIODS", message=f"Periods overlap on day {day.id}.", related_ids=[day.id], suggestion="Adjust period start/end times."))
    return d


def solve(request: ScheduleRequest) -> ScheduleResponse:
    started = time.monotonic()
    preflight = _diagnostics(request)
    if preflight:
        return ScheduleResponse(outcome=Outcome.VALIDATION_ERROR, status_message="Input validation failed.", diagnostics=preflight)

    groups = _lookup_groups(request)
    faculty_by_id = {f.id: f for f in request.faculty}
    rooms_by_id = {r.id: r for r in request.rooms}
    rooms = request.rooms
    expanded = expand_requirements(request)
    model = cp_model.CpModel()
    choices: Dict[str, List[Tuple[cp_model.IntVar, Candidate]]] = {}
    all_placements: List[Tuple[str, cp_model.IntVar, Candidate]] = []

    for session in expanded:
        req = session.requirement
        candidates: List[Tuple[cp_model.IntVar, Candidate]] = []
        fixed = _fixed_for(session, request)
        requested = request.options.requested_placement if request.options.repair_session_id == session.session_id else None
        fixed_effective = fixed + ([requested] if requested else [])
        for day_id, day_label, start, end, sm, em, period_ids in _period_candidates(request, req):
            day = next(x for x in request.days if x.id == day_id)
            if any(day.periods[i].break_after for i in range(start, end)):
                continue
            for faculty_id in req.faculty_ids:
                fac = faculty_by_id[faculty_id]
                if req.subject_id in fac.eligible_subject_ids:
                    if not _availability_ok(period_ids, fac.available_slot_ids, fac.unavailable_slot_ids):
                        continue
                    if fac.max_weekly_minutes is not None and fac.max_weekly_minutes < req.duration_minutes:
                        continue
                    for room in rooms:
                        required_capacity = max(req.min_room_capacity or 0, _required_group_capacity(req.group_ids, groups))
                        if room.capacity < required_capacity:
                            continue
                        if any(x not in room.facilities for x in req.room_facilities):
                            continue
                        if not _availability_ok(period_ids, room.available_slot_ids, room.unavailable_slot_ids):
                            continue
                        c = Candidate(day_id, day_label, start, end, sm, em, period_ids, room.id, faculty_id)
                        if fixed_effective and not any(f.day_id == day_id and f.start_period_index == start and f.room_id == room.id and f.faculty_id == faculty_id for f in fixed_effective):
                            continue
                        v = model.NewBoolVar(f"place_{session.session_id}_{day_id}_{start}_{room.id}_{faculty_id}")
                        candidates.append((v, c))
                        all_placements.append((session.session_id, v, c))
        if not candidates:
            related = [session.session_id, req.id]
            return ScheduleResponse(outcome=Outcome.INFEASIBLE, status_message="No legal candidate placement exists for a required session.", diagnostics=[Diagnostic(code="NO_CANDIDATE", message=f"No candidate placement for {session.session_id}; check timing, eligibility, availability, room capacity/facilities, or locks.", related_ids=related, suggestion="Add a compatible room/faculty slot or reduce the requirement.")], solver_wall_time_seconds=time.monotonic() - started)
        model.Add(sum(v for v, _ in candidates) == 1)
        choices[session.session_id] = candidates

    # Candidate-level hard non-overlap for all shared resources and explicit participant/conflict groups.
    for i, (sid_a, va, ca) in enumerate(all_placements):
        req_a = next(s.requirement for s in expanded if s.session_id == sid_a)
        for sid_b, vb, cb in all_placements[i + 1:]:
            if sid_a == sid_b:
                continue
            overlap = ca.day_id == cb.day_id and ca.start_index <= cb.end_index and cb.start_index <= ca.end_index
            if not overlap:
                continue
            req_b = next(s.requirement for s in expanded if s.session_id == sid_b)
            same_resource = ca.room_id == cb.room_id or ca.faculty_id == cb.faculty_id or _groups_conflict(req_a, req_b, groups)
            if same_resource:
                model.Add(va + vb <= 1)

    # Daily and weekly workload caps, plus per-subject daily limits.
    for fac in request.faculty:
        if fac.max_weekly_minutes is not None:
            terms = []
            for sid, v, c in all_placements:
                req = next(s.requirement for s in expanded if s.session_id == sid)
                if c.faculty_id == fac.id:
                    terms.append(v * req.duration_minutes)
            if terms:
                model.Add(sum(terms) <= fac.max_weekly_minutes)
        if fac.max_daily_minutes is not None:
            for day in request.days:
                terms = []
                for sid, v, c in all_placements:
                    req = next(s.requirement for s in expanded if s.session_id == sid)
                    if c.faculty_id == fac.id and c.day_id == day.id:
                        terms.append(v * req.duration_minutes)
                if terms:
                    model.Add(sum(terms) <= fac.max_daily_minutes)
        if fac.max_consecutive_periods is not None:
            occupancy: Dict[Tuple[str, int], cp_model.IntVar] = {}
            for day in request.days:
                for period_index, period in enumerate(day.periods):
                    covering = [
                        v for sid, v, c in all_placements
                        if c.faculty_id == fac.id
                        and c.day_id == day.id
                        and c.start_index <= period_index <= c.end_index
                    ]
                    if covering:
                        occupied = model.NewBoolVar(f"occupied_{fac.id}_{day.id}_{period_index}")
                        model.AddMaxEquality(occupied, covering)
                        occupancy[(day.id, period_index)] = occupied
            cap = fac.max_consecutive_periods
            for day in request.days:
                periods = day.periods
                for start in range(len(periods) - cap):
                    window = periods[start:start + cap + 1]
                    if any(p.blocked for p in window):
                        continue
                    if any(periods[i].break_after for i in range(start, start + cap)):
                        continue
                    occupied = [occupancy[(day.id, i)] for i in range(start, start + cap + 1) if (day.id, i) in occupancy]
                    if occupied:
                        model.Add(sum(occupied) <= cap)
    for req in request.requirements:
        if req.daily_limit:
            for day in request.days:
                terms = [v for sid, v, c in all_placements if sid.startswith(req.id + "__") and c.day_id == day.id]
                if terms:
                    model.Add(sum(terms) <= req.daily_limit)

    # Soft objective: deterministic linear penalties, never changing hard constraints.
    objective_terms = []
    w = request.options.objective_weights
    for sid, v, c in all_placements:
        session = next(s for s in expanded if s.session_id == sid)
        req = session.requirement
        fac = faculty_by_id[c.faculty_id]
        room = rooms_by_id[c.room_id]
        if req.session_type == SessionType.LAB and w.prefer_lab_blocks and room.room_type.casefold() not in {"laboratory", "lab"}:
            objective_terms.append(v * w.prefer_lab_blocks)
        if c.period_ids and w.preferred_time and fac.preferred_slot_ids:
            if not set(c.period_ids) <= set(fac.preferred_slot_ids):
                objective_terms.append(v * w.preferred_time)
        if req.preferred_room_ids and c.room_id not in req.preferred_room_ids:
            objective_terms.append(v * max(1, w.room_changes))
        previous = request.options.previous_placements.get(sid)
        if previous and w.change_minimization:
            if (previous.day_id, previous.start_period_index, previous.room_id, previous.faculty_id) != (c.day_id, c.start_index, c.room_id, c.faculty_id):
                objective_terms.append(v * w.change_minimization)
    # Penalize same-subject sessions sharing a day (spreading).
    for i, (sid_a, va, ca) in enumerate(all_placements):
        req_a = next(s.requirement for s in expanded if s.session_id == sid_a)
        for sid_b, vb, cb in all_placements[i + 1:]:
            req_b = next(s.requirement for s in expanded if s.session_id == sid_b)
            if ca.day_id == cb.day_id:
                pair = model.NewBoolVar(f"pair_{sid_a}_{sid_b}_{ca.start_index}_{cb.start_index}_{ca.room_id}_{cb.room_id}")
                model.AddBoolAnd([va, vb]).OnlyEnforceIf(pair)
                model.AddBoolOr([va.Not(), vb.Not()]).OnlyEnforceIf(pair.Not())
                if req_a.subject_id == req_b.subject_id and w.subject_spreading:
                    objective_terms.append(pair * w.subject_spreading)
                if ca.faculty_id == cb.faculty_id:
                    if ca.room_id != cb.room_id and w.room_changes:
                        objective_terms.append(pair * w.room_changes)
                    if w.daily_load_balance:
                        objective_terms.append(pair * w.daily_load_balance)
                    gap = max(cb.start_index - ca.end_index - 1, ca.start_index - cb.end_index - 1)
                    if gap > 0 and w.faculty_gaps:
                        objective_terms.append(pair * gap * w.faculty_gaps)
                if _groups_conflict(req_a, req_b, groups):
                    gap = max(cb.start_index - ca.end_index - 1, ca.start_index - cb.end_index - 1)
                    if gap > 0 and w.student_gaps:
                        objective_terms.append(pair * gap * w.student_gaps)
    if objective_terms:
        model.Minimize(sum(objective_terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = request.options.time_limit_seconds
    solver.parameters.num_search_workers = request.options.workers
    solver.parameters.random_seed = request.options.random_seed
    status = solver.Solve(model)
    elapsed = time.monotonic() - started
    if status == cp_model.INFEASIBLE:
        return ScheduleResponse(outcome=Outcome.INFEASIBLE, status_message="The hard constraints are infeasible.", diagnostics=[Diagnostic(code="INFEASIBLE_CONSTRAINTS", message="No complete schedule satisfies all hard constraints.", suggestion="Review generic diagnostics and relax data constraints; this is not an exact unsat core.")], solver_wall_time_seconds=elapsed)
    if status not in (cp_model.FEASIBLE, cp_model.OPTIMAL):
        return ScheduleResponse(outcome=Outcome.TIME_LIMIT_NO_SOLUTION, status_message="Time limit reached without a complete solution.", diagnostics=[Diagnostic(code="TIME_LIMIT_NO_SOLUTION", message="The solver found no complete schedule before the time limit; this is not proof of infeasibility.")], solver_wall_time_seconds=elapsed)

    results: List[ScheduledSession] = []
    for session in expanded:
        selected = next(c for v, c in choices[session.session_id] if solver.Value(v))
        req = session.requirement
        locked = any(f.session_id == session.session_id and f.locked for f in request.fixed_sessions)
        day = next(x for x in request.days if x.id == selected.day_id)
        results.append(ScheduledSession(session_id=session.session_id, requirement_id=req.id, subject_id=req.subject_id, subject_name=req.subject_name, session_type=req.session_type, day_id=selected.day_id, day_label=selected.day_label, start_period_index=selected.start_index, end_period_index=selected.end_index, start_minute=selected.start_minute, end_minute=selected.end_minute, room_id=selected.room_id, faculty_id=selected.faculty_id, group_ids=req.group_ids, locked=locked))
    outcome = Outcome.OPTIMAL if status == cp_model.OPTIMAL else Outcome.FEASIBLE
    return ScheduleResponse(outcome=outcome, status_message="Complete schedule found." if outcome == Outcome.OPTIMAL else "Complete feasible schedule found; optimality was not established.", sessions=results, objective_value=solver.ObjectiveValue() if objective_terms else 0, solver_wall_time_seconds=elapsed)
