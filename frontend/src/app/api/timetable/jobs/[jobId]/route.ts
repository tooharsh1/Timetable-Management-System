import { NextResponse, type NextRequest } from "next/server";
import { getAuthenticatedProfile } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SolverSession = { session_id: string; requirement_id: string; subject_id: string; session_type: string; day_id: string; start_period_index: number; end_period_index: number; start_minute: number; end_minute: number; room_id: string; faculty_id: string; group_ids: string[]; locked?: boolean };
type SolverOutcome = "FEASIBLE" | "OPTIMAL" | "INFEASIBLE" | "TIME_LIMIT_NO_SOLUTION" | "VALIDATION_ERROR" | "EXECUTION_ERROR";
const DB_STATUS: Record<SolverOutcome, string> = { FEASIBLE: "Feasible", OPTIMAL: "Optimal", INFEASIBLE: "Infeasible", TIME_LIMIT_NO_SOLUTION: "Time Limit No Solution", VALIDATION_ERROR: "Validation Error", EXECUTION_ERROR: "Execution Error" };

export async function GET(_request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const { supabase, user, profile, configured } = await getAuthenticatedProfile();
  if (!configured) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  if (!user || !profile) return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
  if (profile.role !== "admin") return NextResponse.json({ error: "Only an administrator can inspect generation jobs." }, { status: 403 });
  const { data: job, error } = await supabase!.from("generation_jobs").select("id,semester_id,status,diagnostics,progress").eq("id", jobId).maybeSingle();
  if (error || !job) return NextResponse.json({ error: "Generation job not found." }, { status: 404 });
  const metadata = (job.diagnostics ?? {}) as Record<string, any>;
  if (metadata.version_id) return NextResponse.json({ status: "finished", outcome: metadata.outcome, version_id: metadata.version_id, diagnostics: metadata.solver_diagnostics ?? [] });
  const solverJobId = String(metadata.solver_job_id ?? "");
  if (!solverJobId) return NextResponse.json({ status: job.status, error: "Solver job reference is missing." }, { status: 409 });
  const solverUrl = process.env.SOLVER_API_URL;
  const solverKey = process.env.SOLVER_API_KEY;
  if (!solverUrl || !solverKey) return NextResponse.json({ error: "The solver service is not configured." }, { status: 503 });

  let response: Response;
  try {
    response = await fetch(`${solverUrl.replace(/\/$/, "")}/v1/jobs/${encodeURIComponent(solverJobId)}`, { headers: { "X-Solver-Key": solverKey }, cache: "no-store", signal: AbortSignal.timeout(8_000) });
  } catch {
    return NextResponse.json({ error: "Could not reach the solver job status endpoint." }, { status: 502 });
  }
  if (!response.ok) return NextResponse.json({ error: "Solver job status is unavailable." }, { status: 502 });
  const solverJob = await response.json() as { status: string; result?: { outcome: SolverOutcome; status_message: string; sessions: SolverSession[]; diagnostics: unknown[]; validation?: { valid: boolean; diagnostics: unknown[] } } };
  if (solverJob.status !== "finished" || !solverJob.result) return NextResponse.json({ status: solverJob.status, progress: solverJob.status === "queued" ? 10 : 55 });

  const result = solverJob.result;
  const dbStatus = DB_STATUS[result.outcome] ?? "Execution Error";
  const finalMetadata = { ...metadata, outcome: result.outcome, solver_diagnostics: result.diagnostics ?? [], validation: result.validation ?? null, completed_at: new Date().toISOString() };
  if (!(result.outcome === "FEASIBLE" || result.outcome === "OPTIMAL") || !result.validation?.valid || !result.sessions?.length) {
    await supabase!.from("generation_jobs").update({ status: dbStatus, progress: 100, finished_at: new Date().toISOString(), diagnostics: finalMetadata }).eq("id", jobId);
    return NextResponse.json({ status: "finished", outcome: result.outcome, message: result.status_message, diagnostics: result.diagnostics ?? [], validation: result.validation ?? null });
  }

  try {
    const { data, error } = await supabase!.rpc("persist_generated_timetable_draft", {
      p_job_id: jobId,
      p_sessions: result.sessions,
      p_session_map: metadata.session_map ?? {},
      p_solver_outcome: result.outcome,
      p_solver_diagnostics: result.diagnostics ?? [],
      p_validation: result.validation,
    });
    if (error) throw new Error(error.message);
    const versionId = String(data?.version_id ?? "");
    const revision = Number(data?.revision);
    if (!versionId || !Number.isInteger(revision) || revision < 1) throw new Error("The atomic persistence function returned an incomplete draft receipt.");
    return NextResponse.json({ status: "finished", outcome: result.outcome, version_id: versionId, revision, message: "A complete schedule passed independent validation and was saved atomically as a private draft. It is not published." });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not persist the validated draft.";
    await supabase!.from("generation_jobs").update({ status: "Execution Error", progress: 100, finished_at: new Date().toISOString(), diagnostics: { ...finalMetadata, persistence_error: message } }).eq("id", jobId);
    return NextResponse.json({ status: "finished", outcome: "EXECUTION_ERROR", error: message, message: "The previous timetable was not replaced." }, { status: 500 });
  }
}
