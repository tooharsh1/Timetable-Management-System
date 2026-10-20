import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))

from app.schemas import (Day, Faculty, FixedSession, ParticipantGroup, Period, Requirement, Room,
                         ScheduleRequest, SessionType, Outcome, ScheduledSession)
from engine.solver import solve
from engine.validator import validate_schedule


def base_request(**kwargs):
    days = [Day(id="mon", label="Monday", periods=[Period(id="p1", label="09", start_minute=540, end_minute=590), Period(id="p2", label="10", start_minute=590, end_minute=640), Period(id="p3", label="11", start_minute=640, end_minute=690)])]
    groups = [ParticipantGroup(id="g1", name="A", size=30)]
    faculty = [Faculty(id="f1", name="Teacher", initials="T", eligible_subject_ids=["s1"])]
    rooms = [Room(id="r1", name="R1", capacity=40)]
    requirements = [Requirement(id="req1", subject_id="s1", subject_name="Algorithms", sessions_per_week=1, duration_minutes=100, faculty_ids=["f1"], group_ids=["g1"])]
    data = dict(days=days, groups=groups, faculty=faculty, rooms=rooms, requirements=requirements)
    data.update(kwargs)
    return ScheduleRequest.model_validate(data)


def test_multi_period_lab_is_complete_and_validated():
    req = base_request(requirements=[Requirement(id="lab", subject_id="s1", subject_name="Lab", session_type=SessionType.LAB, sessions_per_week=1, duration_minutes=100, faculty_ids=["f1"], group_ids=["g1"])])
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    assert result.sessions[0].end_period_index > result.sessions[0].start_period_index
    assert validate_schedule(req, result.sessions).valid


def test_faculty_conflict_is_hard():
    req = base_request(requirements=[
        Requirement(id="a", subject_id="s1", subject_name="A", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["g1"]),
        Requirement(id="b", subject_id="s2", subject_name="B", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["g1"]),
    ], faculty=[Faculty(id="f1", name="Teacher", initials="T", eligible_subject_ids=["s1", "s2"])])
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    assert len(result.sessions) == 2
    assert result.sessions[0].start_period_index != result.sessions[1].start_period_index


def test_empty_faculty_eligibility_is_not_treated_as_unrestricted():
    req = base_request(faculty=[Faculty(id="f1", name="Teacher", initials="T", eligible_subject_ids=[])])
    result = solve(req)
    assert result.outcome == Outcome.INFEASIBLE
    assert result.sessions == []


def test_faculty_max_consecutive_periods_is_obeyed():
    req = base_request(
        faculty=[Faculty(id="f1", name="Teacher", initials="T", eligible_subject_ids=["s1", "s2"], max_consecutive_periods=1)],
        requirements=[
            Requirement(id="a", subject_id="s1", subject_name="A", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["g1"]),
            Requirement(id="b", subject_id="s2", subject_name="B", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["g1"]),
        ],
    )
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    assert sorted(session.start_period_index for session in result.sessions) == [0, 2]


def test_faculty_max_consecutive_periods_rejects_long_lab():
    req = base_request(
        faculty=[Faculty(id="f1", name="Teacher", initials="T", eligible_subject_ids=["s1"], max_consecutive_periods=1)],
        requirements=[Requirement(id="lab", subject_id="s1", subject_name="Lab", session_type=SessionType.LAB, sessions_per_week=1, duration_minutes=100, faculty_ids=["f1"], group_ids=["g1"])],
    )
    result = solve(req)
    assert result.outcome == Outcome.INFEASIBLE


def test_lock_is_preserved():
    fixed = FixedSession(session_id="req1__1", requirement_id="req1", day_id="mon", start_period_index=0, room_id="r1", faculty_id="f1")
    result = solve(base_request(fixed_sessions=[fixed]))
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    s = result.sessions[0]
    assert (s.day_id, s.start_period_index, s.room_id, s.faculty_id) == ("mon", 0, "r1", "f1")
    assert s.locked


def test_infeasible_has_no_partial_success():
    req = base_request(rooms=[Room(id="r1", name="R1", capacity=10)], requirements=[Requirement(id="req1", subject_id="s1", subject_name="Algorithms", sessions_per_week=1, duration_minutes=100, faculty_ids=["f1"], group_ids=["g1"], min_room_capacity=20)])
    result = solve(req)
    assert result.outcome == Outcome.INFEASIBLE
    assert result.sessions == []


