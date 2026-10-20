"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, Clock3, X } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import type { AppRole } from "@/lib/supabase-types";

type RequestRow = { id: string; faculty_id: string; day_of_week: number; starts_at: string; ends_at: string; status: string; approval: string; notes: string | null; faculty?: { full_name: string; initials: string } };
const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function AvailabilityPanel({ role }: { role: Extract<AppRole, "admin" | "teacher"> }) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [day, setDay] = useState("1");
  const [start, setStart] = useState("08:30");
  const [end, setEnd] = useState("10:30");
  const [kind, setKind] = useState("Preferred");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const isAdmin = role === "admin";

  async function load() {
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured."); setLoading(false); return; }
    setLoading(true); setError("");
    let query = supabase.from("faculty_availability").select("id,faculty_id,day_of_week,starts_at,ends_at,status,approval,notes,faculty(full_name,initials)").order("created_at", { ascending: false }).limit(100);
    if (isAdmin) query = query.eq("approval", "Pending");
    const { data, error: resultError } = await query;
    if (resultError) setError("Availability requests could not be loaded."); else setRows((data ?? []) as unknown as RequestRow[]);
    setLoading(false);
  }
  useEffect(() => { void load(); }, [isAdmin]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setMessage("");
    if (start >= end) { setError("End time must be later than start time."); return; }
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured."); return; }
    setBusy(true);
    try {
      const [{ data: auth }, { data: semester, error: semesterError }] = await Promise.all([
        supabase.auth.getUser(),
        supabase.from("semesters").select("id").eq("is_active", true).order("starts_on", { ascending: false }).limit(1).maybeSingle(),
      ]);
      if (semesterError || !semester?.id) throw new Error("Choose an active semester before submitting a preference.");
      if (!auth.user) throw new Error("Please sign in again.");
      const { data: faculty, error: facultyError } = await supabase.from("faculty").select("id").eq("profile_id", auth.user.id).maybeSingle();
      if (facultyError || !faculty?.id) throw new Error("Your account is not linked to a faculty record. Ask an administrator to complete the profile link.");
      const { error: saveError } = await supabase.from("faculty_availability").insert({ faculty_id: faculty.id, semester_id: semester.id, day_of_week: Number(day), starts_at: start, ends_at: end, status: kind, approval: "Pending", submitted_by: auth.user.id, notes: notes.trim() || null });
      if (saveError) throw new Error("The preference could not be submitted. Try again or ask an administrator to check access.");
      setMessage("Preference sent for administrator review. It will not change hard availability until approved.");
      setNotes("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not submit the preference."); }
    finally { setBusy(false); }
  }

  async function decide(row: RequestRow, approval: "Approved" | "Rejected") {
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    setBusy(true); setError(""); setMessage("");
    const { error: updateError } = await supabase.from("faculty_availability").update({ approval }).eq("id", row.id).eq("approval", "Pending");
    if (updateError) setError("The request was not updated. It may have changed in another session.");
    else { setMessage(`Request ${approval.toLowerCase()}.`); await load(); }
    setBusy(false);
  }

  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Availability management</div><h2 style={{ marginTop: 5 }}>{isAdmin ? "Review faculty preferences" : "Request a preferred or unavailable time"}</h2></div><Clock3 size={18} color="var(--moss)" /></div>
    <p className="muted">{isAdmin ? "Only approved requests affect scheduling constraints. Check shared resource coverage before approving a hard unavailability." : "Requests remain Pending until an administrator reviews them. A preference is not a direct timetable edit."}</p>
    {isAdmin ? loading ? <div className="empty-state" role="status"><span className="spinner" /> Loading requests…</div> : error ? <div className="alert" role="alert">{error}</div> : rows.length === 0 ? <div className="empty-state"><div className="empty-icon"><Check size={18} /></div><h3>No pending requests</h3><p className="muted small">New teacher requests will appear here.</p></div> : <div className="session-list">{rows.map((row) => { const faculty = Array.isArray(row.faculty) ? row.faculty[0] : row.faculty; return <article className="session-row" key={row.id} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}><div><strong>{faculty?.full_name ?? "Faculty member"} <span className="tag">{faculty?.initials ?? "—"}</span></strong><div className="session-meta">{days[row.day_of_week - 1]} · {String(row.starts_at).slice(0, 5)}–{String(row.ends_at).slice(0, 5)} · {row.status}{row.notes ? ` · ${row.notes}` : ""}</div></div><div className="filter-row"><button className="btn btn-secondary" type="button" disabled={busy} onClick={() => void decide(row, "Approved")}><Check size={13} /> Approve</button><button className="btn btn-ghost" type="button" disabled={busy} onClick={() => void decide(row, "Rejected")}><X size={13} /> Decline</button></div></article>; })}</div> : <form onSubmit={submit} style={{ maxWidth: 560 }}><div className="field"><label htmlFor="availability-type">Request type</label><select className="select" id="availability-type" value={kind} onChange={(event) => setKind(event.target.value)}><option value="Preferred">Preferred teaching time</option><option value="Unavailable">Unavailable time (approval required)</option></select></div><div className="filter-row"><div className="field"><label htmlFor="availability-day">Day</label><select className="select" id="availability-day" value={day} onChange={(event) => setDay(event.target.value)}>{days.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></div><div className="field"><label htmlFor="availability-start">Start</label><input className="input" id="availability-start" type="time" value={start} onChange={(event) => setStart(event.target.value)} required /></div><div className="field"><label htmlFor="availability-end">End</label><input className="input" id="availability-end" type="time" value={end} onChange={(event) => setEnd(event.target.value)} required /></div></div><div className="field"><label htmlFor="availability-notes">Note (optional)</label><input id="availability-notes" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={400} placeholder="Add context for the administrator" /></div>{error && <div className="alert" role="alert">{error}</div>}{message && <div className="notice" role="status">{message}</div>}<button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Submitting…" : "Submit for approval"}</button></form>}
  </section>;
}
