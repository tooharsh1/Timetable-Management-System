"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, CalendarDays, Check, Clock3, Download, FileSpreadsheet, Filter, FlaskConical, Lock, MapPin, Printer, RefreshCw, Settings2, Unlock, Users, X } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import type { AppRole } from "@/lib/supabase-types";

type SessionRow = {
  id: string; day: string; start: string; end: string; subjectCode: string; subject: string; type: string;
  faculty: string; facultyId: string; room: string; roomId: string; groups: { id: string; name: string; type: string }[];
  departmentId: string; department: string; duration: number; locked: boolean; lockReason: string; solverId?: string;
};
type Semester = { id: string; name: string };
type Version = { id: string; status: string; revision: number; label?: string };
type Choice = { id: string; label: string; detail?: string };
type RepairOptions = { days: { id: string; label: string }[]; starts: string[]; faculty: Choice[]; rooms: Choice[]; groups: Choice[] };
type PreviewChange = { session_id: string; subject?: string; day?: string; time?: string; room?: string; faculty?: string; groups?: string[]; requested?: boolean };
type RepairPreview = { proposal_id: string; changed?: PreviewChange[]; removed?: string[]; unchanged_count?: number; message?: string };
type RepairError = { kind: "timeout" | "infeasible" | "error"; message: string };

function rel(value: any) { return Array.isArray(value) ? value[0] ?? {} : value ?? {}; }
function parseNotes(value: unknown) { try { return JSON.parse(String(value ?? "{}")); } catch { return {}; } }
const DAY_NAMES: Record<number, string> = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };
const DAYS = Object.entries(DAY_NAMES).map(([id, label]) => ({ id, label }));
const VERSION_KEY = "rgit:timetable:selected-version";

async function postJson(path: string, body: unknown, timeoutMs = 50_000): Promise<{ ok: boolean; status: number; payload: any; timedOut: boolean }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, payload, timedOut: false };
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "AbortError";
    return { ok: false, status: 0, payload: { error: timedOut ? "The request timed out." : "The request could not be completed." }, timedOut };
  } finally { window.clearTimeout(timer); }
}

function formatChoice(id: unknown, choices: Choice[], fallback = "—") {
  const found = choices.find((item) => item.id === String(id));
  return found?.label ?? (id ? String(id) : fallback);
}