def test_validator_detects_duplicate_room():
    req = base_request(requirements=[
        Requirement(id="a", subject_id="s1", subject_name="A", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["g1"]),
        Requirement(id="b", subject_id="s2", subject_name="B", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["g1"]),
    ], faculty=[Faculty(id="f1", name="Teacher", initials="T", eligible_subject_ids=["s1", "s2"])])
    s = [ScheduledSession(session_id="a__1", requirement_id="a", subject_id="s1", subject_name="A", session_type=SessionType.THEORY, day_id="mon", day_label="Monday", start_period_index=0, end_period_index=0, start_minute=540, end_minute=590, room_id="r1", faculty_id="f1", group_ids=["g1"]), ScheduledSession(session_id="b__1", requirement_id="b", subject_id="s2", subject_name="B", session_type=SessionType.THEORY, day_id="mon", day_label="Monday", start_period_index=0, end_period_index=0, start_minute=540, end_minute=590, room_id="r1", faculty_id="f1", group_ids=["g1"])]
    report = validate_schedule(req, s)
    assert not report.valid
    assert {d.code for d in report.diagnostics} >= {"ROOM_CONFLICT", "FACULTY_CONFLICT", "PARTICIPANT_CONFLICT"}


def test_independent_validator_rejects_blocked_mismatched_and_overloaded_session():
    req = base_request(
        days=[Day(id="mon", label="Monday", periods=[Period(id="p1", label="09", start_minute=540, end_minute=590, blocked=True), Period(id="p2", label="10", start_minute=590, end_minute=640)], working_start_minute=550, working_end_minute=630)],
        faculty=[Faculty(id="f1", name="Teacher", initials="T", eligible_subject_ids=[], max_weekly_minutes=50, max_daily_minutes=50, max_consecutive_periods=1)],
        rooms=[Room(id="r1", name="Small room", capacity=20)],
        fixed_sessions=[FixedSession(session_id="req1__1", requirement_id="req1", day_id="mon", start_period_index=1, room_id="r1", faculty_id="f1")],
    )
    session = ScheduledSession(session_id="req1__1", requirement_id="req1", subject_id="wrong-subject", subject_name="Algorithms", session_type=SessionType.TUTORIAL, day_id="mon", day_label="Monday", start_period_index=0, end_period_index=1, start_minute=539, end_minute=639, room_id="r1", faculty_id="f1", group_ids=["unknown-group"])
    report = validate_schedule(req, [session])
    codes = {diagnostic.code for diagnostic in report.diagnostics}
    assert codes >= {"BLOCKED_PERIOD", "PERIOD_BOUNDARY_MISMATCH", "OUTSIDE_WORKING_HOURS", "FACULTY_SUBJECT_INELIGIBLE", "FACULTY_WEEKLY_LOAD", "FACULTY_DAILY_LOAD", "FACULTY_CONSECUTIVE_LOAD", "ROOM_CAPACITY", "SUBJECT_MISMATCH", "SESSION_TYPE_MISMATCH", "PARTICIPANT_MISMATCH", "UNKNOWN_GROUP", "LOCK_MOVED"}


def test_combined_lecture_is_one_session_for_all_divisions():
    req = base_request(
        groups=[ParticipantGroup(id="divA", name="Division A", size=30), ParticipantGroup(id="divB", name="Division B", size=30)],
        rooms=[Room(id="r1", name="Combined lecture hall", capacity=80)],
        requirements=[Requirement(id="combined", subject_id="s1", subject_name="Combined lecture", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["divA", "divB"])],
    )
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    assert len(result.sessions) == 1
    assert set(result.sessions[0].group_ids) == {"divA", "divB"}
    assert validate_schedule(req, result.sessions).valid


def test_combined_group_size_is_enforced_without_explicit_minimum_capacity():
    req = base_request(
        groups=[ParticipantGroup(id="divA", name="Division A", size=30), ParticipantGroup(id="divB", name="Division B", size=30)],
        rooms=[Room(id="r1", name="Small hall", capacity=40)],
        requirements=[Requirement(id="combined", subject_id="s1", subject_name="Combined lecture", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["divA", "divB"])],
    )
    result = solve(req)
    assert result.outcome == Outcome.INFEASIBLE
    assert result.sessions == []


def test_parallel_practicals_for_sibling_batches_are_allowed():
    req = base_request(
        groups=[
            ParticipantGroup(id="division", name="Division A", size=60, overlapping_group_ids=["batch1", "batch2"]),
            ParticipantGroup(id="batch1", name="Batch A1", size=30, overlapping_group_ids=["division"]),
            ParticipantGroup(id="batch2", name="Batch A2", size=30, overlapping_group_ids=["division"]),
        ],
        faculty=[Faculty(id="f1", name="Teacher 1", initials="T1", eligible_subject_ids=["s1"]), Faculty(id="f2", name="Teacher 2", initials="T2", eligible_subject_ids=["s2"])],
        rooms=[Room(id="r1", name="Lab 1", capacity=30, room_type="Laboratory"), Room(id="r2", name="Lab 2", capacity=30, room_type="Laboratory")],
        requirements=[
            Requirement(id="lab1", subject_id="s1", subject_name="Lab A1", session_type=SessionType.LAB, sessions_per_week=1, duration_minutes=100, faculty_ids=["f1"], group_ids=["batch1"], min_room_capacity=30),
            Requirement(id="lab2", subject_id="s2", subject_name="Lab A2", session_type=SessionType.LAB, sessions_per_week=1, duration_minutes=100, faculty_ids=["f2"], group_ids=["batch2"], min_room_capacity=30),
        ],
    )
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    assert len(result.sessions) == 2
    assert result.sessions[0].start_period_index == result.sessions[1].start_period_index
    assert result.sessions[0].faculty_id != result.sessions[1].faculty_id
    assert result.sessions[0].room_id != result.sessions[1].room_id
    assert validate_schedule(req, result.sessions).valid


