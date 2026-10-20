import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedProfile } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function minutes(value: string) { const [h, m] = value.split(":").map(Number); return (h || 0) * 60 + (m || 0); }
function timeOf(value: number) { return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}:00`; }
function rel(value: any) { return Array.isArray(value) ? value[0] ?? {} : value ?? {}; }
function parseNotes(value: unknown) { try { return JSON.parse(String(value ?? "{}")); } catch { return {}; } }
function keyForRow(row: any, sessionMap: Record<string, any>, participants: string[]) {
  const savedSolverId = String(parseNotes(row.notes).solver_session_id ?? "");
  if (savedSolverId) return savedSolverId.replace(/__\d+$/, "");
  return Object.entries(sessionMap).find(([, value]) => String(value.requirementId) === String(row.requirement_id) && value.groupIds.length === participants.length && value.groupIds.every((id: string) => participants.includes(id)))?.[0] ?? String(row.requirement_id);
}
function solverIdForRow(row: any, key: string) { return String(parseNotes(row.notes).solver_session_id ?? `${key}__${Number(row.occurrence_no)}`); }

async function protectedSolverFetch(url: string, key: string, path: string, payload: unknown) {
  return fetch(`${url.replace(/\/$/, "")}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Solver-Key": key }, body: JSON.stringify(payload), cache: "no-store", signal: AbortSignal.timeout(path.endsWith("validate") ? 18_000 : 45_000) });
}

