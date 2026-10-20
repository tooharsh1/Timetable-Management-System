from __future__ import annotations

from typing import Dict, List, Set, Tuple

from app.schemas import Diagnostic, ScheduleRequest, ScheduledSession, ValidationReport


def _overlap(a: ScheduledSession, b: ScheduledSession) -> bool:
    return a.day_id == b.day_id and a.start_period_index <= b.end_period_index and b.start_period_index <= a.end_period_index


def _group_conflict(a: ScheduledSession, b: ScheduledSession, request: ScheduleRequest) -> bool:
    groups = {g.id: g for g in request.groups}
    a_ids = set(a.group_ids)
    b_ids = set(b.group_ids)
    if a_ids & b_ids:
        return True
    for ga in a_ids:
        for gb in b_ids:
            if ga not in groups or gb not in groups:
                continue
            if gb in groups[ga].overlapping_group_ids or ga in groups[gb].overlapping_group_ids:
                return True
            if set(groups[ga].conflict_group_ids) & (set(groups[gb].conflict_group_ids) | {gb}):
                return True
            if set(groups[ga].participant_ids) & set(groups[gb].participant_ids):
                return True
    return False


def _required_group_capacity(group_ids: List[str], groups) -> int:
    selected = [groups[group_id] for group_id in group_ids if group_id in groups]
    actual_participants = {participant for group in selected for participant in group.participant_ids}
    if actual_participants:
        return len(actual_participants)
    selected_ids = {group.id for group in selected}
    covered_children = {child_id for group in selected for child_id in set(group.overlapping_group_ids) & selected_ids}
    return sum(group.size for group in selected if group.id not in covered_children)


