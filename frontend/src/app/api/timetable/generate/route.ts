import { NextResponse } from "next/server";
import { getAuthenticatedProfile } from "@/lib/supabase-server";
import { buildScheduleInput } from "@/lib/schedule-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const { supabase, user, profile, configured } = await getAuthenticatedProfile();
  if (!configured) return NextResponse.json({ error: "Supabase is not configured for this environment." }, { status: 503 });
  if (!user || !profile) return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Only an approved administrator can generate timetables." }, { status: 403 });
  const solverUrl = process.env.SOLVER_API_URL;
  const solverKey = process.env.SOLVER_API_KEY;
  if (!solverUrl || !solverKey) return NextResponse.json({ error: "The solver service is not configured. Set SOLVER_API_URL and SOLVER_API_KEY on the server." }, { status: 503 });

  try {
    const built = await buildScheduleInput(supabase!);
    const { data: job, error: insertError } = await supabase!.from("generation_jobs").insert({
      semester_id: built.semesterId,
      requested_by: user.id,
      status: "Queued",
      progress: 0,
      solver_name: "OR-Tools CP-SAT",
    }).select("id").single();
    if (insertError || !job) throw new Error(insertError?.message ?? "Could not create a generation job.");

    let response: Response;
    try {
      response = await fetch(`${solverUrl.replace(/\/$/, "")}/v1/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Solver-Key": solverKey },
        body: JSON.stringify(built.request),
        cache: "no-store",
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      await supabase!.from("generation_jobs").update({ status: "Execution Error", finished_at: new Date().toISOString(), diagnostics: { message: "Solver service could not be reached." } }).eq("id", job.id);
      return NextResponse.json({ error: "The solver service could not be reached. Check its deployment and URL." }, { status: 502 });
    }
    if (!response.ok) {
      const errorBody = await response.text();
      await supabase!.from("generation_jobs").update({ status: "Execution Error", finished_at: new Date().toISOString(), diagnostics: { message: `Solver returned HTTP ${response.status}.` } }).eq("id", job.id);
      return NextResponse.json({ error: `The solver rejected the request (HTTP ${response.status}).`, detail: errorBody.slice(0, 400) }, { status: 502 });
    }
    const solverJob = await response.json() as { job_id?: string };
    if (!solverJob.job_id) throw new Error("Solver did not return a job identifier.");
    const diagnostics = { solver_job_id: solverJob.job_id, session_map: built.sessionMap, base_version_id: built.baseVersionId, base_version_revision: built.baseVersionRevision, base_version_status: built.baseVersionStatus, base_version_updated_at: built.baseVersionUpdatedAt, schedule_request: built.request, days: built.request.days.map((day) => ({ id: day.id, label: day.label })), input_summary: { requirements: built.request.requirements.length, groups: built.request.groups.length, faculty: built.request.faculty.length, rooms: built.request.rooms.length } };
    const { error: updateError } = await supabase!.from("generation_jobs").update({ diagnostics, started_at: new Date().toISOString() }).eq("id", job.id);
    if (updateError) throw new Error(updateError.message);
    return NextResponse.json({ job_id: job.id, status: "Queued", message: "Scheduling job accepted. It is using the active semester data and will report solver progress separately." }, { status: 202 });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Generation could not be started.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
