"use client";

import { useEffect, useState } from "react";
import { Activity, Check, GitCompare, RotateCcw, ShieldCheck } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase-browser";

type Version = { id: string; semester_id: string; revision: number; label: string; status: string; created_at: string; approved_by: string | null; base_version_id: string | null; generation_job_id: string | null };
type Diff = { changed: string[]; added: string[]; removed: string[] };

export function VersionReviewPanel() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyId, setBusyId] = useState("");
  const [diff, setDiff] = useState<{ versionId: string; details: Diff } | null>(null);

  async function loadVersions() {
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured."); setLoading(false); return; }
    setLoading(true); setError("");
    const { data, error: queryError } = await supabase.from("timetable_versions").select("id,semester_id,revision,label,status,created_at,approved_by,base_version_id,generation_job_id").order("revision", { ascending: false });
    if (queryError) setError("Could not load timetable version history. Check administrator access and database setup.");
    else setVersions((data ?? []) as Version[]);
    setLoading(false);
  }
  useEffect(() => { void loadVersions(); }, []);

  async function action(version: Version, name: "submit" | "approve" | "publish" | "restore") {
    setBusyId(version.id); setError(""); setMessage(""); setDiff(null);
    try {
      const response = await fetch(`/api/timetable/versions/${encodeURIComponent(version.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: name }), cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Version action failed.");
      setMessage(result.message ?? (name === "restore" ? `Restored into a new draft (revision ${result.revision}).` : "Version updated."));
      await loadVersions();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Version action failed."); }
    finally { setBusyId(""); }
  }

  async function compare(version: Version) {
    if (!version.base_version_id) { setMessage("This revision has no prior base version to compare."); setDiff(null); return; }
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    setError(""); setMessage(""); setBusyId(version.id);
    try {
      const [current, previous] = await Promise.all([
        supabase.from("timetable_sessions").select("requirement_id,occurrence_no,day_of_week,starts_at,ends_at,faculty_id,room_id,session_type").eq("version_id", version.id),
        supabase.from("timetable_sessions").select("requirement_id,occurrence_no,day_of_week,starts_at,ends_at,faculty_id,room_id,session_type").eq("version_id", version.base_version_id),
      ]);
      if (current.error || previous.error) throw new Error("Revision comparison could not be loaded.");
      const key = (row: any) => `${row.requirement_id}:${row.occurrence_no}`;
      const oldMap = new Map((previous.data ?? []).map((row: any) => [key(row), JSON.stringify([row.day_of_week, row.starts_at, row.ends_at, row.faculty_id, row.room_id, row.session_type])]));
      const newMap = new Map((current.data ?? []).map((row: any) => [key(row), JSON.stringify([row.day_of_week, row.starts_at, row.ends_at, row.faculty_id, row.room_id, row.session_type])]));
      const changed = [...newMap.keys()].filter((id) => oldMap.has(id) && oldMap.get(id) !== newMap.get(id));
      const added = [...newMap.keys()].filter((id) => !oldMap.has(id));
      const removed = [...oldMap.keys()].filter((id) => !newMap.has(id));
      setDiff({ versionId: version.id, details: { changed, added, removed } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Comparison failed."); }
    finally { setBusyId(""); }
  }

  return <section className="card fade-in">
    <div className="card-title"><div><div className="eyebrow">Version control</div><h2 style={{ marginTop: 5 }}>Drafts, review, and publication</h2></div><span className="tag"><Activity size={12} /> {versions.length} version{versions.length === 1 ? "" : "s"}</span></div>
    <div className="notice">Drafts and Under Review versions are administrator-only. Teachers and students continue to see the last Published revision until publication succeeds atomically.</div>
    {message && <div className="notice" role="status" style={{ marginTop: 13 }}>{message}</div>}
    {error && <div className="alert" role="alert" style={{ marginTop: 13 }}>{error}</div>}
    {diff && <div className="card" style={{ marginTop: 13, background: "#faf8f1" }}><div className="card-title"><strong>Revision comparison</strong><span className="tag"><GitCompare size={12} /> {diff.details.changed.length} changed</span></div><div className="filter-row"><span className="tag">{diff.details.added.length} added</span><span className="tag clay">{diff.details.removed.length} removed</span><span className="tag">{Math.max(0, (versions.find((item) => item.id === diff.versionId)?.revision ?? 1) - diff.details.changed.length - diff.details.added.length)} unchanged (approx.)</span></div><p className="muted small" style={{ margin: "10px 0 0" }}>{diff.details.changed.length ? `Changed session keys: ${diff.details.changed.slice(0, 12).join(", ")}${diff.details.changed.length > 12 ? "…" : ""}` : "No placement changes were found."}</p></div>}
    {loading ? <div className="empty-state" role="status"><span className="spinner" /><p style={{ margin: "10px 0 0" }}>Loading revision history…</p></div> : versions.length === 0 ? <div className="empty-state" style={{ marginTop: 14 }}><div className="empty-icon"><ShieldCheck size={19} /></div><h3>Nothing in review</h3><p className="muted small">Generate and independently validate a timetable before submitting it for review.</p></div> : <div className="session-list" style={{ marginTop: 14 }}>{versions.map((version) => <article className="session-row" key={version.id} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}><div><div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><strong>{version.label || `Revision ${version.revision}`}</strong><span className={`tag ${version.status === "Draft" ? "amber" : version.status === "Published" ? "" : "clay"}`}>{version.status}</span><span className="tag">r{version.revision}</span>{version.approved_by && <span className="tag"><Check size={11} /> Approved</span>}</div><div className="session-meta">Created {new Date(version.created_at).toLocaleString()} · {version.generation_job_id ? "Solver-generated" : "Restored revision"}</div></div><div className="filter-row">{version.base_version_id && <button type="button" className="btn btn-ghost" disabled={busyId === version.id} onClick={() => void compare(version)}><GitCompare size={13} /> Compare</button>}{version.status === "Draft" && <button type="button" className="btn btn-secondary" disabled={busyId === version.id} onClick={() => void action(version, "submit")}>{busyId === version.id ? "Validating…" : "Validate & submit"}</button>}{version.status === "Under Review" && !version.approved_by && <button type="button" className="btn btn-secondary" disabled={busyId === version.id} onClick={() => void action(version, "approve")}>Approve</button>}{version.status === "Under Review" && Boolean(version.approved_by) && <button type="button" className="btn btn-primary" disabled={busyId === version.id} onClick={() => void action(version, "publish")}>Publish</button>}{["Published", "Archived"].includes(version.status) && <button type="button" className="btn btn-ghost" disabled={busyId === version.id} onClick={() => void action(version, "restore")}><RotateCcw size={13} /> Restore to draft</button>}</div></article>)}</div>}
  </section>;
}
