import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, any>;
type SolverInput = {
  days: Row[]; groups: Row[]; faculty: Row[]; rooms: Row[]; requirements: Row[];
  fixed_sessions: Row[]; options: Row;
};

const DAY_LABELS: Record<number, string> = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };
const SESSION_TYPES: Record<string, string> = { Lecture: "theory", Tutorial: "tutorial", Practical: "lab", Elective: "elective" };

function minute(value: string | null | undefined) {
  if (!value) return 0;
  const [hour, mins] = value.split(":").map(Number);
  return (hour || 0) * 60 + (mins || 0);
}
function overlap(startA: number, endA: number, startB: number, endB: number) {
  return startA < endB && startB < endA;
}
function groupRows<T extends Row>(rows: T[], key: string) {
  return rows.reduce<Record<string, T[]>>((result, row) => {
    const value = String(row[key]);
    (result[value] ??= []).push(row);
    return result;
  }, {});
}
async function rows(query: any): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

export type BuiltSchedule = {
  semesterId: string;
  baseVersionId: string | null;
  baseVersionRevision: number;
  baseVersionStatus: string | null;
  baseVersionUpdatedAt: string | null;
  sessionMap: Record<string, { requirementId: string; subjectId: string; sessionType: string; groupIds: string[] }>;
  request: SolverInput;
};