export function TimetableBoard({ role, day, onDownload, sessionTypeFilter = "" }: { role: AppRole; day?: string; onDownload: (format: "pdf" | "xlsx", scope?: { semesterId: string; versionId: string }) => void; sessionTypeFilter?: string }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [semesterId, setSemesterId] = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [versionStatus, setVersionStatus] = useState("");
  const [adminDay, setAdminDay] = useState("Week");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [filters, setFilters] = useState({ department: "", group: "", batch: "", faculty: "", room: "", type: "" });
  const [lockReasons, setLockReasons] = useState<Record<string, string>>({});
  const [busySessionId, setBusySessionId] = useState("");
  const [repairSession, setRepairSession] = useState<SessionRow | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairOptions, setRepairOptions] = useState<RepairOptions | null>(null);
  const [repairOptionsLoading, setRepairOptionsLoading] = useState(false);
  const [repairForm, setRepairForm] = useState({ dayId: "1", startsAt: "", roomId: "", facultyId: "", groupIds: [] as string[] });
  const [repairPreview, setRepairPreview] = useState<RepairPreview | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [repairError, setRepairError] = useState<RepairError | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [draggedSessionId, setDraggedSessionId] = useState("");
  const isAdmin = role === "admin";
  const canEditDraft = isAdmin && versionStatus === "Draft";
  const selectedDay = day ?? (isAdmin && adminDay !== "Week" ? adminDay : "");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(""); setActionError("");
      const supabase = getBrowserSupabase();
      if (!supabase) { setError("Supabase is not configured. Published schedules cannot be loaded."); setSessions([]); setLoading(false); return; }
      try {
        if (isAdmin) {
          const { data: semesterRows, error: semesterError } = await supabase.from("semesters").select("id,name,is_active,starts_on").order("starts_on", { ascending: false });
          if (semesterError) throw new Error("Could not load academic periods.");
          const available = (semesterRows ?? []).map((item: any) => ({ id: String(item.id), name: String(item.name) }));
          if (!cancelled) setSemesters(available);
          const activeId = semesterId || String(semesterRows?.find((item: any) => item.is_active)?.id ?? semesterRows?.[0]?.id ?? "");
          if (!activeId) { if (!cancelled) { setSessions([]); setVersions([]); setVersionStatus(""); } return; }
          if (!semesterId && !cancelled) setSemesterId(activeId);
          const { data: versionRows, error: versionError } = await supabase.from("timetable_versions").select("id,status,revision,label").eq("semester_id", activeId).in("status", ["Draft", "Under Review", "Published"]).order("revision", { ascending: false });
          if (versionError) throw new Error("Could not load the schedule versions.");
          const availableVersions = (versionRows ?? []).map((item: any) => ({ id: String(item.id), status: String(item.status), revision: Number(item.revision ?? 0), label: item.label ? String(item.label) : undefined }));
          if (!cancelled) setVersions(availableVersions);
          let stored = "";
          try { stored = window.localStorage.getItem(`${VERSION_KEY}:${activeId}`) ?? ""; } catch { /* storage may be disabled */ }
          const chosen = availableVersions.find((item) => item.id === selectedVersionId) ?? availableVersions.find((item) => item.id === stored) ?? availableVersions[0];
          if (!chosen) { if (!cancelled) { setSessions([]); setVersionStatus(""); setSelectedVersionId(""); } return; }
          if (!cancelled && selectedVersionId !== chosen.id) setSelectedVersionId(chosen.id);
          try { window.localStorage.setItem(`${VERSION_KEY}:${activeId}`, chosen.id); } catch { /* storage may be disabled */ }
          if (!cancelled) setVersionStatus(chosen.status);
          const { data, error: dataError } = await supabase.from("timetable_sessions").select("id,day_of_week,starts_at,ends_at,duration_periods,session_type,faculty_id,room_id,notes,subjects(code,name,short_name,department_id,departments(name)),faculty(initials,full_name),rooms(code,name),session_participants(group_id,student_groups(id,name,group_type)),session_locks(id,lock_reason)").eq("version_id", chosen.id).order("day_of_week").order("starts_at");
          if (dataError) throw new Error("Could not load timetable sessions.");
          const parsed = (data ?? []).map((row: any) => {
            const subject = rel(row.subjects); const faculty = rel(row.faculty); const room = rel(row.rooms); const department = rel(subject.departments); const notes = parseNotes(row.notes);
            const groupRows = (row.session_participants ?? []).map((item: any) => rel(item.student_groups)).filter((item: any) => item.id);
            const lock = Array.isArray(row.session_locks) ? row.session_locks[0] : row.session_locks;
            return { id: String(row.id), day: DAY_NAMES[Number(row.day_of_week)] ?? "—", start: String(row.starts_at).slice(0, 5), end: String(row.ends_at).slice(0, 5), subjectCode: String(subject.code ?? ""), subject: String(subject.short_name ?? subject.name ?? ""), type: String(row.session_type).toLowerCase(), faculty: String(faculty.initials ?? faculty.full_name ?? "—"), facultyId: String(row.faculty_id ?? ""), room: String(room.code ?? room.name ?? "—"), roomId: String(row.room_id ?? ""), groups: groupRows.map((item: any) => ({ id: String(item.id), name: String(item.name), type: String(item.group_type) })), departmentId: String(subject.department_id ?? ""), department: String(department.name ?? ""), duration: Number(row.duration_periods ?? 1), locked: Boolean(lock), lockReason: String(lock?.lock_reason ?? (notes.lock_preserved ? "Preserved by the scheduling engine" : "")), solverId: notes.solver_session_id ? String(notes.solver_session_id) : undefined } satisfies SessionRow;
          });
          if (!cancelled) setSessions(parsed);
        } else {
          const { data: activeSemesters, error: semesterError } = await supabase.from("semesters").select("id").eq("is_active", true).order("starts_on", { ascending: false }).limit(1);
          if (semesterError) throw new Error("Could not load your active semester.");
          const activeSemesterId = String(activeSemesters?.[0]?.id ?? "");
          if (!activeSemesterId) { if (!cancelled) { setSessions([]); setVersionStatus("Published"); } return; }
          const { data, error: dataError } = await supabase.from("published_schedule").select("session_id,subject_code,subject_name,session_type,day_of_week,starts_at,ends_at,duration_periods,faculty_initials,faculty_id,room_code,room_name,room_id,participant_groups").eq("semester_id", activeSemesterId).order("day_of_week").order("starts_at");
          if (dataError) throw new Error("Could not load your published timetable.");
          const parsed = (data ?? []).map((row: any) => ({ id: String(row.session_id), day: DAY_NAMES[Number(row.day_of_week)] ?? "—", start: String(row.starts_at).slice(0, 5), end: String(row.ends_at).slice(0, 5), subjectCode: String(row.subject_code ?? ""), subject: String(row.subject_name ?? ""), type: String(row.session_type).toLowerCase(), faculty: String(row.faculty_initials ?? "—"), facultyId: String(row.faculty_id ?? ""), room: String(row.room_code ?? row.room_name ?? "—"), roomId: String(row.room_id ?? ""), groups: String(row.participant_groups ?? "").split(", ").filter(Boolean).map((name: string, index: number) => ({ id: String(index), name, type: "" })), departmentId: "", department: "", duration: Number(row.duration_periods ?? 1), locked: false, lockReason: "" } satisfies SessionRow));
          if (!cancelled) { setSessions(parsed); setVersionStatus("Published"); }
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Schedule could not be loaded.");
      } finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [isAdmin, semesterId, reloadToken]);

  const options = useMemo(() => {
    const groups = [...new Map(sessions.flatMap((session) => session.groups.map((group) => [group.id, group] as const))).values()];
    return {
      departments: [...new Map(sessions.filter((s) => s.departmentId).map((s) => [s.departmentId, s.department || s.departmentId])).entries()],
      classes: groups.filter((group) => ["Class", "Division", "Elective"].includes(group.type)).map((group) => [group.id, group.name] as const),
      batches: groups.filter((group) => group.type === "Batch").map((group) => [group.id, group.name] as const),
      faculty: [...new Map(sessions.filter((s) => s.facultyId).map((s) => [s.facultyId, s.faculty])).entries()],
      rooms: [...new Map(sessions.filter((s) => s.roomId).map((s) => [s.roomId, s.room])).entries()],
      subjects: [...new Map(sessions.map((s) => [`${s.subjectCode}:${s.subject}`, { code: s.subjectCode, name: s.subject }] as const)).values()],
      facultyLegend: [...new Map(sessions.filter((s) => s.facultyId).map((s) => [s.facultyId, s.faculty] as const)).entries()],
    };
  }, [sessions]);
  const filtered = useMemo(() => sessions.filter((session) => {
    const groupMatch = !filters.group || session.groups.some((item) => item.id === filters.group);
    const batchMatch = !filters.batch || session.groups.some((item) => item.id === filters.batch && item.type === "Batch");
    return (!filters.department || session.departmentId === filters.department) && groupMatch && batchMatch && (!filters.faculty || session.facultyId === filters.faculty) && (!filters.room || session.roomId === filters.room) && (!filters.type || session.type === filters.type) && (!sessionTypeFilter || session.type === sessionTypeFilter) && (!selectedDay || session.day === selectedDay);
  }), [sessions, filters, selectedDay, sessionTypeFilter]);
  const activeDays = useMemo(() => {
    if (selectedDay) return [selectedDay];
    const found = [...new Set(filtered.map((session) => session.day))];
    return found.length ? found.sort((a, b) => Object.keys(DAY_NAMES).findIndex((key) => DAY_NAMES[Number(key)] === a) - Object.keys(DAY_NAMES).findIndex((key) => DAY_NAMES[Number(key)] === b)) : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  }, [filtered, selectedDay]);

  async function loadRepairOptions() {
    const supabase = getBrowserSupabase();
    if (!supabase || !semesterId) { setRepairError({ kind: "error", message: "The selected semester is not available for reconfiguration." }); return; }
    setRepairOptionsLoading(true); setRepairError(null);
    try {
      const { data: mapping, error: mappingError } = await supabase.from("semester_timing_templates").select("timing_template_id").eq("semester_id", semesterId).maybeSingle();
      if (mappingError || !mapping?.timing_template_id) throw new Error("The selected semester has no active timing template.");
      const [facultyResult, roomResult, periodResult, groupResult] = await Promise.all([
        supabase.from("faculty").select("id,full_name,initials").eq("active", true).order("full_name"),
        supabase.from("rooms").select("id,name,code").eq("is_active", true).order("name"),
        supabase.from("timing_periods").select("starts_at,kind,sequence_no").eq("timing_template_id", String(mapping.timing_template_id)).order("sequence_no"),
        supabase.from("student_groups").select("id,name,group_type").eq("semester_id", semesterId).order("name"),
      ]);
      if (facultyResult.error || roomResult.error || periodResult.error || groupResult.error) throw new Error("Active faculty, rooms, participant groups, or timing periods could not be loaded.");
      const faculty = (facultyResult.data ?? []).map((item: any) => ({ id: String(item.id), label: String(item.full_name ?? item.initials ?? item.id), detail: item.initials ? String(item.initials) : undefined }));
      const rooms = (roomResult.data ?? []).map((item: any) => ({ id: String(item.id), label: String(item.code ?? item.name ?? item.id), detail: item.name && item.code ? String(item.name) : undefined }));
      const groups = (groupResult.data ?? []).map((item: any) => ({ id: String(item.id), label: String(item.name), detail: String(item.group_type ?? "").toLowerCase() }));
      const starts = [...new Set((periodResult.data ?? []).filter((item: any) => String(item.kind ?? "").toLowerCase() !== "break").map((item: any) => String(item.starts_at).slice(0, 5)))];
      if (!starts.length) throw new Error("The active timing template has no enabled teaching period starts.");
      setRepairOptions({ days: DAYS, starts, faculty, rooms, groups });
      setRepairForm((current) => ({ ...current, startsAt: starts.includes(current.startsAt) ? current.startsAt : starts[0], facultyId: faculty.some((item) => item.id === current.facultyId) ? current.facultyId : faculty[0]?.id ?? "", roomId: rooms.some((item) => item.id === current.roomId) ? current.roomId : rooms[0]?.id ?? "", groupIds: groups.map((item) => item.id).filter((id) => current.groupIds.includes(id)) }));
    } catch (cause) { setRepairError({ kind: "error", message: cause instanceof Error ? cause.message : "Repair options could not be loaded." }); }
    finally { setRepairOptionsLoading(false); }
  }

  function openReconfigure(session: SessionRow, targetDay?: string) {
    if (!canEditDraft || session.locked) return;
    setRepairSession(session); setRepairOpen(true); setRepairPreview(null); setRepairError(null); setAccepted(false);
    setRepairForm({ dayId: String(Object.entries(DAY_NAMES).find(([, name]) => name === (targetDay ?? session.day))?.[0] ?? 1), startsAt: session.start, roomId: session.roomId, facultyId: session.facultyId, groupIds: session.groups.map((group) => group.id) });
    void loadRepairOptions();
  }

  function closeRepair() {
    setRepairOpen(false); setRepairSession(null); setRepairPreview(null); setRepairError(null); setAccepted(false);
  }

  async function previewRepair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repairSession || !selectedVersionId) return;
    setRepairBusy(true); setRepairError(null); setRepairPreview(null); setAccepted(false);
    const result = await postJson("/api/timetable/repair", { action: "preview", version_id: selectedVersionId, session_id: repairSession.id, day_id: repairForm.dayId, starts_at: repairForm.startsAt, room_id: repairForm.roomId, faculty_id: repairForm.facultyId, group_ids: repairForm.groupIds });
    setRepairBusy(false);
    if (!result.ok) { setRepairError(classifyRepairError(result)); return; }
    setRepairPreview(result.payload as RepairPreview);
  }

  async function commitRepair() {
    if (!repairPreview?.proposal_id || !accepted) return;
    setRepairBusy(true); setRepairError(null);
    const result = await postJson("/api/timetable/repair", { action: "commit", proposal_id: repairPreview.proposal_id });
    setRepairBusy(false);
    if (!result.ok) { setRepairError(classifyRepairError(result)); return; }
    closeRepair(); setMessage("Repair accepted and applied. The draft remains unpublished; review and publish it separately."); setReloadToken((value) => value + 1);
  }

  async function toggleLock(session: SessionRow) {
    if (!canEditDraft) return;
    const nextLocked = !session.locked;
    setBusySessionId(session.id); setActionError("");
    const reason = nextLocked ? (lockReasons[session.id]?.trim() || session.lockReason || "Administrator lock") : "";
    const result = await postJson("/api/timetable/lock", { session_id: session.id, locked: nextLocked, reason });
    setBusySessionId("");
    if (!result.ok) { setActionError(result.payload?.error ?? "The session lock could not be changed."); return; }
    setMessage(result.payload?.message ?? (nextLocked ? "Session locked." : "Session unlocked.")); setReloadToken((value) => value + 1);
  }

  return <section className="card fade-in">
    <div className="card-title"><div><div className="eyebrow">{selectedDay ? `${selectedDay} view` : "Weekly view"}</div><h2 style={{ marginTop: 5 }}>{isAdmin ? "Timetable workspace" : "Published timetable"}</h2></div><div className="filter-row">
      {isAdmin && <label className="small muted" htmlFor="admin-day-filter">View <select id="admin-day-filter" className="select" value={adminDay} onChange={(event) => setAdminDay(event.target.value)}><option value="Week">Weekly</option>{DAYS.map((item) => <option key={item.id} value={item.label}>{item.label}</option>)}</select></label>}
      {isAdmin && semesters.length > 0 && <label className="small muted" htmlFor="semester-filter">Semester <select id="semester-filter" className="select" value={semesterId} onChange={(event) => { setSemesterId(event.target.value); setSelectedVersionId(""); setFilters({ department: "", group: "", batch: "", faculty: "", room: "", type: "" }); }}><option value="">Choose semester</option>{semesters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {isAdmin && versions.length > 0 && <label className="small muted" htmlFor="version-filter">Version <select id="version-filter" className="select" value={selectedVersionId} onChange={(event) => { const next = event.target.value; setSelectedVersionId(next); try { window.localStorage.setItem(`${VERSION_KEY}:${semesterId}`, next); } catch { /* storage may be disabled */ } setReloadToken((value) => value + 1); }}><option value="">Choose version</option>{versions.map((item) => <option key={item.id} value={item.id}>Revision {item.revision} · {item.status}</option>)}</select></label>}
      {versionStatus && <span className={`tag ${versionStatus === "Draft" ? "amber" : ""}`}>{versionStatus}</span>}
      <button type="button" className="btn btn-ghost" onClick={() => window.print()}><Printer size={14} /> Print</button>
      <button type="button" className="btn btn-ghost" onClick={() => onDownload("pdf", isAdmin && semesterId && selectedVersionId ? { semesterId, versionId: selectedVersionId } : undefined)}><Download size={14} /> PDF</button><button type="button" className="btn btn-ghost" onClick={() => onDownload("xlsx", isAdmin && semesterId && selectedVersionId ? { semesterId, versionId: selectedVersionId } : undefined)}><FileSpreadsheet size={14} /> XLSX</button>
    </div></div>
    {isAdmin && <div className="filter-row" aria-label="Timetable filters" style={{ margin: "0 0 14px" }}><span className="tag"><Filter size={11} /> Filter</span>
      <label className="sr-only" htmlFor="department-filter">Department</label><select id="department-filter" className="select" value={filters.department} onChange={(event) => setFilters({ ...filters, department: event.target.value })}><option value="">All departments</option>{options.departments.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <label className="sr-only" htmlFor="group-filter">Class or division</label><select id="group-filter" className="select" value={filters.group} onChange={(event) => setFilters({ ...filters, group: event.target.value })}><option value="">All classes / divisions</option>{options.classes.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <label className="sr-only" htmlFor="batch-filter">Practical batch</label><select id="batch-filter" className="select" value={filters.batch} onChange={(event) => setFilters({ ...filters, batch: event.target.value })}><option value="">All practical batches</option>{options.batches.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <label className="sr-only" htmlFor="faculty-filter">Teacher</label><select id="faculty-filter" className="select" value={filters.faculty} onChange={(event) => setFilters({ ...filters, faculty: event.target.value })}><option value="">All teachers</option>{options.faculty.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <label className="sr-only" htmlFor="room-filter">Room</label><select id="room-filter" className="select" value={filters.room} onChange={(event) => setFilters({ ...filters, room: event.target.value })}><option value="">All rooms</option>{options.rooms.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      <label className="sr-only" htmlFor="type-filter">Session type</label><select id="type-filter" className="select" value={filters.type} onChange={(event) => setFilters({ ...filters, type: event.target.value })}><option value="">All session types</option><option value="theory">Lecture</option><option value="tutorial">Tutorial</option><option value="lab">Practical</option><option value="elective">Elective</option></select>
    </div>}
    {message && <div className="notice" role="status" style={{ marginBottom: 14 }}><Check size={14} /> {message}</div>}
    {actionError && <div className="alert" role="alert" style={{ marginBottom: 14 }}>{actionError}</div>}
    {loading ? <div className="empty-state" role="status"><span className="spinner" /> <p style={{ margin: "10px 0 0" }}>Loading the authorized timetable…</p></div> : error ? <div className="alert" role="alert">{error}</div> : filtered.length === 0 ? <div className="empty-state"><div className="empty-icon"><CalendarDays size={19} /></div><h3>{sessions.length ? "No sessions match these filters" : isAdmin ? "No sessions in this version" : "No published sessions yet"}</h3><p className="muted small" style={{ maxWidth: 460, margin: "0 auto" }}>{isAdmin ? "Choose another version or complete academic setup and generate a validated draft." : "Your view shows only your own published sessions. Draft and under-review schedules remain private."}</p></div> : <div className="week-strip" style={{ gridTemplateColumns: `repeat(${Math.min(activeDays.length, 7)}, minmax(145px, 1fr))` }}>
      {activeDays.map((dayName) => {
        const daySessions = filtered.filter((session) => session.day === dayName).sort((a, b) => a.start.localeCompare(b.start));
        const counts = daySessions.reduce<Record<string, number>>((out, session) => { out[session.start] = (out[session.start] ?? 0) + 1; return out; }, {});
        const totalMinutes = daySessions.reduce((total, session) => total + Math.max(0, Number(session.end.slice(0, 2)) * 60 + Number(session.end.slice(3)) - Number(session.start.slice(0, 2)) * 60 - Number(session.start.slice(3))), 0);
        return <div className="day-column" key={dayName} onDragOver={(event) => { if (canEditDraft) event.preventDefault(); }} onDrop={(event) => { if (!canEditDraft) return; event.preventDefault(); const sessionId = event.dataTransfer.getData("text/plain") || draggedSessionId; const session = sessions.find((item) => item.id === sessionId); if (session && !session.locked) openReconfigure(session, dayName); setDraggedSessionId(""); }}><div className="day-name">{dayName}</div><div className="muted small" style={{ marginBottom: 8 }}>{daySessions.length} session{daySessions.length === 1 ? "" : "s"} · {Math.round(totalMinutes / 60 * 10) / 10}h</div>{daySessions.map((session) => <article className={`day-block ${session.type === "lab" ? "clay-block" : session.type === "elective" ? "amber-block" : ""}`} key={session.id} aria-label={`${session.subjectCode} ${session.subject}, ${session.start} to ${session.end}, ${session.day}`} draggable={canEditDraft && !session.locked} onDragStart={(event) => { if (!canEditDraft || session.locked) { event.preventDefault(); return; } event.dataTransfer.setData("text/plain", session.id); event.dataTransfer.effectAllowed = "move"; setDraggedSessionId(session.id); }} onDragEnd={() => setDraggedSessionId("")}>
          <strong>{session.start}–{session.end} · {session.subjectCode || session.subject}</strong><span>{session.subject}</span><span>{session.faculty} · <MapPin size={10} style={{ display: "inline" }} aria-hidden="true" /> {session.room}</span>{session.groups.length > 0 && <span><Users size={10} style={{ display: "inline" }} aria-hidden="true" /> {session.groups.map((group) => group.name).join(", ")}</span>}<span>{session.type === "lab" ? <FlaskConical size={10} style={{ display: "inline" }} aria-hidden="true" /> : <Clock3 size={10} style={{ display: "inline" }} aria-hidden="true" />} {session.type}{session.duration > 1 ? ` · ${session.duration} periods` : ""}{counts[session.start] > 1 ? " · parallel block" : ""}</span>
          {session.locked && <span className="tag amber" title={session.lockReason || "Locked session"}><Lock size={11} /> Locked{session.lockReason ? ` · ${session.lockReason}` : ""}</span>}
          {isAdmin && versionStatus === "Draft" && <div className="filter-row" style={{ marginTop: 9, alignItems: "center" }}>
            <button type="button" className="btn btn-ghost" disabled={session.locked || busySessionId === session.id} onClick={() => openReconfigure(session)} title={session.locked ? "Unlock this session before reconfiguring it" : "Open reconfiguration form"}><Settings2 size={13} /> Reconfigure</button>
            {!session.locked && <label className="sr-only" htmlFor={`lock-reason-${session.id}`}>Lock reason for {session.subject}</label>}
            {!session.locked && <input id={`lock-reason-${session.id}`} className="input" style={{ minWidth: 120, flex: 1 }} value={lockReasons[session.id] ?? ""} onChange={(event) => setLockReasons({ ...lockReasons, [session.id]: event.target.value })} placeholder="Lock reason" />}
            <button type="button" className="btn btn-ghost" disabled={busySessionId === session.id} onClick={() => void toggleLock(session)}>{session.locked ? <><Unlock size={13} /> Unlock</> : <><Lock size={13} /> Lock</>}{busySessionId === session.id && <span className="spinner" aria-label="Saving" />}</button>
          </div>}
        </article>)}</div>;
      })}
    </div>}
    {filtered.length > 0 && <div className="print-legend" style={{ marginTop: 15 }} aria-label="Timetable subject and faculty legends"><div className="filter-row"><strong className="small">Subjects</strong>{options.subjects.map((item) => <span className="tag" key={`${item.code}:${item.name}`}><BookOpenLegend /> {item.code ? `${item.code} · ` : ""}{item.name}</span>)}</div><div className="filter-row" style={{ marginTop: 7 }}><strong className="small">Faculty initials</strong>{options.facultyLegend.map(([id, initials]) => <span className="tag amber" key={id}>{initials}</span>)}<span className="tag clay"><FlaskIcon /> Practical sessions show their full duration</span></div></div>}

    {repairOpen && repairSession && <div role="dialog" aria-modal="true" aria-labelledby="repair-dialog-title" className="card" style={{ marginTop: 18, border: "1px solid var(--line, #d9d9d9)" }}>
      <div className="card-title"><div><div className="eyebrow">Draft-only repair preview</div><h3 id="repair-dialog-title" style={{ marginTop: 5 }}>Reconfigure {repairSession.subjectCode || repairSession.subject}</h3></div><button type="button" className="btn btn-ghost" onClick={closeRepair} disabled={repairBusy} aria-label="Close reconfiguration form"><X size={15} /> Close</button></div>
      <p className="muted small">Choose the participant group(s), a working day, configured period start, eligible faculty member, and active room. Preview does not change timetable data.</p>
      {repairOptionsLoading ? <div role="status" className="empty-state"><span className="spinner" /> Loading active repair options…</div> : <form onSubmit={previewRepair} aria-label="Reconfigure timetable session">
        <div className="filter-row" style={{ alignItems: "end" }}><label>Day<select className="select" value={repairForm.dayId} onChange={(event) => setRepairForm({ ...repairForm, dayId: event.target.value })} required>{(repairOptions?.days ?? DAYS).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>Start time<select className="select" value={repairForm.startsAt} onChange={(event) => setRepairForm({ ...repairForm, startsAt: event.target.value })} required><option value="">Choose start</option>{(repairOptions?.starts ?? []).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>Active faculty<select className="select" value={repairForm.facultyId} onChange={(event) => setRepairForm({ ...repairForm, facultyId: event.target.value })} required><option value="">Choose faculty</option>{(repairOptions?.faculty ?? []).map((item) => <option key={item.id} value={item.id}>{item.label}{item.detail ? ` · ${item.detail}` : ""}</option>)}</select></label>
          <label>Active room<select className="select" value={repairForm.roomId} onChange={(event) => setRepairForm({ ...repairForm, roomId: event.target.value })} required><option value="">Choose room</option>{(repairOptions?.rooms ?? []).map((item) => <option key={item.id} value={item.id}>{item.label}{item.detail ? ` · ${item.detail}` : ""}</option>)}</select></label>
          <button type="submit" className="btn btn-primary" disabled={repairBusy || !repairOptions || !repairForm.startsAt || !repairForm.roomId || !repairForm.facultyId || !repairForm.groupIds.length}><RefreshCw size={14} /> {repairBusy ? "Previewing…" : "Preview repair"}</button>
        </div>
        <fieldset style={{ border: "1px solid var(--line)", borderRadius: 12, padding: 14, marginTop: 14 }}><legend className="small" style={{ padding: "0 6px", fontWeight: 700 }}>Participant group(s)</legend><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, maxHeight: 180, overflowY: "auto" }}>{(repairOptions?.groups ?? []).map((group) => <label key={group.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: 8, borderRadius: 8, background: "var(--cream, #faf8f2)" }}><input type="checkbox" checked={repairForm.groupIds.includes(group.id)} onChange={(event) => setRepairForm((current) => ({ ...current, groupIds: event.target.checked ? [...new Set([...current.groupIds, group.id])] : current.groupIds.filter((id) => id !== group.id) }))} /><span>{group.label}<span className="muted small">{group.detail ? ` · ${group.detail}` : ""}</span></span></label>)}</div></fieldset>
      </form>}
      {repairError && <div className="alert" role="alert" style={{ marginTop: 14 }}><AlertTriangle size={15} /> <strong>{repairError.kind === "timeout" ? "Repair timed out" : repairError.kind === "infeasible" ? "Repair infeasible" : "Repair error"}:</strong> {repairError.message}</div>}
      {repairPreview && <div style={{ marginTop: 18 }} aria-live="polite"><div className="notice"><Check size={14} /> {repairPreview.message ?? "Preview generated; no timetable data has been changed."}</div>
        <div className="filter-row" style={{ alignItems: "stretch", marginTop: 14 }}><section className="card" style={{ flex: 1, minWidth: 220 }} aria-labelledby="repair-before-title"><h4 id="repair-before-title">Before</h4><p className="muted small">Current placement</p><strong>{repairSession.subjectCode || repairSession.subject}</strong><span>{repairSession.day} · {repairSession.start}–{repairSession.end}</span><span>{repairSession.faculty} · {repairSession.room}</span><span>Groups · {repairSession.groups.map((group) => group.name).join(", ") || "—"}</span></section><section className="card" style={{ flex: 1, minWidth: 220 }} aria-labelledby="repair-after-title"><h4 id="repair-after-title">After</h4><p className="muted small">Affected session summaries</p>{(repairPreview.changed ?? []).length ? (repairPreview.changed ?? []).map((change) => <div key={`${change.session_id}-${change.time}`} style={{ marginBottom: 8 }}><strong>{change.requested ? "Requested placement · " : "Affected · "}{change.subject ?? change.session_id}</strong><span>{change.day ?? "—"} · {change.time ?? "—"}</span><span>{formatChoice(change.faculty, repairOptions?.faculty ?? [], "Faculty unchanged")} · {formatChoice(change.room, repairOptions?.rooms ?? [], "Room unchanged")}</span><span>Groups · {change.groups?.map((id) => formatChoice(id, repairOptions?.groups ?? [], id)).join(", ") ?? "unchanged"}</span></div>) : <span>No affected sessions were returned.</span>}</section></div>
        <p className="muted small" style={{ marginTop: 12 }}>The requested placement is fixed and unchanged. Other sessions are preserved as far as possible, and unaffected sessions remain in place where feasible.</p>
        <p className="small"><strong>Removals:</strong> {(repairPreview.removed ?? []).length ? (repairPreview.removed ?? []).map((id) => sessions.find((item) => item.solverId === id)?.subject ?? id).join(", ") : "None reported."}</p>
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12 }}><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> <span>I reviewed the before/after impact and explicitly accept this repair proposal. I understand it will update the Draft only; it will remain unpublished.</span></label>
        <button type="button" className="btn btn-primary" style={{ marginTop: 12 }} disabled={!accepted || repairBusy} onClick={() => void commitRepair()}><Check size={14} /> {repairBusy ? "Applying…" : "Accept and apply repair"}</button>
      </div>}
    </div>}
  </section>;
}

function classifyRepairError(result: { status: number; payload: any; timedOut: boolean }): RepairError {
  const message = String(result.payload?.error ?? result.payload?.message ?? "Repair could not be completed.");
  if (result.timedOut || /timed out|could not be reached|timeout/i.test(message)) return { kind: "timeout", message: "The repair service did not respond in time. The previous draft remains unchanged; try again when the service is available." };
  if (result.status === 422 || /infeasible|no valid repair|not feasible|no valid/i.test(message) || ["INFEASIBLE", "UNSAT", "UNKNOWN"].includes(String(result.payload?.outcome ?? "").toUpperCase())) return { kind: "infeasible", message: `${message} No timetable data was changed.` };
  return { kind: "error", message };
}

function BookOpenLegend() { return <span aria-hidden="true">✳</span>; }
function FlaskIcon() { return <span aria-hidden="true">◌</span>; }
