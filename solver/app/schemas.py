from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional
from pydantic import BaseModel, Field, ConfigDict, model_validator


class Outcome(str, Enum):
    FEASIBLE = "FEASIBLE"
    OPTIMAL = "OPTIMAL"
    INFEASIBLE = "INFEASIBLE"
    TIME_LIMIT_NO_SOLUTION = "TIME_LIMIT_NO_SOLUTION"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    EXECUTION_ERROR = "EXECUTION_ERROR"


class SessionType(str, Enum):
    THEORY = "theory"
    TUTORIAL = "tutorial"
    LAB = "lab"
    ELECTIVE = "elective"


class TimeSlot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    day: str
    start_minute: int = Field(ge=0, le=24 * 60)
    end_minute: int = Field(gt=0, le=24 * 60)
    period_index: int = Field(ge=0)
    is_break: bool = False
    blocked: bool = False

    @model_validator(mode="after")
    def valid_interval(self):
        if self.end_minute <= self.start_minute:
            raise ValueError("time slot end must be after start")
        return self


class Period(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    label: str
    start_minute: int = Field(ge=0, le=24 * 60)
    end_minute: int = Field(gt=0, le=24 * 60)
    break_after: bool = False
    blocked: bool = False

    @model_validator(mode="after")
    def valid_interval(self):
        if self.end_minute <= self.start_minute:
            raise ValueError("period end must be after start")
        return self


class Day(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    label: str
    enabled: bool = True
    periods: List[Period] = Field(default_factory=list)
    working_start_minute: Optional[int] = Field(default=None, ge=0, le=24 * 60)
    working_end_minute: Optional[int] = Field(default=None, gt=0, le=24 * 60)

    @model_validator(mode="after")
    def valid_working_window(self):
        if self.working_start_minute is not None and self.working_end_minute is not None and self.working_end_minute <= self.working_start_minute:
            raise ValueError("working window end must be after start")
        return self


class ParticipantGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    size: int = Field(gt=0)
    conflict_group_ids: List[str] = Field(default_factory=list)
    participant_ids: List[str] = Field(default_factory=list)
    overlapping_group_ids: List[str] = Field(default_factory=list)


class Faculty(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    initials: str
    eligible_subject_ids: List[str] = Field(default_factory=list)
    available_slot_ids: Optional[List[str]] = None
    unavailable_slot_ids: List[str] = Field(default_factory=list)
    max_weekly_minutes: Optional[int] = Field(default=None, gt=0)
    max_daily_minutes: Optional[int] = Field(default=None, gt=0)
    max_consecutive_periods: Optional[int] = Field(default=None, gt=0)
    preferred_slot_ids: List[str] = Field(default_factory=list)


class Room(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    name: str
    capacity: int = Field(gt=0)
    room_type: str = ""
    facilities: List[str] = Field(default_factory=list)
    available_slot_ids: Optional[List[str]] = None
    unavailable_slot_ids: List[str] = Field(default_factory=list)


class Requirement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    subject_id: str
    subject_name: str
    subject_code: str = ""
    session_type: SessionType = SessionType.THEORY
    sessions_per_week: int = Field(gt=0)
    duration_minutes: int = Field(gt=0)
    faculty_ids: List[str] = Field(min_length=1)
    group_ids: List[str] = Field(min_length=1)
    group_ids_by_occurrence: Dict[int, List[str]] = Field(default_factory=dict)
    room_facilities: List[str] = Field(default_factory=list)
    min_room_capacity: Optional[int] = Field(default=None, gt=0)
    preferred_room_ids: List[str] = Field(default_factory=list)
    conflict_group_ids: List[str] = Field(default_factory=list)
    spread: bool = True
    daily_limit: Optional[int] = Field(default=None, gt=0)

    @model_validator(mode="after")
    def valid_group_overrides(self):
        if any(index < 1 or index > self.sessions_per_week for index in self.group_ids_by_occurrence):
            raise ValueError("group override occurrence must be within the weekly requirement")
        if any(not group_ids for group_ids in self.group_ids_by_occurrence.values()):
            raise ValueError("group override must include at least one participant group")
        return self


class FixedSession(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    requirement_id: str
    day_id: str
    start_period_index: int = Field(ge=0)
    room_id: str
    faculty_id: str
    locked: bool = True


class ObjectiveWeights(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject_spreading: int = Field(default=10, ge=0)
    daily_load_balance: int = Field(default=5, ge=0)
    student_gaps: int = Field(default=2, ge=0)
    faculty_gaps: int = Field(default=2, ge=0)
    room_changes: int = Field(default=1, ge=0)
    preferred_time: int = Field(default=3, ge=0)
    change_minimization: int = Field(default=8, ge=0)
    prefer_lab_blocks: int = Field(default=2, ge=0)


class GenerationOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    time_limit_seconds: float = Field(default=15.0, gt=0, le=300)
    workers: int = Field(default=8, ge=1, le=64)
    random_seed: int = 1
    objective_weights: ObjectiveWeights = Field(default_factory=ObjectiveWeights)
    repair_session_id: Optional[str] = None
    requested_placement: Optional[FixedSession] = None
    previous_placements: Dict[str, FixedSession] = Field(default_factory=dict)


class ScheduleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    days: List[Day] = Field(min_length=1)
    groups: List[ParticipantGroup] = Field(min_length=1)
    faculty: List[Faculty] = Field(default_factory=list)
    rooms: List[Room] = Field(min_length=1)
    requirements: List[Requirement] = Field(min_length=1)
    fixed_sessions: List[FixedSession] = Field(default_factory=list)
    options: GenerationOptions = Field(default_factory=GenerationOptions)


class ScheduledSession(BaseModel):
    session_id: str
    requirement_id: str
    subject_id: str
    subject_name: str
    session_type: SessionType
    day_id: str
    day_label: str
    start_period_index: int
    end_period_index: int
    start_minute: int
    end_minute: int
    room_id: str
    faculty_id: str
    group_ids: List[str]
    locked: bool = False


class Diagnostic(BaseModel):
    code: str
    message: str
    severity: str = "error"
    related_ids: List[str] = Field(default_factory=list)
    suggestion: Optional[str] = None


class ValidationReport(BaseModel):
    valid: bool
    diagnostics: List[Diagnostic] = Field(default_factory=list)


class ScheduleResponse(BaseModel):
    outcome: Outcome
    status_message: str
    sessions: List[ScheduledSession] = Field(default_factory=list)
    objective_value: Optional[float] = None
    diagnostics: List[Diagnostic] = Field(default_factory=list)
    validation: Optional[ValidationReport] = None
    solver_wall_time_seconds: Optional[float] = None


class ValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schedule: ScheduleRequest
    sessions: List[ScheduledSession]