export async function buildScheduleInput(supabase: SupabaseClient): Promise<BuiltSchedule> {
  const semesters = await rows(supabase.from("semesters").select("id").eq("is_active", true).order("starts_on", { ascending: false }).limit(1));
  if (!semesters[0]) throw new Error("Choose an active semester before generating a timetable.");
  const semesterId = String(semesters[0].id);
  const { data: semesterTemplate, error: templateError } = await supabase.from("semester_timing_templates").select("timing_template_id,timing_templates!inner(institution_id,theory_duration_periods,tutorial_duration_periods,lab_duration_periods,max_daily_periods,max_consecutive_periods)").eq("semester_id", semesterId).maybeSingle();
  if (templateError) throw new Error(templateError.message);
  if (!semesterTemplate?.timing_template_id) throw new Error("Assign a timing template to the active semester before generation.");
  const templateId = String(semesterTemplate.timing_template_id);
  const templateConfig = Array.isArray(semesterTemplate.timing_templates) ? semesterTemplate.timing_templates[0] : semesterTemplate.timing_templates;

  const [periodRows, workingDays, breaks, blocked, groupData, requirementData, reqGroups, assignments, facultyData, eligibility, workload, facultyAvailability, facultyPreferences, roomData, roomFacilities, roomAvailability, electiveConflicts, enrolments, existingVersions, softRules] = await Promise.all([
    rows(supabase.from("timing_periods").select("id,sequence_no,label,starts_at,ends_at,kind").eq("timing_template_id", templateId).order("sequence_no")),
    rows(supabase.from("timing_working_days").select("day_of_week,is_working").eq("timing_template_id", templateId)),
    rows(supabase.from("timing_breaks").select("starts_at,ends_at,label").eq("timing_template_id", templateId)),
    rows(supabase.from("blocked_periods").select("day_of_week,starts_at,ends_at,reason").eq("semester_id", semesterId)),
    rows(supabase.from("student_groups").select("id,name,group_type,conflict_key,class_id,division_id,batch_id,divisions(capacity,class_id),batches(capacity,division_id)").eq("semester_id", semesterId)),
    rows(supabase.from("subject_requirements").select("id,subject_id,session_type,weekly_sessions,duration_periods,expected_size,subjects!inner(id,code,name,short_name)").eq("semester_id", semesterId)),
    rows(supabase.from("subject_requirement_groups").select("requirement_id,group_id,expected_enrolment")),
    rows(supabase.from("faculty_assignments").select("faculty_id,requirement_id,group_id")),
    rows(supabase.from("faculty").select("id,full_name,initials,active").eq("active", true)),
    rows(supabase.from("faculty_subject_eligibility").select("faculty_id,subject_id")),
    rows(supabase.from("faculty_workload_limits").select("faculty_id,max_weekly_periods,max_daily_periods,max_consecutive_periods").eq("semester_id", semesterId)),
    rows(supabase.from("faculty_availability").select("faculty_id,day_of_week,starts_at,ends_at,status,approval").eq("semester_id", semesterId).eq("approval", "Approved")),
    rows(supabase.from("faculty_preferences").select("faculty_id,day_of_week,starts_at,ends_at,weight").eq("semester_id", semesterId)),
    rows(supabase.from("rooms").select("id,name,capacity,room_type,is_active").eq("is_active", true)),
    rows(supabase.from("room_facilities").select("room_id,facility_id,facilities!inner(code)")),
    rows(supabase.from("room_availability").select("room_id,day_of_week,starts_at,ends_at,status").eq("semester_id", semesterId)),
    rows(supabase.from("elective_conflicts").select("group_id,conflict_group").eq("semester_id", semesterId)),
    rows(supabase.from("student_enrolments").select("group_id,student_record_id")),
    rows(supabase.from("timetable_versions").select("id,revision,status,updated_at").eq("semester_id", semesterId).in("status", ["Draft", "Under Review", "Published"]).order("revision", { ascending: false }).limit(1)),
    rows(supabase.from("scheduling_rules").select("code,weight,is_active,hard_constraint").eq("institution_id", String(templateConfig?.institution_id ?? "")).eq("hard_constraint", false)),
  ]);
  if (!periodRows.length) throw new Error("Add individual teaching periods to the active timing template.");
  if (!workingDays.length) throw new Error("Configure working days in the active timing template.");
  if (!requirementData.length) throw new Error("Add weekly subject requirements before generation.");
  if (!groupData.length || !facultyData.length || !roomData.length) throw new Error("Add student groups, eligible faculty, and rooms before generation.");

  const workingByDay = new Map(workingDays.map((row) => [Number(row.day_of_week), Boolean(row.is_working)]));
  const periodMins = periodRows.filter((row) => row.kind !== "Break").map((row) => minute(row.ends_at) - minute(row.starts_at));
  const averagePeriodMinutes = Math.max(1, Math.round(periodMins.reduce((sum, item) => sum + item, 0) / Math.max(1, periodMins.length)));
  const dayIds = Object.keys(DAY_LABELS).map(Number);
  const days = dayIds.map((dayNo) => {
    const periods = periodRows.map((period) => {
      const start = minute(period.starts_at); const end = minute(period.ends_at);
      const next = periodRows.find((candidate) => Number(candidate.sequence_no) === Number(period.sequence_no) + 1);
      const breakAfter = Boolean(next && breaks.some((item) => overlap(end, minute(String(next.starts_at)), minute(item.starts_at), minute(item.ends_at))));
      const isBreakPeriod = period.kind === "Break";
      const isBlocked = blocked.some((item) => Number(item.day_of_week) === dayNo && overlap(start, end, minute(item.starts_at), minute(item.ends_at)));
      const crossesBreak = breaks.some((item) => overlap(start, end, minute(item.starts_at), minute(item.ends_at)));
      return { id: `${dayNo}:${period.id}`, label: String(period.label), start_minute: start, end_minute: end, break_after: breakAfter, blocked: isBreakPeriod || isBlocked || crossesBreak };
    });
    return { id: String(dayNo), label: DAY_LABELS[dayNo], enabled: workingByDay.get(dayNo) ?? false, periods, working_start_minute: Math.min(...periods.map((p) => p.start_minute)), working_end_minute: Math.max(...periods.map((p) => p.end_minute)) };
  });
  const periodsByDay = new Map(days.map((day) => [Number(day.id), day.periods]));
  const slotIdsFor = (dayNo: number, startAt: string, endAt: string) => (periodsByDay.get(dayNo) ?? []).filter((p) => p.start_minute >= minute(startAt) && p.end_minute <= minute(endAt) && !p.blocked).map((p) => p.id);

  const enrolmentsByGroup = groupRows(enrolments, "group_id");
  const relation = (value: any): Row => Array.isArray(value) ? value[0] ?? {} : value ?? {};
  const divisionClassById = new Map(groupData.filter((item) => item.division_id).map((item) => [String(item.division_id), String(relation(item.divisions).class_id ?? item.class_id ?? "")]));
  const groupScope = (item: Row) => {
    const division = relation(item.divisions);
    const batch = relation(item.batches);
    const divisionId = String(item.division_id ?? batch.division_id ?? "");
    const classId = String(item.class_id ?? division.class_id ?? divisionClassById.get(divisionId) ?? "");
    return { divisionId, classId };
  };
  const expectedSizeByGroup = new Map<string, number>();
  for (const row of reqGroups) {
    if (row.expected_enrolment) expectedSizeByGroup.set(String(row.group_id), Number(row.expected_enrolment));
  }
  const conflictByGroup = groupRows(electiveConflicts, "group_id");
  const reqGroupRows = groupRows(reqGroups, "requirement_id");
  const assignmentByRequirement = groupRows(assignments, "requirement_id");
  const eligibilityBySubject = groupRows(eligibility, "subject_id");
  const workloadByFaculty = new Map(workload.map((item) => [String(item.faculty_id), item]));
  const ruleByCode = new Map(softRules.map((rule) => [String(rule.code), rule]));
  const ruleWeight = (code: string, fallback: number) => { const rule = ruleByCode.get(code); return rule ? (rule.is_active ? Math.max(0, Math.round(Number(rule.weight) / 10)) : 0) : fallback; };
  const availabilityByFaculty = groupRows(facultyAvailability, "faculty_id");
  const preferencesByFaculty = groupRows(facultyPreferences, "faculty_id");
  const facilitiesByRoom = groupRows(roomFacilities, "room_id");
  const availabilityByRoom = groupRows(roomAvailability, "room_id");
  const allSlotIds = days.flatMap((day) => day.periods.map((period) => period.id));

  const groups = groupData.map((group) => {
    const enrolled = enrolmentsByGroup[String(group.id)] ?? [];
    const conflictIds = new Set<string>();
    if (group.conflict_key) conflictIds.add(String(group.conflict_key));
    for (const row of conflictByGroup[String(group.id)] ?? []) conflictIds.add(String(row.conflict_group));
    const division = Array.isArray(group.divisions) ? group.divisions[0] : group.divisions;
    const batch = Array.isArray(group.batches) ? group.batches[0] : group.batches;
    const capacity = Number(division?.capacity ?? batch?.capacity ?? 0);
    const scope = groupScope(group);
    const overlappingGroupIds = groupData.filter((other) => {
      if (String(other.id) === String(group.id)) return false;
      const otherScope = groupScope(other);
      if (group.group_type === "Class") return Boolean(scope.classId && otherScope.classId === scope.classId);
      if (group.group_type === "Division") return other.group_type === "Batch" && Boolean(scope.divisionId && otherScope.divisionId === scope.divisionId);
      if (group.group_type === "Batch") return (other.group_type === "Division" && Boolean(scope.divisionId && otherScope.divisionId === scope.divisionId)) || (other.group_type === "Class" && Boolean(scope.classId && otherScope.classId === scope.classId));
      return false;
    }).map((item) => String(item.id));
    return { id: String(group.id), name: String(group.name), size: Math.max(1, enrolled.length || expectedSizeByGroup.get(String(group.id)) || capacity || 1), conflict_group_ids: [...conflictIds], participant_ids: enrolled.map((item) => String(item.student_record_id)), overlapping_group_ids: overlappingGroupIds };
  });
  const groupSize = new Map(groups.map((group) => [group.id, group.size]));

  const faculty = facultyData.map((person) => {
    const workloadLimit = workloadByFaculty.get(String(person.id));
    const records = availabilityByFaculty[String(person.id)] ?? [];
    const allowedRows = records.filter((item) => item.status === "Available");
    const deniedRows = records.filter((item) => item.status === "Unavailable");
    const preferredRows = [...records.filter((item) => item.status === "Preferred"), ...(preferencesByFaculty[String(person.id)] ?? [])];
    const idsFromRows = (selected: Row[]) => selected.flatMap((item) => slotIdsFor(Number(item.day_of_week), String(item.starts_at), String(item.ends_at)));
    const eligibleSubjects = eligibility.filter((item) => String(item.faculty_id) === String(person.id)).map((item) => String(item.subject_id));
    return {
      id: String(person.id), name: String(person.full_name), initials: String(person.initials), eligible_subject_ids: eligibleSubjects,
      available_slot_ids: allowedRows.length ? idsFromRows(allowedRows) : null,
      unavailable_slot_ids: idsFromRows(deniedRows), preferred_slot_ids: idsFromRows(preferredRows),
      max_weekly_minutes: workloadLimit ? Number(workloadLimit.max_weekly_periods) * averagePeriodMinutes : null,
      max_daily_minutes: workloadLimit ? Number(workloadLimit.max_daily_periods) * averagePeriodMinutes : Number(templateConfig?.max_daily_periods ?? 6) * averagePeriodMinutes,
      max_consecutive_periods: Number(workloadLimit?.max_consecutive_periods ?? templateConfig?.max_consecutive_periods ?? 3),
    };
  });
  const rooms = roomData.map((room) => {
    const facilities = (facilitiesByRoom[String(room.id)] ?? []).map((item) => String(item.facilities?.code ?? "")).filter(Boolean);
    const records = availabilityByRoom[String(room.id)] ?? [];
    const allowedRows = records.filter((item) => item.status === "Available");
    const deniedRows = records.filter((item) => item.status === "Unavailable");
    const idsFromRows = (selected: Row[]) => selected.flatMap((item) => slotIdsFor(Number(item.day_of_week), String(item.starts_at), String(item.ends_at)));
    return { id: String(room.id), name: String(room.name), room_type: String(room.room_type ?? ""), capacity: Number(room.capacity), facilities, available_slot_ids: allowedRows.length ? idsFromRows(allowedRows) : null, unavailable_slot_ids: idsFromRows(deniedRows) };
  });
  const sessionMap: BuiltSchedule["sessionMap"] = {};
  const requirements: Row[] = [];
  for (const item of requirementData) {
    const subject = Array.isArray(item.subjects) ? item.subjects[0] : item.subjects;
    const groupsForRequirement = reqGroupRows[String(item.id)] ?? [];
    const allGroupIds = groupsForRequirement.map((row) => String(row.group_id));
    const assignmentRows = assignmentByRequirement[String(item.id)] ?? [];
    const eligibleSubject = eligibilityBySubject[String(item.subject_id)] ?? [];
    const facilityRows = await rows(supabase.from("subject_requirement_facilities").select("facilities!inner(code)").eq("requirement_id", String(item.id)));
    const facilityCodes = facilityRows.map((row) => String(row.facilities?.code ?? "")).filter(Boolean);
    const isPractical = item.session_type === "Practical";
    const scopes = isPractical ? groupsForRequirement.map((row) => [String(row.group_id)]) : [allGroupIds];
    for (const scope of scopes) {
      if (!scope.length) continue;
      const groupSpecific = assignmentRows.filter((entry) => scope.includes(String(entry.group_id))).map((entry) => String(entry.faculty_id));
      let facultyIds = [...new Set(groupSpecific)];
      if (!facultyIds.length) facultyIds = [...new Set(eligibleSubject.map((entry) => String(entry.faculty_id)))];
      if (scope.length > 1 && groupSpecific.length) {
        const assignedByGroup = scope.map((id) => new Set(assignmentRows.filter((entry) => String(entry.group_id) === id).map((entry) => String(entry.faculty_id))));
        facultyIds = [...assignedByGroup.reduce((shared, current) => new Set([...shared].filter((value) => current.has(value))), assignedByGroup[0] ?? new Set<string>())];
      }
      if (!facultyIds.length) throw new Error(`No eligible faculty is assigned to ${subject?.code ?? item.subject_id}.`);
      const key = isPractical ? `${item.id}:${scope[0]}` : String(item.id);
      requirements.push({
        id: key, subject_id: String(item.subject_id), subject_name: String(subject?.name ?? item.subject_id), subject_code: String(subject?.code ?? ""),
        session_type: SESSION_TYPES[String(item.session_type)] ?? "theory", sessions_per_week: Number(item.weekly_sessions),
        duration_minutes: Math.max(1, Number(item.duration_periods) * averagePeriodMinutes), faculty_ids: facultyIds, group_ids: scope,
        room_facilities: facilityCodes, min_room_capacity: Number(item.expected_size) > 0 ? Number(item.expected_size) : undefined, conflict_group_ids: scope.flatMap((groupId) => groups.find((candidate) => candidate.id === groupId)?.conflict_group_ids ?? []), spread: true,
      });
      sessionMap[key] = { requirementId: String(item.id), subjectId: String(item.subject_id), sessionType: String(item.session_type), groupIds: scope };
    }
  }

  const baseVersion = existingVersions[0] ?? null;
  const fixedSessions: Row[] = [];
  const previousPlacements: Record<string, Row> = {};
  if (baseVersion) {
    const priorSessions = await rows(supabase.from("timetable_sessions").select("id,requirement_id,occurrence_no,day_of_week,starts_at,faculty_id,room_id,notes").eq("version_id", String(baseVersion.id)));
    const priorIds = priorSessions.map((session) => String(session.id));
    const [locks, participants] = priorIds.length ? await Promise.all([
      rows(supabase.from("session_locks").select("session_id").in("session_id", priorIds)),
      rows(supabase.from("session_participants").select("session_id,group_id").in("session_id", priorIds)),
    ]) : [[], []];
    const lockSet = new Set(locks.map((item) => String(item.session_id)));
    const participantBySession = groupRows(participants, "session_id");
    for (const prior of priorSessions) {
      const pGroups = (participantBySession[String(prior.id)] ?? []).map((item) => String(item.group_id));
      const key = requirements.some((req) => req.id === `${prior.requirement_id}:${pGroups[0]}`) ? `${prior.requirement_id}:${pGroups[0]}` : String(prior.requirement_id);
      if (!sessionMap[key] || !prior.day_of_week || !prior.starts_at || !prior.faculty_id || !prior.room_id) continue;
      const day = days.find((item) => Number(item.id) === Number(prior.day_of_week));
      const startIndex = day?.periods.findIndex((period) => period.start_minute === minute(String(prior.starts_at))) ?? -1;
      if (startIndex < 0) continue;
      let sessionId = `${key}__${Number(prior.occurrence_no)}`;
      try { const notes = JSON.parse(String(prior.notes ?? "{}")); if (notes.solver_session_id) sessionId = String(notes.solver_session_id); } catch { /* legacy notes are plain text */ }
      const fixed = { session_id: sessionId, requirement_id: key, day_id: String(prior.day_of_week), start_period_index: startIndex, room_id: String(prior.room_id), faculty_id: String(prior.faculty_id), locked: lockSet.has(String(prior.id)) };
      previousPlacements[sessionId] = fixed;
      if (fixed.locked) fixedSessions.push(fixed);
    }
  }

  // Avoid an accidentally empty allowed list: null means unrestricted, while [] means no availability.
  for (const person of faculty) {
    if (person.available_slot_ids && person.available_slot_ids.length === 0) throw new Error(`Approved availability leaves ${person.name} with no usable periods.`);
  }
  if (!allSlotIds.length) throw new Error("The active timing template has no periods.");
  return {
    semesterId,
    baseVersionId: baseVersion ? String(baseVersion.id) : null,
    baseVersionRevision: baseVersion ? Number(baseVersion.revision) : 0,
    baseVersionStatus: baseVersion ? String(baseVersion.status) : null,
    baseVersionUpdatedAt: baseVersion ? String(baseVersion.updated_at) : null,
    sessionMap,
    request: {
      days, groups, faculty, rooms, requirements, fixed_sessions: fixedSessions,
      options: { time_limit_seconds: 20, workers: 8, random_seed: 1, objective_weights: { subject_spreading: ruleWeight("SPREAD_SUBJECTS", 10), daily_load_balance: ruleWeight("BALANCE_LOAD", 5), student_gaps: ruleWeight("REDUCE_GAPS", 2), faculty_gaps: ruleWeight("REDUCE_GAPS", 2), room_changes: ruleWeight("REDUCE_ROOM_CHANGES", 1), preferred_time: ruleWeight("PREFERRED_FACULTY_TIMES", 3), change_minimization: ruleWeight("MINIMIZE_REGENERATION_CHANGE", 8), prefer_lab_blocks: ruleWeight("PREFER_LAB_BLOCKS", 2) }, previous_placements: previousPlacements },
    },
  };
}