export async function POST(request: NextRequest) {
  const { supabase, user, profile, configured } = await getAuthenticatedProfile();
  if (!configured) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  if (!user || !profile) return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Only an approved administrator can repair timetable sessions." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const solverUrl = process.env.SOLVER_API_URL; const solverKey = process.env.SOLVER_API_KEY;
  if (!solverUrl || !solverKey) return NextResponse.json({ error: "The solver service is not configured." }, { status: 503 });

  if (action === "commit") {
    const proposalId = String(body.proposal_id ?? "");
    if (!proposalId) return NextResponse.json({ error: "A repair proposal is required." }, { status: 400 });
    const { data: proposal, error: proposalError } = await supabase!.from("repair_proposals").select("id,version_id,requested_by,expected_updated_at,validation_input,status,expires_at").eq("id", proposalId).eq("requested_by", user.id).maybeSingle();
    if (proposalError || !proposal) return NextResponse.json({ error: "Repair proposal not found." }, { status: 404 });
    if (proposal.status !== "Pending" || new Date(proposal.expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "Repair proposal expired or has already been used; create a fresh preview." }, { status: 409 });
    const { data: version, error: versionError } = await supabase!.from("timetable_versions").select("id,status,updated_at").eq("id", proposal.version_id).maybeSingle();
    if (versionError || !version) return NextResponse.json({ error: "Draft timetable was removed." }, { status: 404 });
    if (version.status !== "Draft" || new Date(version.updated_at).getTime() !== new Date(proposal.expected_updated_at).getTime()) return NextResponse.json({ error: "Draft changed since the preview. Reload and create a new repair preview." }, { status: 409 });
    try {
      const validationResponse = await protectedSolverFetch(solverUrl, solverKey, "/v1/schedules/validate", proposal.validation_input);
      if (!validationResponse.ok) return NextResponse.json({ error: `Independent validator returned HTTP ${validationResponse.status}.` }, { status: 502 });
      const validation = await validationResponse.json() as { valid: boolean; diagnostics: unknown[] };
      if (!validation.valid) return NextResponse.json({ error: "The repair no longer passes independent validation. The saved draft was not changed.", diagnostics: validation.diagnostics }, { status: 422 });
      const { data, error: applyError } = await supabase!.rpc("apply_timetable_repair", { p_proposal_id: proposal.id });
      if (applyError) return NextResponse.json({ error: applyError.message }, { status: 409 });
      return NextResponse.json({ status: "Draft", version: data, message: "The accepted repair passed validation and was applied atomically. The draft remains unpublished; review approval is invalidated." });
    } catch {
      return NextResponse.json({ error: "Repair validation service could not be reached. The previous draft remains unchanged." }, { status: 502 });
    }
  }

  if (action !== "preview") return NextResponse.json({ error: "Choose preview or commit." }, { status: 400 });
  const versionId = String(body.version_id ?? ""); const sessionId = String(body.session_id ?? "");
  const dayValue = String(body.day_id ?? ""); const startValue = String(body.starts_at ?? ""); const roomId = String(body.room_id ?? ""); const facultyId = String(body.faculty_id ?? "");
  if (!versionId || !sessionId || !dayValue || !/^\d{2}:\d{2}$/.test(startValue) || !roomId || !facultyId) return NextResponse.json({ error: "Choose a day, configured period start, room, and eligible faculty." }, { status: 400 });

  const { data: version, error: versionError } = await supabase!.from("timetable_versions").select("id,semester_id,generation_job_id,status,updated_at").eq("id", versionId).maybeSingle();
  if (versionError || !version) return NextResponse.json({ error: "Timetable version not found." }, { status: 404 });
  if (version.status !== "Draft") return NextResponse.json({ error: "Only a Draft can be edited. Restore a published revision to a new draft first." }, { status: 409 });
  if (!version.generation_job_id) return NextResponse.json({ error: "This draft has no saved solver input for a safe reconfiguration." }, { status: 409 });
  const [{ data: job, error: jobError }, { data: dbRows, error: rowsError }] = await Promise.all([
    supabase!.from("generation_jobs").select("diagnostics").eq("id", version.generation_job_id).maybeSingle(),
    supabase!.from("timetable_sessions").select("id,requirement_id,subject_id,session_type,occurrence_no,day_of_week,starts_at,ends_at,duration_periods,faculty_id,room_id,notes,session_participants(group_id),session_locks(id,lock_reason)").eq("version_id", versionId),
  ]);
  if (jobError || rowsError || !job || !dbRows?.length) return NextResponse.json({ error: "Draft sessions or their solver input could not be loaded." }, { status: 500 });
  const metadata = job.diagnostics ?? {}; const schedule = structuredClone(metadata.schedule_request); const sessionMap = metadata.session_map ?? {};
  if (!schedule || !Array.isArray(schedule.days) || !schedule.options) return NextResponse.json({ error: "Saved solver input is missing; this draft cannot be reconfigured safely." }, { status: 409 });
  const current: any[] = dbRows.map((row: any) => {
    const groupIds = (row.session_participants ?? []).map((item: any) => String(item.group_id));
    const requirementKey = keyForRow(row, sessionMap, groupIds);
    const notes = parseNotes(row.notes);
    return { row, groupIds, requirementKey, solverId: solverIdForRow(row, requirementKey), locked: Boolean(row.session_locks?.length), lockReason: row.session_locks?.[0]?.lock_reason ?? (notes.lock_preserved ? "Previously preserved by the scheduling engine" : "") };
  });
  const target = current.find((item) => String(item.row.id) === sessionId);
  if (!target) return NextResponse.json({ error: "Session not found in this draft." }, { status: 404 });
  if (target.locked) return NextResponse.json({ error: "This session is locked. Unlock it before changing placement." }, { status: 409 });
  const day = schedule.days.find((item: any) => String(item.id) === dayValue || String(item.label).toLowerCase() === dayValue.toLowerCase());
  if (!day) return NextResponse.json({ error: "Choose a working day from this timing template." }, { status: 400 });
  const startMinute = minutes(startValue);
  const startIndex = day.periods.findIndex((period: any) => Number(period.start_minute) === startMinute && !period.blocked);
  if (startIndex < 0) return NextResponse.json({ error: "Choose an enabled period start from the active timing template." }, { status: 400 });
  const savedRequirement = schedule.requirements.find((item: any) => item.id === target.requirementKey);
  if (!savedRequirement) return NextResponse.json({ error: "Session requirement could not be matched to the solver input." }, { status: 409 });
  const selectedGroupIds: string[] = Array.isArray(body.group_ids) ? [...new Set(body.group_ids.map((id: unknown) => String(id)))] : target.groupIds;
  if (!selectedGroupIds.length) return NextResponse.json({ error: "Select at least one participant group." }, { status: 400 });
  const selectedGroups = selectedGroupIds.map((id: string) => schedule.groups.find((item: any) => String(item.id) === id));
  if (selectedGroups.some((item: any) => !item)) return NextResponse.json({ error: "Choose participant groups in this scheduling scope." }, { status: 400 });
  const solverOccurrence = target.solverId.match(/__(\d+)$/);
  const occurrence = Number(solverOccurrence?.[1]);
  if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > Number(savedRequirement.sessions_per_week)) return NextResponse.json({ error: "The selected session occurrence is not valid for this weekly requirement." }, { status: 409 });
  const repairedRequirements = schedule.requirements.map((item: any) => item.id === savedRequirement.id ? {
    ...item,
    group_ids_by_occurrence: { ...(item.group_ids_by_occurrence ?? {}), [occurrence]: selectedGroupIds },
    min_room_capacity: Math.max(1, Number(savedRequirement.min_room_capacity ?? 1), ...selectedGroups.map((group: any) => Number(group.size ?? 1))),
  } : item);
  if (!schedule.faculty.some((item: any) => item.id === facultyId)) return NextResponse.json({ error: "Choose a faculty member in this scheduling scope." }, { status: 400 });
  if (!schedule.rooms.some((item: any) => item.id === roomId)) return NextResponse.json({ error: "Choose a room in this scheduling scope." }, { status: 400 });

  const previous: Record<string, any> = {};
  const lockedSessions = [] as any[];
  for (const item of current) {
    const row = item.row;
    const dayId = String(row.day_of_week);
    const sessionDay = schedule.days.find((candidate: any) => String(candidate.id) === dayId);
    const index = sessionDay?.periods.findIndex((period: any) => Number(period.start_minute) === minutes(String(row.starts_at))) ?? -1;
    if (index < 0) return NextResponse.json({ error: `Existing session ${item.solverId} cannot be mapped to the current timing template.` }, { status: 409 });
    const placement = { session_id: item.solverId, requirement_id: item.requirementKey, day_id: dayId, start_period_index: index, room_id: String(row.room_id), faculty_id: String(row.faculty_id), locked: item.locked };
    previous[item.solverId] = placement;
    if (item.locked) lockedSessions.push(placement);
  }
  const requested = { session_id: target.solverId, requirement_id: target.requirementKey, day_id: String(day.id), start_period_index: startIndex, room_id: roomId, faculty_id: facultyId, locked: false };
  const fixedMap = new Map<string, any>();
  for (const fixed of [...lockedSessions, requested]) fixedMap.set(String(fixed.session_id), fixed);
  const repairInput = {
    ...schedule,
    requirements: repairedRequirements,
    fixed_sessions: [...fixedMap.values()],
    options: { ...schedule.options, repair_session_id: target.solverId, requested_placement: requested, previous_placements: previous },
  };
  try {
    const response = await protectedSolverFetch(solverUrl, solverKey, "/v1/schedules/generate", repairInput);
    if (!response.ok) return NextResponse.json({ error: `Solver returned HTTP ${response.status}. The draft was not changed.` }, { status: 502 });
    const result = await response.json() as { outcome: string; status_message: string; sessions: any[]; diagnostics: any[]; validation?: { valid: boolean; diagnostics: any[] } };
    if (!(["FEASIBLE", "OPTIMAL"].includes(result.outcome) && result.validation?.valid && result.sessions?.length)) return NextResponse.json({ error: result.status_message || "No valid repair was found; the draft was not changed.", outcome: result.outcome, diagnostics: result.diagnostics ?? [] }, { status: 422 });
    const occurrence = new Map<string, number>();
    const candidate = result.sessions.map((session) => {
      const mapping = sessionMap[session.requirement_id];
      if (!mapping) throw new Error(`Solver output requirement ${session.requirement_id} could not be mapped.`);
      const no = (occurrence.get(mapping.requirementId) ?? 0) + 1; occurrence.set(mapping.requirementId, no);
      const prior = current.find((item) => item.solverId === session.session_id);
      return { requirement_id: mapping.requirementId, subject_id: mapping.subjectId, session_type: mapping.sessionType, occurrence_no: no, day_of_week: Number(session.day_id), starts_at: timeOf(session.start_minute), ends_at: timeOf(session.end_minute), duration_periods: Math.max(1, Number(session.end_period_index) - Number(session.start_period_index) + 1), faculty_id: session.faculty_id, room_id: session.room_id, solver_session_id: session.session_id, group_ids: session.group_ids, locked: Boolean(session.locked), lock_reason: prior?.lockReason ?? (session.session_id === target.solverId ? "Administrator placement accepted" : "Preserved during reconfiguration"), placement_source: session.session_id === target.solverId ? "Manual Repair" : prior && previous[session.session_id] && previous[session.session_id].day_id === session.day_id && previous[session.session_id].start_period_index === session.start_period_index && previous[session.session_id].room_id === session.room_id && previous[session.session_id].faculty_id === session.faculty_id ? "Solver" : "Reconfigured" };
    });
    const oldById = new Map(current.map((item) => [item.solverId, item]));
    const candidateIds = new Set(result.sessions.map((item) => String(item.session_id)));
    const changed = result.sessions.filter((session) => {
      const prior = oldById.get(String(session.session_id));
      if (!prior) return true;
      const row = prior.row;
      const groupsChanged = JSON.stringify([...prior.groupIds].sort()) !== JSON.stringify([...session.group_ids].sort());
      return Number(row.day_of_week) !== Number(session.day_id) || minutes(String(row.starts_at)) !== Number(session.start_minute) || String(row.room_id) !== String(session.room_id) || String(row.faculty_id) !== String(session.faculty_id) || groupsChanged;
    }).map((session) => ({ session_id: session.session_id, subject: session.subject_name, day: session.day_label, time: `${timeOf(session.start_minute).slice(0, 5)}–${timeOf(session.end_minute).slice(0, 5)}`, room: session.room_id, faculty: session.faculty_id, groups: session.group_ids, requested: session.session_id === target.solverId }));
    const removed = current.filter((item) => !candidateIds.has(item.solverId)).map((item) => item.solverId);
    const validationInput = { schedule: repairInput, sessions: result.sessions };
    const { data: proposal, error: proposalError } = await supabase!.from("repair_proposals").insert({ version_id: versionId, requested_by: user.id, expected_updated_at: version.updated_at, requested_session_id: target.solverId, requested_placement: requested, candidate_sessions: candidate, validation_input: validationInput, validation: result.validation }).select("id,expires_at").single();
    if (proposalError || !proposal) throw new Error("Could not save the repair preview; no schedule was changed.");
    return NextResponse.json({ proposal_id: proposal.id, expires_at: proposal.expires_at, expected_updated_at: version.updated_at, requested_session_id: target.solverId, candidate, changed, removed, unchanged_count: Math.max(0, result.sessions.length - changed.length), message: "The requested placement is fixed for this preview. Review affected sessions before accepting; no timetable data has been changed." });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Repair could not be generated.";
    return NextResponse.json({ error: message, message: "The prior draft remains unchanged." }, { status: 422 });
  }
}
