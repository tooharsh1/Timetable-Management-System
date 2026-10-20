"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Check, Database, GraduationCap, HardHat, Loader2, Plus, RefreshCw, School, Users, X } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase-browser";

type Institution = { id: string; code: string; name: string; timezone: string };
type Department = { id: string; institution_id: string; code: string; name: string };
type Programme = { id: string; department_id: string; code: string; name: string; duration_years: number };
type AcademicYear = { id: string; institution_id: string; name: string; starts_on: string; ends_on: string; is_active: boolean };
type Semester = { id: string; academic_year_id: string; number: number; name: string; starts_on: string; ends_on: string; is_active: boolean };
type AcademicClass = { id: string; programme_id: string; code: string; name: string; cohort_year: number };
type Division = { id: string; class_id: string; code: string; name: string; capacity: number | null };
type Batch = { id: string; division_id: string; code: string; name: string; capacity: number };
type StudentGroup = { id: string; semester_id: string; name: string; group_type: GroupType; class_id: string | null; division_id: string | null; batch_id: string | null; conflict_key: string | null };
type Subject = { id: string; department_id: string; code: string; name: string; short_name: string | null; credits: number | null; is_elective: boolean };
type Faculty = { id: string; department_id: string; employee_code: string; full_name: string; initials: string; active: boolean };
type Room = { id: string; institution_id: string; department_id: string | null; code: string; name: string; room_type: RoomType; capacity: number; is_active: boolean };

type GroupType = "Class" | "Division" | "Batch" | "Elective";
type SessionType = "Lecture" | "Tutorial" | "Practical" | "Elective";
type RoomType = "Classroom" | "Laboratory" | "Seminar" | "Workshop" | "Auditorium" | "Office";

type Option = { value: string; label: string };
type DataState = {
  institutions: Institution[];
  departments: Department[];
  programmes: Programme[];
  academicYears: AcademicYear[];
  semesters: Semester[];
  classes: AcademicClass[];
  divisions: Division[];
  batches: Batch[];
  groups: StudentGroup[];
  subjects: Subject[];
  faculty: Faculty[];
  rooms: Room[];
};

const emptyData: DataState = { institutions: [], departments: [], programmes: [], academicYears: [], semesters: [], classes: [], divisions: [], batches: [], groups: [], subjects: [], faculty: [], rooms: [] };
const sessionTypes: SessionType[] = ["Lecture", "Tutorial", "Practical", "Elective"];
const groupTypes: GroupType[] = ["Class", "Division", "Batch", "Elective"];
const roomTypes: RoomType[] = ["Classroom", "Laboratory", "Seminar", "Workshop", "Auditorium", "Office"];

type SectionKey = "institutions" | "structure" | "periods" | "groups" | "subjects" | "faculty" | "rooms" | "requirements";
const sections: { key: SectionKey; label: string; hint: string }[] = [
  { key: "institutions", label: "Institutions", hint: "Tenant boundary" },
  { key: "structure", label: "Departments & programmes", hint: "Academic ownership" },
  { key: "periods", label: "Years & semesters", hint: "Scheduling periods" },
  { key: "groups", label: "Classes & groups", hint: "Attendance scope" },
  { key: "subjects", label: "Subjects", hint: "Curriculum records" },
  { key: "faculty", label: "Faculty", hint: "Teaching resources" },
  { key: "rooms", label: "Rooms", hint: "Physical resources" },
  { key: "requirements", label: "Requirements", hint: "Weekly teaching plan" },
];

function numberOrNull(value: string): number | null { return value.trim() === "" ? null : Number(value); }
function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : "The record could not be saved."; }
function displayDate(value: string): string { return value ? new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""; }

function InputField({ id, label, value, onChange, type = "text", required = false, min, max, maxLength, step, placeholder, help }: { id: string; label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean; min?: string | number; max?: string | number; maxLength?: number; step?: string | number; placeholder?: string; help?: string }) {
  return <div className="field"><label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label><input className="input" id={id} type={type} value={value} onChange={(event) => onChange(event.target.value)} required={required} min={min} max={max} maxLength={maxLength} step={step} placeholder={placeholder} />{help && <span className="muted small">{help}</span>}</div>;
}

function SelectField({ id, label, value, onChange, options, placeholder = "Choose an option", required = false, disabled = false, help }: { id: string; label: string; value: string; onChange: (value: string) => void; options: Option[]; placeholder?: string; required?: boolean; disabled?: boolean; help?: string }) {
  return <div className="field"><label htmlFor={id}>{label}{required && <span aria-hidden="true"> *</span>}</label><select className="select w-full" id={id} value={value} onChange={(event) => onChange(event.target.value)} required={required} disabled={disabled}><option value="">{options.length ? placeholder : "No records available yet"}</option>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>{help && <span className="muted small">{help}</span>}</div>;
}

function FormActions({ busy, label }: { busy: boolean; label: string }) {
  return <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 17 }}><button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? <Loader2 className="spinner" size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />} {busy ? "Saving…" : label}</button></div>;
}

function PanelCard({ title, eyebrow, description, children, icon }: { title: string; eyebrow: string; description?: string; children: ReactNode; icon?: ReactNode }) {
  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">{eyebrow}</div><h2 style={{ marginTop: 5 }}>{title}</h2></div>{icon ?? <span className="tag">Admin only</span>}</div>{description && <p className="muted" style={{ marginBottom: 18 }}>{description}</p>}{children}</section>;
}

