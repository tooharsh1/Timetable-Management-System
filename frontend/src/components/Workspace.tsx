"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import type { AppRole, UserProfile } from "@/lib/supabase-types";
import { TimetableBoard } from "@/components/TimetableBoard";
import { VersionReviewPanel } from "@/components/VersionReviewPanel";
import { PersonalKpis } from "@/components/PersonalKpis";
import { AvailabilityPanel } from "@/components/AvailabilityPanel";
import { AcademicSetupPanel } from "@/components/AcademicSetupPanel";
import { UserAccountsPanel } from "@/components/UserAccountsPanel";
import TimingTemplatePanel from "@/components/TimingTemplatePanel";
import { Activity, BookOpen, CalendarDays, Check, ChevronDown, CircleHelp, Clock3, Download, FileSpreadsheet, FlaskConical, LayoutDashboard, LockKeyhole, LogOut, MapPin, MoreHorizontal, Plus, Settings2, ShieldCheck, Sparkles, Users, X } from "lucide-react";

type ViewKey = "overview" | "timetable" | "academic" | "settings" | "availability" | "versions" | "users";
type NavItem = { key: ViewKey; label: string; icon: typeof LayoutDashboard };

const roleNames: Record<AppRole, string> = { admin: "Administrator", teacher: "Teacher", student: "Student" };
const navByRole: Record<AppRole, NavItem[]> = {
  admin: [
    { key: "overview", label: "Overview", icon: LayoutDashboard },
    { key: "timetable", label: "Timetable", icon: CalendarDays },
    { key: "academic", label: "Academic setup", icon: BookOpen },
    { key: "availability", label: "Availability", icon: Clock3 },
    { key: "versions", label: "Versions & review", icon: Activity },
    { key: "settings", label: "Timing settings", icon: Settings2 },
    { key: "users", label: "User access", icon: Users },
  ],
  teacher: [
    { key: "overview", label: "Today & week", icon: LayoutDashboard },
    { key: "timetable", label: "My timetable", icon: CalendarDays },
    { key: "availability", label: "Availability", icon: Clock3 },
  ],
  student: [
    { key: "overview", label: "Today", icon: LayoutDashboard },
    { key: "timetable", label: "Class timetable", icon: CalendarDays },
  ],
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "RG";
}