def validate_schedule(request: ScheduleRequest, sessions: List[ScheduledSession]) -> ValidationReport:
    diagnostics: List[Diagnostic] = []
    requirements = {r.id: r for r in request.requirements}
    days = {d.id: d for d in request.days}
    rooms = {r.id: r for r in request.rooms}
    faculty = {f.id: f for f in request.faculty}
    groups = {g.id: g for g in request.groups}
    expected: Dict[str, int] = {r.id: r.sessions_per_week for r in request.requirements}
    actual: Dict[str, int] = {}
    occurrences: Dict[str, Set[int]] = {}
    faculty_minutes: Dict[str, int] = {}
    faculty_daily_minutes: Dict[Tuple[str, str], int] = {}
    faculty_occupied: Dict[Tuple[str, str], Set[int]] = {}
    requirement_daily_counts: Dict[Tuple[str, str], int] = {}

    if len(sessions) != sum(expected.values()):
        diagnostics.append(Diagnostic(code="INCOMPLETE_SESSION_COUNT", message=f"Expected {sum(expected.values())} sessions but received {len(sessions)}.", suggestion="Regenerate; partial schedules must not be published."))

    seen = set()
    for session in sessions:
        if session.session_id in seen:
            diagnostics.append(Diagnostic(code="DUPLICATE_SESSION", message=f"Session {session.session_id} appears more than once.", related_ids=[session.session_id]))
        seen.add(session.session_id)
        req = requirements.get(session.requirement_id)
        if req is None:
            diagnostics.append(Diagnostic(code="UNKNOWN_REQUIREMENT", message=f"Session {session.session_id} references unknown requirement.", related_ids=[session.session_id]))
            continue

        actual[req.id] = actual.get(req.id, 0) + 1
        if not session.session_id.startswith(req.id + "__"):
            diagnostics.append(Diagnostic(code="INVALID_SESSION_ID", message=f"Session {session.session_id} does not match requirement {req.id}.", related_ids=[session.session_id, req.id]))
        occurrence_text = session.session_id.removeprefix(req.id + "__")
        try:
            occurrence = int(occurrence_text)
        except ValueError:
            occurrence = 0
        if occurrence < 1 or occurrence > req.sessions_per_week:
            diagnostics.append(Diagnostic(code="INVALID_OCCURRENCE", message=f"Session {session.session_id} has an invalid weekly occurrence number.", related_ids=[session.session_id, req.id]))
        elif occurrence in occurrences.setdefault(req.id, set()):
            diagnostics.append(Diagnostic(code="DUPLICATE_OCCURRENCE", message=f"Requirement {req.id} repeats occurrence {occurrence}.", related_ids=[session.session_id, req.id]))
        else:
            occurrences[req.id].add(occurrence)
        expected_groups = req.group_ids_by_occurrence.get(occurrence, req.group_ids)

        if session.subject_id != req.subject_id:
            diagnostics.append(Diagnostic(code="SUBJECT_MISMATCH", message=f"Session {session.session_id} does not match its requirement subject.", related_ids=[session.session_id, req.id]))
        if session.session_type != req.session_type:
            diagnostics.append(Diagnostic(code="SESSION_TYPE_MISMATCH", message=f"Session {session.session_id} does not match its required session type.", related_ids=[session.session_id, req.id]))
        if set(session.group_ids) != set(expected_groups):
            diagnostics.append(Diagnostic(code="PARTICIPANT_MISMATCH", message=f"Session {session.session_id} does not include exactly its expected participant groups.", related_ids=[session.session_id]))
        for group_id in set(session.group_ids) | set(expected_groups):
            if group_id not in groups:
                diagnostics.append(Diagnostic(code="UNKNOWN_GROUP", message=f"Session {session.session_id} references unknown participant group {group_id}.", related_ids=[session.session_id, group_id]))

        day = days.get(session.day_id)
        if day is None or not day.enabled:
            diagnostics.append(Diagnostic(code="INVALID_DAY", message=f"Session {session.session_id} uses an unavailable day.", related_ids=[session.session_id]))
            continue
        if session.start_period_index < 0 or session.end_period_index >= len(day.periods) or session.end_period_index < session.start_period_index:
            diagnostics.append(Diagnostic(code="INVALID_INTERVAL", message=f"Session {session.session_id} does not fit configured periods.", related_ids=[session.session_id]))
            continue

        covered = day.periods[session.start_period_index:session.end_period_index + 1]
        daily_requirement_key = (req.id, day.id)
        requirement_daily_counts[daily_requirement_key] = requirement_daily_counts.get(daily_requirement_key, 0) + 1
        period_ids = {period.id for period in covered}
        duration = sum(period.end_minute - period.start_minute for period in covered)
        if session.start_minute != covered[0].start_minute or session.end_minute != covered[-1].end_minute:
            diagnostics.append(Diagnostic(code="PERIOD_BOUNDARY_MISMATCH", message=f"Session {session.session_id} does not use the exact configured period boundaries.", related_ids=[session.session_id]))
        if any(period.blocked for period in covered):
            diagnostics.append(Diagnostic(code="BLOCKED_PERIOD", message=f"Session {session.session_id} occupies a blocked period.", related_ids=[session.session_id]))
        if any(day.periods[index].break_after for index in range(session.start_period_index, session.end_period_index)):
            diagnostics.append(Diagnostic(code="CROSSES_BREAK", message=f"Session {session.session_id} crosses a configured break.", related_ids=[session.session_id]))
        if any(day.periods[index].end_minute != day.periods[index + 1].start_minute for index in range(session.start_period_index, session.end_period_index)):
            diagnostics.append(Diagnostic(code="NONCONTIGUOUS_PERIODS", message=f"Session {session.session_id} crosses a gap between configured periods.", related_ids=[session.session_id]))
        if duration < req.duration_minutes:
            diagnostics.append(Diagnostic(code="SHORT_DURATION", message=f"Session {session.session_id} is shorter than its required duration.", related_ids=[session.session_id]))
        if day.working_start_minute is not None and session.start_minute < day.working_start_minute:
            diagnostics.append(Diagnostic(code="OUTSIDE_WORKING_HOURS", message=f"Session {session.session_id} starts before the configured working day.", related_ids=[session.session_id]))
        if day.working_end_minute is not None and session.end_minute > day.working_end_minute:
            diagnostics.append(Diagnostic(code="OUTSIDE_WORKING_HOURS", message=f"Session {session.session_id} ends after the configured working day.", related_ids=[session.session_id]))

        if session.faculty_id not in req.faculty_ids:
            diagnostics.append(Diagnostic(code="INELIGIBLE_FACULTY", message=f"Faculty {session.faculty_id} is not assigned to requirement {req.id}.", related_ids=[session.session_id, session.faculty_id]))
        member = faculty.get(session.faculty_id)
        if member is None:
            diagnostics.append(Diagnostic(code="UNKNOWN_FACULTY", message=f"Session {session.session_id} references unknown faculty.", related_ids=[session.session_id, session.faculty_id]))
        else:
            if req.subject_id not in member.eligible_subject_ids:
                diagnostics.append(Diagnostic(code="FACULTY_SUBJECT_INELIGIBLE", message=f"Faculty {session.faculty_id} is not eligible for subject {req.subject_id}.", related_ids=[session.session_id, session.faculty_id, req.subject_id]))
            if period_ids & set(member.unavailable_slot_ids) or (member.available_slot_ids is not None and not period_ids <= set(member.available_slot_ids)):
                diagnostics.append(Diagnostic(code="FACULTY_UNAVAILABLE", message=f"Faculty {session.faculty_id} is unavailable for {session.session_id}.", related_ids=[session.session_id, session.faculty_id]))
            faculty_minutes[member.id] = faculty_minutes.get(member.id, 0) + req.duration_minutes
            daily_key = (member.id, day.id)
            faculty_daily_minutes[daily_key] = faculty_daily_minutes.get(daily_key, 0) + req.duration_minutes
            faculty_occupied.setdefault(daily_key, set()).update(range(session.start_period_index, session.end_period_index + 1))

        room = rooms.get(session.room_id)
        if room is None:
            diagnostics.append(Diagnostic(code="UNKNOWN_ROOM", message=f"Session {session.session_id} references unknown room.", related_ids=[session.session_id]))
        else:
            required_capacity = max(req.min_room_capacity or 0, _required_group_capacity(expected_groups, groups))
            if room.capacity < required_capacity:
                diagnostics.append(Diagnostic(code="ROOM_CAPACITY", message=f"Room {room.id} does not meet the {required_capacity}-seat requirement for {session.session_id}.", related_ids=[session.session_id, room.id]))
            missing = set(req.room_facilities) - set(room.facilities)
            if missing:
                diagnostics.append(Diagnostic(code="ROOM_FACILITY", message=f"Room {room.id} lacks facilities {sorted(missing)}.", related_ids=[session.session_id, room.id]))
            if period_ids & set(room.unavailable_slot_ids) or (room.available_slot_ids is not None and not period_ids <= set(room.available_slot_ids)):
                diagnostics.append(Diagnostic(code="ROOM_UNAVAILABLE", message=f"Room {room.id} is unavailable for {session.session_id}.", related_ids=[session.session_id, room.id]))

        for fixed in request.fixed_sessions:
            if fixed.session_id == session.session_id and (fixed.day_id, fixed.start_period_index, fixed.room_id, fixed.faculty_id) != (session.day_id, session.start_period_index, session.room_id, session.faculty_id):
                diagnostics.append(Diagnostic(code="LOCK_MOVED", message=f"Locked session {session.session_id} was moved.", related_ids=[session.session_id]))

    for req_id, count in expected.items():
        if actual.get(req_id, 0) != count:
            diagnostics.append(Diagnostic(code="WEEKLY_INCOMPLETE", message=f"Requirement {req_id} has {actual.get(req_id, 0)} of {count} weekly sessions.", related_ids=[req_id]))
        missing_occurrences = set(range(1, count + 1)) - occurrences.get(req_id, set())
        if missing_occurrences:
            diagnostics.append(Diagnostic(code="MISSING_OCCURRENCE", message=f"Requirement {req_id} is missing weekly occurrences {sorted(missing_occurrences)}.", related_ids=[req_id]))
    for req in request.requirements:
        if req.daily_limit is not None:
            for day in request.days:
                if requirement_daily_counts.get((req.id, day.id), 0) > req.daily_limit:
                    diagnostics.append(Diagnostic(code="SUBJECT_DAILY_LIMIT", message=f"Requirement {req.id} exceeds its daily session limit on {day.label}.", related_ids=[req.id, day.id]))

    for member in request.faculty:
        if member.max_weekly_minutes is not None and faculty_minutes.get(member.id, 0) > member.max_weekly_minutes:
            diagnostics.append(Diagnostic(code="FACULTY_WEEKLY_LOAD", message=f"Faculty {member.id} exceeds the weekly teaching limit.", related_ids=[member.id]))
        for (faculty_id, day_id), minutes in faculty_daily_minutes.items():
            if faculty_id == member.id and member.max_daily_minutes is not None and minutes > member.max_daily_minutes:
                diagnostics.append(Diagnostic(code="FACULTY_DAILY_LOAD", message=f"Faculty {member.id} exceeds the daily teaching limit on {day_id}.", related_ids=[member.id, day_id]))
        if member.max_consecutive_periods is not None:
            for day in request.days:
                occupied = faculty_occupied.get((member.id, day.id), set())
                run = 0
                violation = False
                for index, period in enumerate(day.periods):
                    if period.blocked or (index > 0 and day.periods[index - 1].break_after):
                        run = 0
                    if index in occupied:
                        run += 1
                        if run > member.max_consecutive_periods:
                            violation = True
                    else:
                        run = 0
                if violation:
                    diagnostics.append(Diagnostic(code="FACULTY_CONSECUTIVE_LOAD", message=f"Faculty {member.id} exceeds the consecutive-period limit on {day.label}.", related_ids=[member.id, day.id]))

    for index, first in enumerate(sessions):
        for second in sessions[index + 1:]:
            if _overlap(first, second):
                if first.room_id == second.room_id:
                    diagnostics.append(Diagnostic(code="ROOM_CONFLICT", message=f"Room {first.room_id} overlaps {first.session_id} and {second.session_id}.", related_ids=[first.session_id, second.session_id]))
                if first.faculty_id == second.faculty_id:
                    diagnostics.append(Diagnostic(code="FACULTY_CONFLICT", message=f"Faculty {first.faculty_id} overlaps {first.session_id} and {second.session_id}.", related_ids=[first.session_id, second.session_id]))
                if _group_conflict(first, second, request):
                    diagnostics.append(Diagnostic(code="PARTICIPANT_CONFLICT", message=f"Participant groups overlap {first.session_id} and {second.session_id}.", related_ids=[first.session_id, second.session_id]))

    return ValidationReport(valid=not diagnostics, diagnostics=diagnostics)