def test_combined_class_lecture_cannot_overlap_attended_batch_lab():
    req = base_request(
        groups=[
            ParticipantGroup(id="whole", name="Whole class", size=60, overlapping_group_ids=["divA", "divB", "batchA1", "batchA2"]),
            ParticipantGroup(id="divA", name="Division A", size=30, overlapping_group_ids=["batchA1", "batchA2"]),
            ParticipantGroup(id="divB", name="Division B", size=30),
            ParticipantGroup(id="batchA1", name="Batch A1", size=15, overlapping_group_ids=["whole", "divA"]),
            ParticipantGroup(id="batchA2", name="Batch A2", size=15, overlapping_group_ids=["whole", "divA"]),
        ],
        faculty=[Faculty(id="f1", name="Teacher 1", initials="T1", eligible_subject_ids=["s1"]), Faculty(id="f2", name="Teacher 2", initials="T2", eligible_subject_ids=["s2"])],
        rooms=[Room(id="r1", name="Lecture Hall", capacity=70), Room(id="r2", name="Lab", capacity=20, room_type="Laboratory")],
        requirements=[
            Requirement(id="lecture", subject_id="s1", subject_name="Whole-class lecture", sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["whole"]),
            Requirement(id="lab", subject_id="s2", subject_name="Batch lab", session_type=SessionType.LAB, sessions_per_week=1, duration_minutes=100, faculty_ids=["f2"], group_ids=["batchA1"], min_room_capacity=15),
        ],
    )
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    lecture = next(session for session in result.sessions if session.requirement_id == "lecture")
    lab = next(session for session in result.sessions if session.requirement_id == "lab")
    assert lecture.end_period_index < lab.start_period_index or lab.end_period_index < lecture.start_period_index
    assert validate_schedule(req, result.sessions).valid


def test_open_electives_in_same_conflict_group_are_not_parallel():
    req = base_request(
        groups=[ParticipantGroup(id="oe1", name="Applied AI", size=30), ParticipantGroup(id="oe2", name="Cybersecurity", size=30)],
        faculty=[Faculty(id="f1", name="Teacher 1", initials="T1", eligible_subject_ids=["s1"]), Faculty(id="f2", name="Teacher 2", initials="T2", eligible_subject_ids=["s2"])],
        rooms=[Room(id="r1", name="Seminar 1", capacity=40), Room(id="r2", name="Seminar 2", capacity=40)],
        requirements=[
            Requirement(id="oe1", subject_id="s1", subject_name="Applied AI", session_type=SessionType.ELECTIVE, sessions_per_week=1, duration_minutes=50, faculty_ids=["f1"], group_ids=["oe1"], conflict_group_ids=["OPEN-ELECTIVE"]),
            Requirement(id="oe2", subject_id="s2", subject_name="Cybersecurity", session_type=SessionType.ELECTIVE, sessions_per_week=1, duration_minutes=50, faculty_ids=["f2"], group_ids=["oe2"], conflict_group_ids=["OPEN-ELECTIVE"]),
        ],
    )
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    assert len(result.sessions) == 2
    assert result.sessions[0].start_period_index != result.sessions[1].start_period_index
    assert validate_schedule(req, result.sessions).valid


def test_group_repair_override_changes_only_the_selected_occurrence():
    req = base_request(
        groups=[ParticipantGroup(id="g1", name="Division A", size=30), ParticipantGroup(id="g2", name="Division B", size=30)],
        requirements=[Requirement(id="weekly", subject_id="s1", subject_name="Weekly lecture", sessions_per_week=2, duration_minutes=50, faculty_ids=["f1"], group_ids=["g1"], group_ids_by_occurrence={1: ["g2"]})],
    )
    result = solve(req)
    assert result.outcome in (Outcome.FEASIBLE, Outcome.OPTIMAL)
    sessions = {session.session_id: session for session in result.sessions}
    assert set(sessions["weekly__1"].group_ids) == {"g2"}
    assert set(sessions["weekly__2"].group_ids) == {"g1"}
    assert validate_schedule(req, result.sessions).valid
