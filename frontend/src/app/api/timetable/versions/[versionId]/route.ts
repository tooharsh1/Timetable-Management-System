import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedProfile } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function minute(value: string | null | undefined) { if (!value) return 0; const [h, m] = value.split(":").map(Number); return (h || 0) * 60 + (m || 0); }
function timeOf(value: string | null | undefined) { return value ? String(value).slice(0, 8) : null; }
function relation(value: any) { return Array.isArray(value) ? value[0] ?? {} : value ?? {}; }
const solverType: Record<string, string> = { Lecture: "theory", Tutorial: "tutorial", Practical: "lab", Elective: "elective" };

async function revalidateDraft(supabase: any, version: any, solverUrl: string, solverKey: string) {
  if (!version.generation_job_id) throw new Error("This version has no original solver input for independent revalidation.");
  const { data: job, error: jobError } = await supabase.from("generation_jobs").select("diagnostics").eq("id", version.generation_job_id).maybeSingle();
  if (jobError || !job) throw new Error("The original generation record could not be loaded.");
  const meta = job.diagnostics ?? {};
  const schedule = meta.schedule_request;
  const sessionMap = meta.session_map ?? {};
  if (!schedule || !Array.isArray(schedule.days)) throw new Error("The saved solver request is unavailable; this version cannot be revalidated safely.");
  const { data: dbRows, error } = await supabase.from("timetable_sessions").select("id,requirement_id,subject_id,session_type,occurrence_no,day_of_week,starts_at,ends_at,duration_periods,faculty_id,room_id,notes,session_participants(group_id),session_locks(id)").eq("version_id", version.id);
  if (error) throw new Error("Could not load the sessions for validation.");
  const solverSessions = (dbRows ?? []).map((row: any) => {
    let note: any = {};
    try { note = JSON.parse(String(row.notes ?? "{}")); } catch { /* old notes do not carry a solver key */ }
    const participantGroups = (row.session_participants ?? []).map((item: any) => String(item.group_id));
    const mappingEntry = Object.entries(sessionMap).find(([, value]: [string, any]) => value.requirementId === String(row.requirement_id) && value.groupIds.every((groupId: string) => participantGroups.includes(groupId)) && participantGroups.every((groupId: string) => value.groupIds.includes(groupId)));
    const solverSessionId = String(note.solver_session_id ?? `${row.requirement_id}__${Number(row.occurrence_no)}`);
    const solverRequirementKey = solverSessionId.replace(/__\d+$/, "");
    const requirementKey = note.solver_session_id ? solverRequirementKey : mappingEntry?.[0] ?? solverRequirementKey;
    const savedRequirement = schedule.requirements.find((item: any) => item.id === requirementKey);
    const dayId = String(row.day_of_week ?? "");
    const day = schedule.days.find((item: any) => String(item.id) === dayId);
    const startMinute = minute(timeOf(row.starts_at));
    const endMinute = minute(timeOf(row.ends_at));
    const startIndex = day?.periods.findIndex((period: any) => Number(period.start_minute) === startMinute) ?? -1;
    if (!savedRequirement || !day || startIndex < 0) throw new Error(`Saved session ${row.id} cannot be mapped back to the validated solver input.`);
    const endIndex = day.periods.findIndex((period: any, index: number) => index >= startIndex && Number(period.end_minute) === endMinute);
    return {
      session_id: solverSessionId,
      requirement_id: requirementKey,
      subject_id: String(row.subject_id),
      subject_name: String(savedRequirement.subject_name),
      session_type: solverType[String(row.session_type)] ?? savedRequirement.session_type,
      day_id: dayId,
      day_label: String(day.label),
      start_period_index: startIndex,
      end_period_index: endIndex >= startIndex ? endIndex : startIndex + Math.max(0, Number(row.duration_periods) - 1),
      start_minute: startMinute,
      end_minute: endMinute,
      room_id: String(row.room_id),
      faculty_id: String(row.faculty_id),
      group_ids: participantGroups,
      locked: Boolean(row.session_locks?.length),
    };
  });
  const response = await fetch(`${solverUrl.replace(/\/$/, "")}/v1/schedules/validate`, { method: "POST", headers: { "Content-Type": "application/json", "X-Solver-Key": solverKey }, body: JSON.stringify({ schedule, sessions: solverSessions }), cache: "no-store", signal: AbortSignal.timeout(18_000) });
  if (!response.ok) throw new Error(`Independent validator returned HTTP ${response.status}.`);
  return await response.json() as { valid: boolean; diagnostics: unknown[] };
}