export function Workspace({ role, profile }: { role: AppRole; profile: UserProfile }) {
  const router = useRouter();
  const [view, setView] = useState<ViewKey>("overview");
  const [day, setDay] = useState("Monday");
  const [period, setPeriod] = useState<"week" | "day">("week");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState("");
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const nav = navByRole[role];
  const fullName = profile.full_name || roleNames[role];
  const firstName = fullName.split(" ")[0];
  const activeTitle = nav.find((item) => item.key === view)?.label ?? "Overview";

  useEffect(() => {
    if (role !== "admin" || !jobId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/timetable/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Could not read generation status.");
        if (result.status === "finished") {
          stopped = true;
          setJobId("");
          setBusy(false);
          if (result.error) setError(result.error);
          setNotice(result.message ?? `Solver finished with ${result.outcome}.`);
          router.refresh();
        } else if (!stopped) {
          setNotice(`Solver status: ${result.status ?? "running"}. No partial schedule will be shown as complete.`);
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : "Could not check generation progress.");
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1800);
    void poll();
    return () => { stopped = true; window.clearInterval(timer); };
  }, [jobId, role, router]);

  const subtitle = useMemo(() => {
    if (role === "admin") return "A steady view of setup, scheduling, and what needs attention.";
    if (role === "teacher") return "Your approved teaching schedule and the week ahead.";
    return "Your latest published class and batch schedule.";
  }, [role]);

  async function signOut() {
    const supabase = getBrowserSupabase();
    await supabase?.auth.signOut();
    router.replace("/");
    router.refresh();
  }

  async function generateTimetable() {
    setBusy(true); setError(""); setNotice(""); setJobId("");
    try {
      const response = await fetch("/api/timetable/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: "current-academic-period" }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Generation could not be started.");
      setJobId(result.job_id ?? result.jobId ?? "");
      setNotice(result.message ?? "Generation started. Results will appear after independent validation.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "An unexpected generation error occurred.");
    } finally { setBusy(false); }
  }

  async function downloadTimetable(format: "pdf" | "xlsx", scope?: { semesterId: string; versionId: string }) {
    setError("");
    try {
      const params = new URLSearchParams({ format });
      if (scope) { params.set("semester_id", scope.semesterId); params.set("version_id", scope.versionId); }
      const response = await fetch(`/api/timetable/export?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error ?? "No timetable is available to export yet."); }
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `rgit-timetable.${format}`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The export could not be downloaded."); }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Main navigation">
        <a href="/" className="brand"><span className="brand-mark"><img src="/rgit-mark.svg" alt="" /></span><span className="brand-copy brand-name">RGIT <span className="brand-sub">Timetable office</span></span></a>
        <div><div className="nav-label">Workspace</div><nav className="nav-list" aria-label="Workspace sections">
          {nav.map(({ key, label, icon: Icon }) => <button className="nav-link" key={key} type="button" onClick={() => setView(key)} aria-current={view === key ? "page" : undefined} title={label}><Icon className="nav-icon" size={17} aria-hidden="true" /><span className="nav-text">{label}</span></button>)}
        </nav></div>
        <div className="sidebar-bottom"><strong>Academic year · 2025–26</strong><span>Semester II · RGIT Mumbai</span></div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="mobile-menu"><img src="/rgit-mark.svg" alt="" width="29" height="29" /> RGIT <span className="breadcrumb">/ {activeTitle}</span></div>
          <div className="breadcrumb">Rajiv Gandhi Institute of Technology <span aria-hidden="true">/</span> {activeTitle}</div>
          <div className="top-actions"><span className="tag"><span className="status-dot" /> {roleNames[role]}</span><span className="avatar" aria-label={`Signed in as ${fullName}`}>{profile.initials || initials(fullName)}</span><button className="btn btn-ghost" type="button" onClick={signOut} aria-label="Sign out"><LogOut size={14} /> <span className="nav-text">Sign out</span></button></div>
        </header>
        <section className="page-heading">
          <div><div className="eyebrow">{roleNames[role]} workspace · Semester II</div><h1>{view === "overview" ? `Good day, ${firstName}.` : activeTitle}</h1><p className="subtitle">{subtitle}</p></div>
          {role === "admin" && <button type="button" className="btn btn-primary" onClick={generateTimetable} disabled={busy || Boolean(jobId)} aria-busy={busy || Boolean(jobId)}>{busy || jobId ? <span className="spinner" aria-hidden="true" /> : <Sparkles size={15} />} {busy ? "Checking schedule inputs…" : jobId ? "Generating…" : "Generate timetable"}</button>}
        </section>
        {notice && <div className="notice" role="status" style={{ marginBottom: 13 }}>{notice}{jobId && <span> Job <code>{jobId.slice(0, 10)}</code> has been queued for the solver.</span>}</div>}
        {error && <div className="alert" role="alert" style={{ marginBottom: 13 }}>{error}</div>}
        {role === "admin" ? <AdminContent view={view} onGenerate={generateTimetable} onDownload={downloadTimetable} onNavigate={setView} busy={busy || Boolean(jobId)} /> : <PersonalContent role={role} view={view} day={day} setDay={setDay} period={period} setPeriod={setPeriod} onDownload={downloadTimetable} />}
      </main>
      <nav className="mobile-nav" aria-label="Mobile workspace navigation">{nav.slice(0, 4).map(({ key, label, icon: Icon }) => <button key={key} type="button" onClick={() => { setView(key); setMobileMoreOpen(false); }} aria-current={view === key ? "page" : undefined}><Icon size={17} aria-hidden="true" /><span>{label.split(" ")[0]}</span></button>)}{nav.length > 4 && <><button type="button" aria-expanded={mobileMoreOpen} aria-controls="mobile-more-menu" onClick={() => setMobileMoreOpen((open) => !open)}><MoreHorizontal size={17} aria-hidden="true" /><span>More</span></button>{mobileMoreOpen && <div className="mobile-nav-more" id="mobile-more-menu" role="menu" aria-label="More workspace sections">{nav.slice(4).map(({ key, label, icon: Icon }) => <button key={key} type="button" role="menuitem" onClick={() => { setView(key); setMobileMoreOpen(false); }}><Icon size={16} aria-hidden="true" />{label}</button>)}</div>}</>}</nav>
    </div>
  );
}

function AdminContent({ view, onGenerate, onDownload, onNavigate, busy }: { view: ViewKey; onGenerate: () => void; onDownload: (format: "pdf" | "xlsx", scope?: { semesterId: string; versionId: string }) => void; onNavigate: (view: ViewKey) => void; busy: boolean }) {
  const [overview, setOverview] = useState({ counts: [0, 0, 0, 0, 0], status: "Loading…", conflicts: "—", published: false, workload: "—", versions: [] as { id: string; status: string; revision: number; label: string }[], loading: true });
  useEffect(() => {
    if (view !== "overview") return;
    let cancelled = false;
    async function load() {
      const supabase = getBrowserSupabase();
      if (!supabase) { if (!cancelled) setOverview({ counts: [0, 0, 0, 0, 0], status: "Database not configured", conflicts: "—", published: false, workload: "—", versions: [], loading: false }); return; }
      try {
        const countQuery = (table: string) => supabase.from(table).select("id", { count: "exact", head: true });
        const [departments, requirements, faculty, rooms, timings, published, jobs, workload, versions] = await Promise.all([
          countQuery("departments"), countQuery("subject_requirements"), countQuery("faculty"), countQuery("rooms"), countQuery("timing_templates"),
          supabase.from("timetable_versions").select("id").eq("status", "Published").limit(1),
          supabase.from("generation_jobs").select("status,diagnostics").order("created_at", { ascending: false }).limit(1),
          countQuery("faculty_workload_limits"),
          supabase.from("timetable_versions").select("id,status,revision,label").order("revision", { ascending: false }).limit(3),
        ]);
        const counts = [departments.count ?? 0, requirements.count ?? 0, faculty.count ?? 0, rooms.count ?? 0, timings.count ?? 0];
        const latest = jobs.data?.[0];
        const details = (latest?.diagnostics ?? {}) as Record<string, any>;
        const diagnosticRows = details.solver_diagnostics ?? details.diagnostics ?? [];
        const conflicts = Array.isArray(diagnosticRows) ? diagnosticRows.filter((item: any) => item.severity !== "info").length : 0;
        const status = latest?.status ? String(latest.status).replaceAll("_", " ") : "Not generated";
        const workloadText = `${workload.count ?? 0} limit records · ${faculty.count ?? 0} faculty`;
        const recentVersions = (versions.data ?? []).map((item: any) => ({ id: String(item.id), status: String(item.status), revision: Number(item.revision), label: String(item.label ?? "Timetable revision") }));
        if (!cancelled) setOverview({ counts, status, conflicts: String(conflicts), published: Boolean(published.data?.length), workload: workloadText, versions: recentVersions, loading: false });
      } catch {
        if (!cancelled) setOverview({ counts: [0, 0, 0, 0, 0], status: "Data unavailable", conflicts: "—", published: false, workload: "—", versions: [], loading: false });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [view]);
  if (view === "timetable") return <TimetableBoard role="admin" onDownload={onDownload} />;
  if (view === "academic") return <AcademicSetupPanel />;
  if (view === "settings") return <TimingTemplatePanel />;
  if (view === "availability") return <AvailabilityPanel role="admin" />;
  if (view === "users") return <UserAccountsPanel />;
  if (view === "versions") return <VersionReviewPanel />;
  return <>
    <div className="kpi-grid">
      <div className="card kpi"><div className="kpi-label">Setup completeness</div><div className="kpi-value">{overview.counts.filter((count) => count > 0).length}<span style={{ fontSize: 15, color: "var(--muted)" }}> / 5</span></div><div className="kpi-note">Departments, requirements, faculty, rooms, timing</div></div>
      <div className="card kpi"><div className="kpi-label">Scheduling status</div><div className="kpi-value" style={{ fontFamily: "inherit", fontSize: 18, marginTop: 15 }}>{overview.status}</div><div className="kpi-note">{overview.loading ? "Refreshing from the database" : "Latest generation job"}</div></div>
      <div className="card kpi"><div className="kpi-label">Unresolved conflicts</div><div className="kpi-value">{overview.conflicts}</div><div className="kpi-note">Latest solver diagnostics</div></div>
      <div className="card kpi"><div className="kpi-label">Publication</div><div className="kpi-value" style={{ fontFamily: "inherit", fontSize: 18, marginTop: 15 }}>{overview.published ? "Published" : "No published version"}</div><div className="kpi-note">{overview.published ? "Teachers and students see published sessions" : "Drafts remain private"}</div></div>
    </div>
    <div className="dashboard-grid">
      <section className="card">
        <div className="card-title"><div><div className="eyebrow">Scheduling desk</div><h2 style={{ marginTop: 5 }}>Your next steps</h2></div><span className={`tag ${overview.counts.filter((count) => count > 0).length === 5 ? "" : "amber"}`}>{overview.counts.filter((count) => count > 0).length === 5 ? "Setup present" : "Setup needed"}</span></div>
        <div className="checklist">
          {["Academic structure", "Subject requirements", "Faculty & rooms", "Timing template"].map((label, index) => { const done = overview.counts[[0, 1, 2, 4][index]] > 0; return <div className="check-item" key={label}><span className={`check-mark ${done ? "" : "pending"}`}>{done ? <Check size={12} /> : index + 1}</span><span><strong>{label}</strong><br /><span className="muted">{["Add departments, classes, divisions, batches, and programmes.", "Set weekly subjects, session types, durations, and participating groups.", "Set faculty eligibility, room capacities, labs, and availability.", "Configure working days, periods, breaks, and fixed activities."][index]}</span></span></div>; })}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}><button className="btn btn-secondary" type="button" onClick={() => onNavigate("academic")}>Open academic setup <BookOpen size={14} /></button><button className="btn btn-primary" type="button" onClick={onGenerate} disabled={busy}>{busy ? "Checking…" : "Generate timetable"} <Sparkles size={14} /></button></div>
      </section>
      <section className="card">
        <div className="card-title"><div><div className="eyebrow">Review queue</div><h2 style={{ marginTop: 5 }}>Schedule versions</h2></div><button className="btn btn-ghost" type="button" onClick={() => onNavigate("versions")}>Open review <ShieldCheck size={15} /></button></div>
        {overview.versions.length ? <div className="checklist">{overview.versions.map((version) => <div className="check-item" key={version.id}><span className={`tag ${version.status === "Draft" || version.status === "Under Review" ? "amber" : ""}`}>{version.status}</span><span><strong>Revision {version.revision} · {version.label}</strong><br /><span className="muted small">Open Versions &amp; review to validate, compare, approve, or publish.</span></span></div>)}</div> : <div className="empty-state" style={{ padding: "24px 12px" }}><div className="empty-icon"><CalendarDays size={19} /></div><h3>No schedule yet</h3><p className="muted small" style={{ marginBottom: 0 }}>Complete the setup steps, then generate a draft. A draft stays hidden until it is approved and published.</p></div>}
        <div className="card-title" style={{ marginTop: 17, marginBottom: 8 }}><span className="muted small">Faculty workload coverage</span><Users size={15} color="var(--moss)" /></div><p className="muted small" style={{ marginBottom: 0 }}>{overview.workload}. The solver never treats a timeout as proof of infeasibility.</p>
      </section>
    </div>
  </>;
}

function AcademicSetup() {
  const [active, setActive] = useState("Departments");
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const categories = ["Departments", "Classes & batches", "Subjects", "Faculty", "Rooms & labs"];
  async function addRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSaved(false);
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured. Set up the database to save academic records."); return; }
    const table: Record<string, string> = { Departments: "departments", "Classes & batches": "classes", Subjects: "subjects", Faculty: "faculty", "Rooms & labs": "rooms" };
    const column: Record<string, string> = { Departments: "name", "Classes & batches": "name", Subjects: "name", Faculty: "full_name", "Rooms & labs": "name" };
    const { error: saveError } = await supabase.from(table[active]).insert({ [column[active]]: name.trim() });
    if (saveError) { setError(saveError.message.includes("permission") ? "Your account cannot add this record." : "The record could not be saved. Check required fields and database setup."); return; }
    setName(""); setSaved(true);
  }
  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Academic master data</div><h2 style={{ marginTop: 5 }}>Build the scheduling scope</h2></div><span className="tag">Admin only</span></div><p className="muted">Set up related records before generating. Faculty and rooms are shared resources across the selected departments.</p><div className="filter-row" role="tablist" aria-label="Academic data type">{categories.map((item) => <button className={`btn ${active === item ? "btn-primary" : "btn-ghost"}`} key={item} role="tab" aria-selected={active === item} type="button" onClick={() => { setActive(item); setSaved(false); }}>{item}</button>)}</div><form onSubmit={addRecord} style={{ maxWidth: 560, marginTop: 22 }}><div className="field"><label htmlFor="record-name">{active === "Faculty" ? "Faculty full name" : `${active} name`}</label><input id="record-name" required value={name} onChange={(event) => setName(event.target.value)} placeholder={active === "Departments" ? "e.g. Computer Engineering" : "Enter a name"} /></div>{error && <div className="alert" role="alert">{error}</div>}{saved && <div className="notice" role="status">Saved. Add the remaining eligibility, timing, and relationship details before generation.</div>}<button className="btn btn-primary" type="submit"><Plus size={14} /> Add {active.toLowerCase().replace(/s$/, "")}</button></form><div className="notice" style={{ marginTop: 20 }}>Record creation checks your signed-in profile and database policy. Role selection alone never grants write access.</div></section>;
}

function TimingSettings() {
  const [days, setDays] = useState(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  const [start, setStart] = useState("08:30");
  const [end, setEnd] = useState("16:30");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  function toggle(day: string) { setDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day]); setSaved(false); }
  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaved(false); setError("");
    if (!days.length) { setError("Choose at least one working day."); return; }
    if (start >= end) { setError("The day end time must be later than the start time."); return; }
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured. Timing changes cannot be persisted yet."); return; }
    const { error: saveError } = await supabase.from("timing_templates").upsert({ name: "RGIT default", working_days: days, start_time: start, end_time: end }, { onConflict: "name" });
    if (saveError) setError("Timing settings were not saved. Add periods and break intervals after configuring the database."); else setSaved(true);
  }
  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Configurable teaching week</div><h2 style={{ marginTop: 5 }}>Timing templates</h2></div><Settings2 size={18} color="var(--moss)" /></div><form onSubmit={saveSettings} style={{ maxWidth: 680 }}><div className="field"><label>Working days</label><div className="filter-row">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => <button key={day} type="button" className={`btn ${days.includes(day) ? "btn-primary" : "btn-ghost"}`} aria-pressed={days.includes(day)} onClick={() => toggle(day)}>{day.slice(0, 3)}</button>)}</div></div><div className="filter-row" style={{ marginTop: 16 }}><div className="field"><label htmlFor="day-start">Start</label><input className="input" id="day-start" type="time" value={start} onChange={(event) => setStart(event.target.value)} required /></div><div className="field"><label htmlFor="day-end">End</label><input className="input" id="day-end" type="time" value={end} onChange={(event) => setEnd(event.target.value)} required /></div></div><p className="muted small">Period-by-period definitions, breaks, laboratory durations, blocked intervals, daily load limits, and shift-specific templates are part of the full settings model.</p>{error && <div className="alert" role="alert">{error}</div>}{saved && <div className="notice" role="status">Timing template saved.</div>}<button className="btn btn-primary" type="submit">Save timing template</button></form></section>;
}

function AvailabilityBoard() {
  const [preference, setPreference] = useState("Prefer morning");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setSubmitted(false);
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured. Availability cannot be submitted yet."); return; }
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) { setError("Please sign in again to submit a preference."); return; }
    const { error: saveError } = await supabase.from("availability_requests").insert({ user_id: auth.user.id, preference, status: "pending" });
    if (saveError) setError("Could not submit the preference. Try again or contact the administrator."); else setSubmitted(true);
  }
  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Availability preferences</div><h2 style={{ marginTop: 5 }}>Share a preference, not a schedule change</h2></div><Clock3 size={18} color="var(--moss)" /></div><p className="muted">Teacher requests remain pending until an administrator reviews them. Hard availability is managed by the academic office.</p><form onSubmit={submit} style={{ maxWidth: 500 }}><div className="field"><label htmlFor="preference">Preferred timing</label><select className="select" id="preference" value={preference} onChange={(event) => setPreference(event.target.value)}><option>Prefer morning</option><option>Prefer afternoon</option><option>Avoid first period</option><option>Keep one weekday lighter</option></select></div>{error && <div className="alert" role="alert">{error}</div>}{submitted && <div className="notice" role="status">Preference submitted for administrator review.</div>}<button className="btn btn-primary" type="submit"><Check size={14} /> Submit preference</button></form></section>;
}

function VersionsReview() {
  const [message, setMessage] = useState("");
  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Version control</div><h2 style={{ marginTop: 5 }}>Drafts, review, and publication</h2></div><span className="tag amber">No version</span></div><div className="notice">Generated drafts stay private to administrators. Editing an approved draft invalidates its approval and triggers validation again.</div><div className="empty-state" style={{ marginTop: 18 }}><div className="empty-icon"><Activity size={19} /></div><h3>Nothing in review</h3><p className="muted small">Generate and independently validate a timetable before submitting it for administrator review.</p><button className="btn btn-secondary" type="button" onClick={() => setMessage("Add and validate academic requirements before generating a draft.")}>Check review requirements</button>{message && <p role="status" className="muted small" style={{ marginTop: 10 }}>{message}</p>}</div></section>;
}

function PersonalContent({ role, view, day, setDay, period, setPeriod, onDownload }: { role: "teacher" | "student"; view: ViewKey; day: string; setDay: (day: string) => void; period: "week" | "day"; setPeriod: (period: "week" | "day") => void; onDownload: (format: "pdf" | "xlsx") => void }) {
  const [filter, setFilter] = useState("All sessions");
  const sessionTypeFilter = filter === "Lectures" ? "theory" : filter === "Tutorials" ? "tutorial" : filter === "Practicals" ? "lab" : filter === "Electives" ? "elective" : "";
  return <>
    <PersonalKpis role={role} />
    <div className="workspace-toolbar"><div className="filter-row"><button className={`btn ${period === "week" ? "btn-primary" : "btn-ghost"}`} type="button" onClick={() => setPeriod("week")}>Week view</button><button className={`btn ${period === "day" ? "btn-primary" : "btn-ghost"}`} type="button" onClick={() => setPeriod("day")}>Day view</button><select className="select" value={day} onChange={(event) => setDay(event.target.value)} aria-label="Choose day">{["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((name) => <option key={name}>{name}</option>)}</select>{role === "student" && <select className="select" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter session type"><option>All sessions</option><option>Lectures</option><option>Tutorials</option><option>Practicals</option><option>Electives</option></select>}</div><div className="filter-row"><button className="btn btn-ghost" type="button" onClick={() => onDownload("pdf")}><Download size={14} /> PDF</button><button className="btn btn-ghost" type="button" onClick={() => onDownload("xlsx")}><FileSpreadsheet size={14} /> Spreadsheet</button></div></div>
    {view === "availability" && role === "teacher" ? <AvailabilityPanel role="teacher" /> : <TimetableBoard role={role} onDownload={onDownload} day={period === "day" ? day : undefined} sessionTypeFilter={role === "student" ? sessionTypeFilter : ""} />}
  </>;
}

function TimetableView({ onDownload, day }: { onDownload: (format: "pdf" | "xlsx") => void; day?: string }) {
  const days = day ? [day] : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">{day ? `${day} view` : "Weekly view"}</div><h2 style={{ marginTop: 5 }}>Published timetable</h2></div><div className="filter-row"><button type="button" className="btn btn-ghost" onClick={() => onDownload("pdf")}><Download size={14} /> Download PDF</button><button type="button" className="btn btn-ghost" onClick={() => onDownload("xlsx")}><FileSpreadsheet size={14} /> XLSX</button></div></div><div className="empty-state"><div className="empty-icon"><CalendarDays size={19} /></div><h3>No published sessions yet</h3><p className="muted small" style={{ maxWidth: 440, margin: "0 auto 14px" }}>When the academic office publishes a validated schedule, your class or personal sessions will appear here. Draft timetables are never shown in this view.</p><div className="tag"><span className="status-dot" /> Published data only</div></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 15 }}><span className="muted small">{days.join(" · ")}</span><span className="tag"><BookOpen size={11} /> Subject legend loads with schedule</span><span className="tag amber"><Users size={11} /> Faculty legend loads with schedule</span><span className="tag"><MapPin size={11} /> Rooms and labs</span><span className="tag clay"><FlaskConical size={11} /> Practical blocks</span></div></section>;
}