export function AcademicSetupPanel() {
  const [active, setActive] = useState<SectionKey>("institutions");
  const [data, setData] = useState<DataState>(emptyData);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  const [institution, setInstitution] = useState({ code: "", name: "", timezone: "Asia/Kolkata" });
  const [department, setDepartment] = useState({ institution_id: "", code: "", name: "" });
  const [programme, setProgramme] = useState({ department_id: "", code: "", name: "", duration_years: "4" });
  const [year, setYear] = useState({ institution_id: "", name: "", starts_on: "", ends_on: "", is_active: false });
  const [semester, setSemester] = useState({ academic_year_id: "", number: "1", name: "", starts_on: "", ends_on: "", is_active: false });
  const [academicClass, setAcademicClass] = useState({ programme_id: "", code: "", name: "", cohort_year: "1" });
  const [division, setDivision] = useState({ class_id: "", code: "", name: "", capacity: "" });
  const [batch, setBatch] = useState({ division_id: "", code: "", name: "", capacity: "" });
  const [group, setGroup] = useState({ semester_id: "", name: "", group_type: "Class" as GroupType, class_id: "", division_id: "", batch_id: "", conflict_key: "" });
  const [subject, setSubject] = useState({ department_id: "", code: "", name: "", short_name: "", credits: "", is_elective: false });
  const [faculty, setFaculty] = useState({ department_id: "", employee_code: "", full_name: "", initials: "", active: true });
  const [room, setRoom] = useState({ institution_id: "", code: "", name: "", room_type: "Classroom" as RoomType, capacity: "", department_id: "", is_active: true });
  const [requirement, setRequirement] = useState({ semester_id: "", subject_id: "", session_type: "Lecture" as SessionType, weekly_sessions: "1", duration_periods: "1", expected_size: "", expected_enrolment: "", notes: "" });
  const [durationTouched, setDurationTouched] = useState(false);
  const [requirementGroups, setRequirementGroups] = useState<string[]>([]);
  const [requirementFaculty, setRequirementFaculty] = useState<string[]>([]);

  const loadData = useCallback(async () => {
    setLoading(true); setLoadError("");
    const supabase = getBrowserSupabase();
    if (!supabase) { setConfigured(false); setData(emptyData); setLoading(false); return; }
    setConfigured(true);
    try {
      const query = async <T,>(table: string, columns: string, order = "name"): Promise<T[]> => {
        const { data: rows, error: queryError } = await (supabase.from(table) as any).select(columns).order(order, { ascending: true });
        if (queryError) throw queryError;
        return (rows ?? []) as T[];
      };
      const [institutions, departments, programmes, academicYears, semesters, classes, divisions, batches, groups, subjects, faculty, rooms] = await Promise.all([
        query<Institution>("institutions", "id,code,name,timezone"),
        query<Department>("departments", "id,institution_id,code,name"),
        query<Programme>("programmes", "id,department_id,code,name,duration_years"),
        query<AcademicYear>("academic_years", "id,institution_id,name,starts_on,ends_on,is_active"),
        query<Semester>("semesters", "id,academic_year_id,number,name,starts_on,ends_on,is_active"),
        query<AcademicClass>("classes", "id,programme_id,code,name,cohort_year"),
        query<Division>("divisions", "id,class_id,code,name,capacity"),
        query<Batch>("batches", "id,division_id,code,name,capacity"),
        query<StudentGroup>("student_groups", "id,semester_id,name,group_type,class_id,division_id,batch_id,conflict_key"),
        query<Subject>("subjects", "id,department_id,code,name,short_name,credits,is_elective"),
        query<Faculty>("faculty", "id,department_id,employee_code,full_name,initials,active", "full_name"),
        query<Room>("rooms", "id,institution_id,department_id,code,name,room_type,capacity,is_active"),
      ]);
      setData({ institutions, departments, programmes, academicYears, semesters, classes, divisions, batches, groups, subjects, faculty, rooms });
    } catch (cause) {
      setLoadError(errorText(cause));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadData(); }, [loadData]);

  useEffect(() => {
    if (!requirement.semester_id || durationTouched) return;
    let cancelled = false;
    const fallback = requirement.session_type === "Practical" ? 2 : 1;
    setRequirement((current) => ({ ...current, duration_periods: String(fallback) }));
    const supabase = getBrowserSupabase();
    if (!supabase) return () => { cancelled = true; };
    const field = requirement.session_type === "Practical" ? "lab_duration_periods" : requirement.session_type === "Tutorial" ? "tutorial_duration_periods" : "theory_duration_periods";
    void supabase.from("semester_timing_templates").select("timing_templates!inner(theory_duration_periods,tutorial_duration_periods,lab_duration_periods)").eq("semester_id", requirement.semester_id).maybeSingle().then(({ data, error }) => {
      const template = Array.isArray(data?.timing_templates) ? data.timing_templates[0] : data?.timing_templates;
      const value = Number((template as Record<string, unknown> | null)?.[field]);
      if (!cancelled && !error && Number.isInteger(value) && value > 0) setRequirement((current) => current.semester_id === requirement.semester_id && current.session_type === requirement.session_type ? { ...current, duration_periods: String(value) } : current);
    });
    return () => { cancelled = true; };
  }, [requirement.semester_id, requirement.session_type, durationTouched]);

  const institutionOptions = useMemo<Option[]>(() => data.institutions.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` })), [data.institutions]);
  const departmentOptions = useMemo<Option[]>(() => data.departments.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` })), [data.departments]);
  const programmeOptions = useMemo<Option[]>(() => data.programmes.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` })), [data.programmes]);
  const yearOptions = useMemo<Option[]>(() => data.academicYears.map((item) => ({ value: item.id, label: `${item.name} · ${displayDate(item.starts_on)}–${displayDate(item.ends_on)}` })), [data.academicYears]);
  const semesterOptions = useMemo<Option[]>(() => data.semesters.map((item) => ({ value: item.id, label: `${item.name} · ${data.academicYears.find((yearItem) => yearItem.id === item.academic_year_id)?.name ?? "Academic year"}` })), [data.semesters, data.academicYears]);
  const classOptions = useMemo<Option[]>(() => data.classes.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` })), [data.classes]);
  const divisionOptions = useMemo<Option[]>(() => data.divisions.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` })), [data.divisions]);
  const batchOptions = useMemo<Option[]>(() => data.batches.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` })), [data.batches]);
  const subjectOptions = useMemo<Option[]>(() => data.subjects.map((item) => ({ value: item.id, label: `${item.code} · ${item.name}` })), [data.subjects]);
  const activeGroups = useMemo(() => data.groups.filter((item) => item.semester_id === requirement.semester_id), [data.groups, requirement.semester_id]);
  const eligibleFaculty = useMemo(() => {
    const selectedSubject = data.subjects.find((item) => item.id === requirement.subject_id);
    return data.faculty.filter((item) => item.active && (!selectedSubject || item.department_id === selectedSubject.department_id));
  }, [data.faculty, data.subjects, requirement.subject_id]);

  function resetMessages() { setError(""); setSaved(""); }
  function toggle(setter: (value: string[]) => void, values: string[], id: string) { setter(values.includes(id) ? values.filter((value) => value !== id) : [...values, id]); }

  async function createRecord(event: FormEvent<HTMLFormElement>, table: string, payload: Record<string, unknown>, successMessage: string, reset?: () => void) {
    event.preventDefault(); resetMessages(); setBusy(true);
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured. Set up the authenticated database connection before saving academic records."); setBusy(false); return; }
    try {
      const { error: insertError } = await (supabase.from(table) as any).insert(payload);
      if (insertError) throw insertError;
      reset?.(); setSaved(successMessage); await loadData();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  async function createRequirement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); resetMessages();
    if (!requirementGroups.length) { setError("Choose at least one participant group for this weekly requirement."); return; }
    if (!requirementFaculty.length) { setError("Choose at least one eligible faculty member so the requirement can be assigned."); return; }
    const weekly = Number(requirement.weekly_sessions); const duration = Number(requirement.duration_periods); const expectedSize = numberOrNull(requirement.expected_size); const expectedEnrolment = numberOrNull(requirement.expected_enrolment); const allocation = 100;
    if (!Number.isInteger(weekly) || weekly < 1 || weekly > 30 || !Number.isInteger(duration) || duration < 1 || duration > 12 || (expectedSize !== null && (!Number.isInteger(expectedSize) || expectedSize < 1)) || (expectedEnrolment !== null && (!Number.isInteger(expectedEnrolment) || expectedEnrolment < 1))) { setError("Enter valid whole numbers: weekly sessions 1–30, duration 1–12 periods, and positive enrolment values."); return; }
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured. Set up the authenticated database connection before saving requirements."); return; }
    setBusy(true);
    let requirementId = "";
    try {
      const { data: created, error: requirementError } = await (supabase.from("subject_requirements") as any).insert({ semester_id: requirement.semester_id, subject_id: requirement.subject_id, session_type: requirement.session_type, weekly_sessions: weekly, duration_periods: duration, expected_size: expectedSize, notes: requirement.notes.trim() || null }).select("id").single();
      if (requirementError || !created?.id) throw requirementError ?? new Error("The requirement was created without an identifier.");
      requirementId = String(created.id);
      const { error: groupsError } = await (supabase.from("subject_requirement_groups") as any).insert(requirementGroups.map((groupId) => ({ requirement_id: requirementId, group_id: groupId, expected_enrolment: expectedEnrolment })));
      if (groupsError) throw groupsError;
      const { error: eligibilityError } = await (supabase.from("faculty_subject_eligibility") as any).upsert(requirementFaculty.map((facultyId) => ({ faculty_id: facultyId, subject_id: requirement.subject_id })), { onConflict: "faculty_id,subject_id", ignoreDuplicates: true });
      if (eligibilityError) throw eligibilityError;
      const assignmentRows = requirementFaculty.flatMap((facultyId) => requirementGroups.map((groupId) => ({ faculty_id: facultyId, requirement_id: requirementId, group_id: groupId, allocation_percent: allocation })));
      const { error: assignmentError } = await (supabase.from("faculty_assignments") as any).insert(assignmentRows);
      if (assignmentError) throw assignmentError;
      setRequirement({ semester_id: requirement.semester_id, subject_id: "", session_type: "Lecture", weekly_sessions: "1", duration_periods: "1", expected_size: "", expected_enrolment: "", notes: "" }); setDurationTouched(false); setRequirementGroups([]); setRequirementFaculty([]); setSaved("Requirement, participant groups, faculty eligibility, and assignments saved."); await loadData();
    } catch (cause) {
      if (requirementId) {
        const { error: cleanupError } = await (supabase.from("subject_requirements") as any).delete().eq("id", requirementId);
        setError(`${errorText(cause)}${cleanupError ? ` Cleanup also failed: ${cleanupError.message}` : " The incomplete requirement was removed."}`);
      } else setError(errorText(cause));
    } finally { setBusy(false); }
  }

  if (loading) return <section className="card fade-in" aria-live="polite"><div className="empty-state"><div className="empty-icon"><Loader2 className="spinner" size={19} aria-hidden="true" /></div><h3>Loading academic setup</h3><p className="muted small" style={{ marginBottom: 0 }}>Reading permitted records from the authenticated Supabase session.</p></div></section>;
  if (!configured) return <section className="card fade-in"><div className="empty-state"><div className="empty-icon"><Database size={19} aria-hidden="true" /></div><h3>Database connection not configured</h3><p className="muted small" style={{ maxWidth: 450, margin: "0 auto 14px" }}>Academic setup uses the browser Supabase client and the signed-in administrator’s RLS permissions. Configure the public Supabase URL and anonymous key to continue.</p><button className="btn btn-secondary" type="button" onClick={() => void loadData()}><RefreshCw size={14} /> Try again</button></div></section>;
  if (loadError) return <section className="card fade-in"><div className="empty-state"><div className="empty-icon"><X size={19} aria-hidden="true" /></div><h3>Academic setup could not load</h3><p className="muted small" style={{ maxWidth: 520, margin: "0 auto 14px" }}>{loadError}</p><button className="btn btn-secondary" type="button" onClick={() => void loadData()}><RefreshCw size={14} /> Retry</button></div></section>;

  const onDepartmentSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "departments", { institution_id: department.institution_id, code: department.code.trim(), name: department.name.trim() }, "Department saved.", () => setDepartment({ institution_id: department.institution_id, code: "", name: "" }));
  const onProgrammeSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "programmes", { department_id: programme.department_id, code: programme.code.trim(), name: programme.name.trim(), duration_years: Number(programme.duration_years) }, "Programme saved.", () => setProgramme({ department_id: programme.department_id, code: "", name: "", duration_years: "4" }));
  const onYearSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "academic_years", { institution_id: year.institution_id, name: year.name.trim(), starts_on: year.starts_on, ends_on: year.ends_on, is_active: year.is_active }, "Academic year saved.", () => setYear({ institution_id: year.institution_id, name: "", starts_on: "", ends_on: "", is_active: false }));
  const onSemesterSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "semesters", { academic_year_id: semester.academic_year_id, number: Number(semester.number), name: semester.name.trim(), starts_on: semester.starts_on, ends_on: semester.ends_on, is_active: semester.is_active }, "Semester saved.", () => setSemester({ academic_year_id: semester.academic_year_id, number: "1", name: "", starts_on: "", ends_on: "", is_active: false }));
  const onClassSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "classes", { programme_id: academicClass.programme_id, code: academicClass.code.trim(), name: academicClass.name.trim(), cohort_year: Number(academicClass.cohort_year) }, "Class saved.", () => setAcademicClass({ programme_id: academicClass.programme_id, code: "", name: "", cohort_year: "1" }));
  const onDivisionSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "divisions", { class_id: division.class_id, code: division.code.trim(), name: division.name.trim(), capacity: numberOrNull(division.capacity) }, "Division saved.", () => setDivision({ class_id: division.class_id, code: "", name: "", capacity: "" }));
  const onBatchSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "batches", { division_id: batch.division_id, code: batch.code.trim(), name: batch.name.trim(), capacity: Number(batch.capacity) }, "Batch saved.", () => setBatch({ division_id: batch.division_id, code: "", name: "", capacity: "" }));
  const onGroupSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "student_groups", { semester_id: group.semester_id, name: group.name.trim(), group_type: group.group_type, class_id: group.group_type === "Class" ? group.class_id : null, division_id: group.group_type === "Division" ? group.division_id : null, batch_id: group.group_type === "Batch" ? group.batch_id : null, conflict_key: group.conflict_key.trim() || null }, "Participant group saved.", () => setGroup({ semester_id: group.semester_id, name: "", group_type: group.group_type, class_id: "", division_id: "", batch_id: "", conflict_key: "" }));
  const onSubjectSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "subjects", { department_id: subject.department_id, code: subject.code.trim(), name: subject.name.trim(), short_name: subject.short_name.trim() || null, credits: numberOrNull(subject.credits), is_elective: subject.is_elective }, "Subject saved.", () => setSubject({ department_id: subject.department_id, code: "", name: "", short_name: "", credits: "", is_elective: false }));
  const onFacultySubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "faculty", { department_id: faculty.department_id, employee_code: faculty.employee_code.trim(), full_name: faculty.full_name.trim(), initials: faculty.initials.trim().toUpperCase(), active: faculty.active }, "Faculty record saved.", () => setFaculty({ department_id: faculty.department_id, employee_code: "", full_name: "", initials: "", active: true }));
  const onRoomSubmit = (event: FormEvent<HTMLFormElement>) => createRecord(event, "rooms", { institution_id: room.institution_id, code: room.code.trim(), name: room.name.trim(), room_type: room.room_type, capacity: Number(room.capacity), department_id: room.department_id || null, is_active: room.is_active }, "Room saved.", () => setRoom({ institution_id: room.institution_id, code: "", name: "", room_type: "Classroom", capacity: "", department_id: "", is_active: true }));

  return <div className="fade-in">
    <div className="card" style={{ padding: 12, marginBottom: 15 }}><div className="filter-row" role="tablist" aria-label="Academic setup sections" style={{ overflowX: "auto", paddingBottom: 1 }}>{sections.map((section) => <button key={section.key} className={`btn ${active === section.key ? "btn-primary" : "btn-ghost"}`} type="button" role="tab" aria-selected={active === section.key} aria-controls={`academic-panel-${section.key}`} onClick={() => { setActive(section.key); resetMessages(); }}>{section.label}</button>)}</div></div>
    {error && <div className="alert" role="alert" style={{ marginBottom: 13 }}>{error}</div>}
    {saved && <div className="notice" role="status" style={{ marginBottom: 13 }}><Check size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />{saved}</div>}

    {active === "institutions" && <div id="academic-panel-institutions" role="tabpanel"><PanelCard eyebrow="Academic boundary" title="Institutions" description="Institutions are the tenant boundary for departments, academic periods, rooms, and shared resources." icon={<School size={19} color="var(--moss)" />}><form onSubmit={(event) => createRecord(event, "institutions", { code: institution.code.trim().toUpperCase(), name: institution.name.trim(), timezone: institution.timezone.trim() }, "Institution saved.", () => setInstitution({ code: "", name: "", timezone: "Asia/Kolkata" }))} style={{ maxWidth: 650 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><InputField id="institution-code" label="Code" value={institution.code} onChange={(value) => setInstitution({ ...institution, code: value.toUpperCase() })} required maxLength={20} placeholder="RGIT" help="2–20 characters; stored uppercase." /><InputField id="institution-name" label="Institution name" value={institution.name} onChange={(value) => setInstitution({ ...institution, name: value })} required placeholder="Rajiv Gandhi Institute of Technology" /><InputField id="institution-timezone" label="Timezone" value={institution.timezone} onChange={(value) => setInstitution({ ...institution, timezone: value })} required placeholder="Asia/Kolkata" /></div><FormActions busy={busy} label="Add institution" /></form></PanelCard></div>}

    {active === "structure" && <div id="academic-panel-structure" role="tabpanel" style={{ display: "grid", gap: 15 }}><PanelCard eyebrow="Academic ownership" title="Departments" description="Choose the institution from a labelled list; UUIDs are never entered by administrators."><form onSubmit={onDepartmentSubmit} style={{ maxWidth: 650 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="department-institution" label="Institution" value={department.institution_id} onChange={(value) => setDepartment({ ...department, institution_id: value })} options={institutionOptions} required /><InputField id="department-code" label="Department code" value={department.code} onChange={(value) => setDepartment({ ...department, code: value.trim().toUpperCase() })} required placeholder="CSE" /><InputField id="department-name" label="Department name" value={department.name} onChange={(value) => setDepartment({ ...department, name: value })} required placeholder="Computer Science and Engineering" /></div><FormActions busy={busy} label="Add department" /></form></PanelCard><PanelCard eyebrow="Degree catalogue" title="Programmes" description="A programme belongs to a department and carries its real duration in years."><form onSubmit={onProgrammeSubmit} style={{ maxWidth: 650 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="programme-department" label="Department" value={programme.department_id} onChange={(value) => setProgramme({ ...programme, department_id: value })} options={departmentOptions} required /><InputField id="programme-code" label="Programme code" value={programme.code} onChange={(value) => setProgramme({ ...programme, code: value.trim().toUpperCase() })} required placeholder="BTECH-CSE" /><InputField id="programme-name" label="Programme name" value={programme.name} onChange={(value) => setProgramme({ ...programme, name: value })} required placeholder="B.Tech Computer Science and Engineering" /><InputField id="programme-duration" label="Duration (years)" type="number" value={programme.duration_years} onChange={(value) => setProgramme({ ...programme, duration_years: value })} required min={1} max={10} step={1} /></div><FormActions busy={busy} label="Add programme" /></form></PanelCard></div>}

    {active === "periods" && <div id="academic-panel-periods" role="tabpanel" style={{ display: "grid", gap: 15 }}><PanelCard eyebrow="Calendar" title="Academic years" description="Academic years must have an end date after their start date."><form onSubmit={(event) => { if (year.ends_on <= year.starts_on) { event.preventDefault(); setError("Academic year end date must be after its start date."); return; } void onYearSubmit(event); }} style={{ maxWidth: 700 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="year-institution" label="Institution" value={year.institution_id} onChange={(value) => setYear({ ...year, institution_id: value })} options={institutionOptions} required /><InputField id="year-name" label="Academic year name" value={year.name} onChange={(value) => setYear({ ...year, name: value })} required placeholder="2026-27" /><InputField id="year-start" label="Starts on" type="date" value={year.starts_on} onChange={(value) => setYear({ ...year, starts_on: value })} required /><InputField id="year-end" label="Ends on" type="date" value={year.ends_on} onChange={(value) => setYear({ ...year, ends_on: value })} required /></div><label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginTop: 9 }}><input type="checkbox" checked={year.is_active} onChange={(event) => setYear({ ...year, is_active: event.target.checked })} /> Make this academic year active</label><FormActions busy={busy} label="Add academic year" /></form></PanelCard><PanelCard eyebrow="Calendar" title="Semesters" description="Each semester belongs to an academic year and has its own scheduling window."><form onSubmit={(event) => { if (semester.ends_on <= semester.starts_on) { event.preventDefault(); setError("Semester end date must be after its start date."); return; } void onSemesterSubmit(event); }} style={{ maxWidth: 700 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="semester-year" label="Academic year" value={semester.academic_year_id} onChange={(value) => setSemester({ ...semester, academic_year_id: value })} options={yearOptions} required /><InputField id="semester-number" label="Semester number" type="number" value={semester.number} onChange={(value) => setSemester({ ...semester, number: value })} required min={1} max={20} step={1} /><InputField id="semester-name" label="Semester name" value={semester.name} onChange={(value) => setSemester({ ...semester, name: value })} required placeholder="Semester III" /><InputField id="semester-start" label="Starts on" type="date" value={semester.starts_on} onChange={(value) => setSemester({ ...semester, starts_on: value })} required /><InputField id="semester-end" label="Ends on" type="date" value={semester.ends_on} onChange={(value) => setSemester({ ...semester, ends_on: value })} required /></div><label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginTop: 9 }}><input type="checkbox" checked={semester.is_active} onChange={(event) => setSemester({ ...semester, is_active: event.target.checked })} /> Make this semester active</label><FormActions busy={busy} label="Add semester" /></form></PanelCard></div>}

    {active === "groups" && <div id="academic-panel-groups" role="tabpanel" style={{ display: "grid", gap: 15 }}><PanelCard eyebrow="Cohorts" title="Classes, divisions, and batches" description="Build the hierarchy from programme to class, division, and batch. Capacity is checked by the database schema."><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(270px,1fr))", gap: 15 }}><form onSubmit={onClassSubmit}><h3>Class</h3><SelectField id="class-programme" label="Programme" value={academicClass.programme_id} onChange={(value) => setAcademicClass({ ...academicClass, programme_id: value })} options={programmeOptions} required /><InputField id="class-code" label="Class code" value={academicClass.code} onChange={(value) => setAcademicClass({ ...academicClass, code: value.trim().toUpperCase() })} required placeholder="CSE-2025" /><InputField id="class-name" label="Class name" value={academicClass.name} onChange={(value) => setAcademicClass({ ...academicClass, name: value })} required placeholder="CSE Second Year" /><InputField id="class-cohort" label="Cohort year" type="number" value={academicClass.cohort_year} onChange={(value) => setAcademicClass({ ...academicClass, cohort_year: value })} required min={1} max={10} step={1} /><FormActions busy={busy} label="Add class" /></form><form onSubmit={onDivisionSubmit}><h3>Division</h3><SelectField id="division-class" label="Class" value={division.class_id} onChange={(value) => setDivision({ ...division, class_id: value })} options={classOptions} required /><InputField id="division-code" label="Division code" value={division.code} onChange={(value) => setDivision({ ...division, code: value.trim().toUpperCase() })} required placeholder="A" /><InputField id="division-name" label="Division name" value={division.name} onChange={(value) => setDivision({ ...division, name: value })} required placeholder="CSE Division A" /><InputField id="division-capacity" label="Capacity (optional)" type="number" value={division.capacity} onChange={(value) => setDivision({ ...division, capacity: value })} min={1} step={1} /><FormActions busy={busy} label="Add division" /></form><form onSubmit={onBatchSubmit}><h3>Batch</h3><SelectField id="batch-division" label="Division" value={batch.division_id} onChange={(value) => setBatch({ ...batch, division_id: value })} options={divisionOptions} required /><InputField id="batch-code" label="Batch code" value={batch.code} onChange={(value) => setBatch({ ...batch, code: value.trim().toUpperCase() })} required placeholder="A1" /><InputField id="batch-name" label="Batch name" value={batch.name} onChange={(value) => setBatch({ ...batch, name: value })} required placeholder="CSE A Batch 1" /><InputField id="batch-capacity" label="Capacity" type="number" value={batch.capacity} onChange={(value) => setBatch({ ...batch, capacity: value })} required min={1} step={1} /><FormActions busy={busy} label="Add batch" /></form></div></PanelCard><PanelCard eyebrow="Attendance scope" title="Participant groups" description="Requirements attach to these schedulable groups. Class, Division, and Batch groups use labelled parent selectors; Elective groups have no parent foreign key."><form onSubmit={(event) => { const relationCount = [group.class_id, group.division_id, group.batch_id].filter(Boolean).length; const needsParent = group.group_type !== "Elective"; if ((needsParent && relationCount !== 1) || (!needsParent && relationCount !== 0)) { event.preventDefault(); setError("Choose exactly one matching parent for Class, Division, or Batch groups; Elective groups have no parent."); return; } void onGroupSubmit(event); }} style={{ maxWidth: 760 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="group-semester" label="Semester" value={group.semester_id} onChange={(value) => setGroup({ ...group, semester_id: value })} options={semesterOptions} required /><InputField id="group-name" label="Group name" value={group.name} onChange={(value) => setGroup({ ...group, name: value })} required placeholder="CSE Division A" /><SelectField id="group-type" label="Group type" value={group.group_type} onChange={(value) => setGroup({ ...group, group_type: value as GroupType, class_id: "", division_id: "", batch_id: "" })} options={groupTypes.map((value) => ({ value, label: value }))} required /><InputField id="group-conflict-key" label="Conflict key (optional)" value={group.conflict_key} onChange={(value) => setGroup({ ...group, conflict_key: value })} placeholder="CSE-A" />{group.group_type === "Class" && <SelectField id="group-class" label="Class parent" value={group.class_id} onChange={(value) => setGroup({ ...group, class_id: value })} options={classOptions} required />}{group.group_type === "Division" && <SelectField id="group-division" label="Division parent" value={group.division_id} onChange={(value) => setGroup({ ...group, division_id: value })} options={divisionOptions} required />}{group.group_type === "Batch" && <SelectField id="group-batch" label="Batch parent" value={group.batch_id} onChange={(value) => setGroup({ ...group, batch_id: value })} options={batchOptions} required />}</div><FormActions busy={busy} label="Add participant group" /></form></PanelCard></div>}

    {active === "subjects" && <div id="academic-panel-subjects" role="tabpanel"><PanelCard eyebrow="Curriculum" title="Subjects" description="A subject belongs to a department. Credits and elective status are stored exactly as defined in the schema."><form onSubmit={onSubjectSubmit} style={{ maxWidth: 760 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="subject-department" label="Department" value={subject.department_id} onChange={(value) => setSubject({ ...subject, department_id: value })} options={departmentOptions} required /><InputField id="subject-code" label="Subject code" value={subject.code} onChange={(value) => setSubject({ ...subject, code: value.trim().toUpperCase() })} required placeholder="CS301" /><InputField id="subject-name" label="Subject name" value={subject.name} onChange={(value) => setSubject({ ...subject, name: value })} required placeholder="Data Structures and Algorithms" /><InputField id="subject-short-name" label="Short name (optional)" value={subject.short_name} onChange={(value) => setSubject({ ...subject, short_name: value })} placeholder="DSA" /><InputField id="subject-credits" label="Credits (optional)" type="number" value={subject.credits} onChange={(value) => setSubject({ ...subject, credits: value })} min={0.1} step={0.1} /></div><label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginTop: 9 }}><input type="checkbox" checked={subject.is_elective} onChange={(event) => setSubject({ ...subject, is_elective: event.target.checked })} /> Mark as elective</label><FormActions busy={busy} label="Add subject" /></form></PanelCard></div>}

    {active === "faculty" && <div id="academic-panel-faculty" role="tabpanel"><PanelCard eyebrow="Teaching resources" title="Faculty" description="Initials are normalized to uppercase and must be 2–6 characters. Eligibility is added from the requirement workflow."><form onSubmit={(event) => { if (!/^[A-Z]{2,6}$/.test(faculty.initials.trim().toUpperCase())) { event.preventDefault(); setError("Faculty initials must contain 2–6 uppercase letters."); return; } void onFacultySubmit(event); }} style={{ maxWidth: 760 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="faculty-department" label="Department" value={faculty.department_id} onChange={(value) => setFaculty({ ...faculty, department_id: value })} options={departmentOptions} required /><InputField id="faculty-code" label="Employee code" value={faculty.employee_code} onChange={(value) => setFaculty({ ...faculty, employee_code: value })} required placeholder="RG-CSE-017" /><InputField id="faculty-name" label="Full name" value={faculty.full_name} onChange={(value) => setFaculty({ ...faculty, full_name: value })} required placeholder="Dr. Ananya Mehta" /><InputField id="faculty-initials" label="Initials" value={faculty.initials} onChange={(value) => setFaculty({ ...faculty, initials: value.toUpperCase() })} required max={6} placeholder="AM" /></div><label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginTop: 9 }}><input type="checkbox" checked={faculty.active} onChange={(event) => setFaculty({ ...faculty, active: event.target.checked })} /> Faculty member is active</label><FormActions busy={busy} label="Add faculty" /></form></PanelCard></div>}

    {active === "rooms" && <div id="academic-panel-rooms" role="tabpanel"><PanelCard eyebrow="Physical resources" title="Rooms" description="Room type uses the migration enum values. Department is optional for shared rooms; capacity is required and positive."><form onSubmit={onRoomSubmit} style={{ maxWidth: 760 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="room-institution" label="Institution" value={room.institution_id} onChange={(value) => setRoom({ ...room, institution_id: value })} options={institutionOptions} required /><InputField id="room-code" label="Room code" value={room.code} onChange={(value) => setRoom({ ...room, code: value.trim().toUpperCase() })} required placeholder="LH-201" /><InputField id="room-name" label="Room name" value={room.name} onChange={(value) => setRoom({ ...room, name: value })} required placeholder="Lecture Hall 201" /><SelectField id="room-type" label="Room type" value={room.room_type} onChange={(value) => setRoom({ ...room, room_type: value as RoomType })} options={roomTypes.map((value) => ({ value, label: value }))} required /><InputField id="room-capacity" label="Capacity" type="number" value={room.capacity} onChange={(value) => setRoom({ ...room, capacity: value })} required min={1} step={1} /><SelectField id="room-department" label="Department (optional)" value={room.department_id} onChange={(value) => setRoom({ ...room, department_id: value })} options={departmentOptions} placeholder="Shared across departments" /></div><label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginTop: 9 }}><input type="checkbox" checked={room.is_active} onChange={(event) => setRoom({ ...room, is_active: event.target.checked })} /> Room is active</label><FormActions busy={busy} label="Add room" /></form></PanelCard></div>}

    {active === "requirements" && <div id="academic-panel-requirements" role="tabpanel"><PanelCard eyebrow="Weekly teaching plan" title="Subject requirements" description="Create a complete requirement, then attach participant groups and eligible faculty assignments. No timetable sessions are fabricated here." icon={<GraduationCap size={19} color="var(--moss)" />}><form onSubmit={createRequirement} style={{ maxWidth: 900 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 13px" }}><SelectField id="requirement-semester" label="Semester" value={requirement.semester_id} onChange={(value) => { setRequirement({ ...requirement, semester_id: value }); setDurationTouched(false); setRequirementGroups([]); }} options={semesterOptions} required /><SelectField id="requirement-subject" label="Subject" value={requirement.subject_id} onChange={(value) => { setRequirement({ ...requirement, subject_id: value }); setRequirementFaculty([]); }} options={subjectOptions} required /><SelectField id="requirement-session-type" label="Session type" value={requirement.session_type} onChange={(value) => { setRequirement({ ...requirement, session_type: value as SessionType }); setDurationTouched(false); }} options={sessionTypes.map((value) => ({ value, label: value }))} required /><InputField id="requirement-weekly" label="Weekly sessions" type="number" value={requirement.weekly_sessions} onChange={(value) => setRequirement({ ...requirement, weekly_sessions: value })} required min={1} max={30} step={1} /><InputField id="requirement-duration" label="Duration (periods)" type="number" value={requirement.duration_periods} onChange={(value) => { setRequirement({ ...requirement, duration_periods: value }); setDurationTouched(true); }} required min={1} max={12} step={1} /><InputField id="requirement-size" label="Expected size (optional)" type="number" value={requirement.expected_size} onChange={(value) => setRequirement({ ...requirement, expected_size: value })} min={1} step={1} /><InputField id="requirement-enrolment" label="Expected enrolment per group" type="number" value={requirement.expected_enrolment} onChange={(value) => setRequirement({ ...requirement, expected_enrolment: value })} min={1} step={1} /></div><div className="field"><label htmlFor="requirement-notes">Notes (optional)</label><textarea className="input" id="requirement-notes" value={requirement.notes} onChange={(event) => setRequirement({ ...requirement, notes: event.target.value })} rows={3} placeholder="Combined lecture, parallel practical, or delivery notes" style={{ paddingTop: 10, resize: "vertical" }} /></div><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(270px,1fr))", gap: 15, marginTop: 18 }}><fieldset style={{ minWidth: 0, border: "1px solid var(--line)", borderRadius: 12, padding: 13, margin: 0 }}><legend style={{ padding: "0 6px", fontSize: 11, fontWeight: 700 }}>Participant groups <span className="muted">({requirementGroups.length} selected)</span></legend>{!requirement.semester_id ? <p className="muted small" style={{ marginBottom: 0 }}>Choose a semester to load its groups.</p> : activeGroups.length === 0 ? <p className="muted small" style={{ marginBottom: 0 }}>No groups exist for this semester yet. Add one in Classes &amp; groups.</p> : <div style={{ display: "grid", gap: 7, maxHeight: 230, overflowY: "auto" }}>{activeGroups.map((item) => <label key={item.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}><input type="checkbox" checked={requirementGroups.includes(item.id)} onChange={() => toggle(setRequirementGroups, requirementGroups, item.id)} /><span><strong>{item.name}</strong><br /><span className="muted small">{item.group_type}{item.conflict_key ? ` · conflict ${item.conflict_key}` : ""}</span></span></label>)}</div>}</fieldset><fieldset style={{ minWidth: 0, border: "1px solid var(--line)", borderRadius: 12, padding: 13, margin: 0 }}><legend style={{ padding: "0 6px", fontSize: 11, fontWeight: 700 }}>Eligible faculty <span className="muted">({requirementFaculty.length} selected)</span></legend>{!requirement.subject_id ? <p className="muted small" style={{ marginBottom: 0 }}>Choose a subject to load its department’s active faculty.</p> : eligibleFaculty.length === 0 ? <p className="muted small" style={{ marginBottom: 0 }}>No active faculty in the subject department yet.</p> : <div style={{ display: "grid", gap: 7, maxHeight: 230, overflowY: "auto" }}>{eligibleFaculty.map((item) => <label key={item.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}><input type="checkbox" checked={requirementFaculty.includes(item.id)} onChange={() => toggle(setRequirementFaculty, requirementFaculty, item.id)} /><span><strong>{item.full_name}</strong><br /><span className="muted small">{item.employee_code} · {item.initials} · assigned to every selected group</span></span></label>)}</div>}</fieldset></div><div className="notice" style={{ marginTop: 15 }}><Users size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />Saving marks selected faculty eligible for this subject and creates one faculty assignment for every selected faculty/group pair. If a follow-up insert fails, the incomplete requirement is deleted.</div><FormActions busy={busy} label="Save weekly requirement" /></form></PanelCard></div>}

    <div className="notice" style={{ marginTop: 15 }}><HardHat size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />All writes use the authenticated browser Supabase client. Database RLS remains the authorization boundary; this panel never uses a service-role key.</div>
  </div>;
}

export default AcademicSetupPanel;