async function restoreVersion(supabase: any, source: any, userId: string) {
  const { data: revisions, error: revisionError } = await supabase.from("timetable_versions").select("revision").eq("semester_id", source.semester_id).order("revision", { ascending: false }).limit(1);
  if (revisionError) throw new Error(revisionError.message);
  const revision = Number(revisions?.[0]?.revision ?? 0) + 1;
  const { data: draft, error: draftError } = await supabase.from("timetable_versions").insert({ semester_id: source.semester_id, generation_job_id: source.generation_job_id, base_version_id: source.id, revision, label: `Restored draft from revision ${source.revision}`, status: "Draft", created_by: userId }).select("id").single();
  if (draftError || !draft) throw new Error(draftError?.message ?? "Could not create restoration draft.");
  try {
    const { data: sourceSessions, error: sessionError } = await supabase.from("timetable_sessions").select("id,requirement_id,subject_id,session_type,occurrence_no,day_of_week,starts_at,ends_at,duration_periods,faculty_id,room_id,placement_source,validation_state,notes,session_participants(group_id,attendance_required),session_locks(locked_by,lock_reason)").eq("version_id", source.id);
    if (sessionError) throw new Error(sessionError.message);
    const cloned = (sourceSessions ?? []).map((row: any) => ({ ...Object.fromEntries(["requirement_id", "subject_id", "session_type", "occurrence_no", "day_of_week", "starts_at", "ends_at", "duration_periods", "faculty_id", "room_id", "placement_source", "notes"].map((key) => [key, row[key]])), version_id: draft.id, validation_state: "Unvalidated", id: crypto.randomUUID() }));
    const { error: clonedError } = cloned.length ? await supabase.from("timetable_sessions").insert(cloned) : { error: null };
    if (clonedError) throw new Error(clonedError.message);
    const idMap = new Map((sourceSessions ?? []).map((row: any, index: number) => [String(row.id), String(cloned[index].id)]));
    const participantRows = (sourceSessions ?? []).flatMap((row: any) => (row.session_participants ?? []).map((participant: any) => ({ session_id: idMap.get(String(row.id)), group_id: participant.group_id, attendance_required: participant.attendance_required })));
    const lockRows = (sourceSessions ?? []).flatMap((row: any) => (row.session_locks ?? []).map((lock: any) => ({ session_id: idMap.get(String(row.id)), locked_by: lock.locked_by, lock_reason: lock.lock_reason })));
    const [participantResult, lockResult] = await Promise.all([
      participantRows.length ? supabase.from("session_participants").insert(participantRows) : Promise.resolve({ error: null }),
      lockRows.length ? supabase.from("session_locks").insert(lockRows) : Promise.resolve({ error: null }),
    ]);
    if (participantResult.error) throw new Error(participantResult.error.message);
    if (lockResult.error) throw new Error(lockResult.error.message);
    return { id: draft.id, revision, count: cloned.length };
  } catch (cause) {
    await supabase.from("timetable_versions").delete().eq("id", draft.id);
    throw cause;
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params;
  const { supabase, user, profile, configured } = await getAuthenticatedProfile();
  if (!configured) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  if (!user || !profile) return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Only an approved administrator can review timetable versions." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const { data: version, error } = await supabase!.from("timetable_versions").select("id,semester_id,generation_job_id,base_version_id,revision,label,status,approved_by").eq("id", versionId).maybeSingle();
  if (error || !version) return NextResponse.json({ error: "Timetable version not found." }, { status: 404 });

  try {
    if (action === "restore") {
      if (!["Published", "Archived"].includes(String(version.status))) return NextResponse.json({ error: "Only a previously published or archived version can be restored to a new draft." }, { status: 409 });
      return NextResponse.json(await restoreVersion(supabase, version, user.id), { status: 201 });
    }
    if (action === "submit") {
      if (version.status !== "Draft") return NextResponse.json({ error: "Only a Draft version can enter review." }, { status: 409 });
      const solverUrl = process.env.SOLVER_API_URL; const solverKey = process.env.SOLVER_API_KEY;
      if (!solverUrl || !solverKey) return NextResponse.json({ error: "The independent validation service is not configured." }, { status: 503 });
      const validation = await revalidateDraft(supabase, version, solverUrl, solverKey);
      if (!validation.valid) return NextResponse.json({ error: "Independent validation failed; the draft remains unchanged.", diagnostics: validation.diagnostics }, { status: 422 });
      const { error: sessionError } = await supabase!.from("timetable_sessions").update({ validation_state: "Valid" }).eq("version_id", versionId);
      if (sessionError) throw new Error(sessionError.message);
      const { error: approvalError } = await supabase!.from("approvals").upsert([
        { version_id: versionId, stage: "Validation", status: "Approved", actor_id: user.id, notes: "Independent solver validation passed.", decided_at: new Date().toISOString() },
        { version_id: versionId, stage: "Review", status: "Pending", actor_id: user.id, notes: "Awaiting administrator review." },
      ], { onConflict: "version_id,stage" });
      if (approvalError) throw new Error(approvalError.message);
      const { error: updateError } = await supabase!.from("timetable_versions").update({ status: "Under Review", approved_by: null, approved_at: null }).eq("id", versionId);
      if (updateError) throw new Error(updateError.message);
      return NextResponse.json({ status: "Under Review", message: "Independent validation passed. The version is now in review; users still see the prior publication." });
    }
    if (action === "approve") {
      if (version.status !== "Under Review") return NextResponse.json({ error: "Only a version Under Review can be approved." }, { status: 409 });
      const { error: approvalError } = await supabase!.from("approvals").upsert({ version_id: versionId, stage: "Review", status: "Approved", actor_id: user.id, notes: typeof body.notes === "string" ? body.notes.slice(0, 1000) : null, decided_at: new Date().toISOString() }, { onConflict: "version_id,stage" });
      if (approvalError) throw new Error(approvalError.message);
      const { error: updateError } = await supabase!.from("timetable_versions").update({ approved_by: user.id, approved_at: new Date().toISOString() }).eq("id", versionId);
      if (updateError) throw new Error(updateError.message);
      return NextResponse.json({ status: "Approved", message: "Review approval recorded. Publish when ready." });
    }
    if (action === "publish") {
      if (version.status !== "Under Review" || !version.approved_by) return NextResponse.json({ error: "A version must be approved while Under Review before publication." }, { status: 409 });
      const { data, error: publishError } = await supabase!.rpc("publish_timetable_version", { p_version_id: versionId });
      if (publishError) throw new Error(publishError.message);
      return NextResponse.json({ status: "Published", version: data, message: "Publication completed atomically. Teachers and students now see this revision." });
    }
    return NextResponse.json({ error: "Choose submit, approve, publish, or restore." }, { status: 400 });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "The requested version action failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
