"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Link2, UserRoundPlus } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase-browser";

type Profile = { id: string; email: string | null; display_name: string; role: "Admin" | "Teacher" | "Student"; admin_approved: boolean; approved_by: string | null };
type Faculty = { id: string; full_name: string; initials: string; profile_id: string | null };
type StudentRecord = { id: string; profile_id: string; enrollment_number: string; current_semester_id: string | null };
type Option = { id: string; name: string };

export function UserAccountsPanel() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [students, setStudents] = useState<StudentRecord[]>([]);
  const [programmes, setProgrammes] = useState<Option[]>([]);
  const [semesters, setSemesters] = useState<Option[]>([]);
  const [groups, setGroups] = useState<Option[]>([]);
  const [authUserId, setAuthUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [studentForm, setStudentForm] = useState({ profile_id: "", enrollment_number: "", programme_id: "", current_semester_id: "" });
  const [studentGroups, setStudentGroups] = useState<string[]>([]);

  const load = useCallback(async () => {
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured."); setLoading(false); return; }
    setLoading(true); setError("");
    const [{ data: auth }, profileResult, facultyResult, studentResult, programmeResult, semesterResult, groupResult] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from("profiles").select("id,email,display_name,role,admin_approved,approved_by").order("display_name"),
      supabase.from("faculty").select("id,full_name,initials,profile_id,department_id").order("full_name"),
      supabase.from("student_records").select("id,profile_id,enrollment_number,current_semester_id").order("enrollment_number"),
      supabase.from("programmes").select("id,name,code").order("name"),
      supabase.from("semesters").select("id,name,is_active").eq("is_active", true).order("starts_on", { ascending: false }),
      supabase.from("student_groups").select("id,name").order("name"),
    ]);
    const failure = [profileResult.error, facultyResult.error, studentResult.error, programmeResult.error, semesterResult.error, groupResult.error].find(Boolean);
    if (failure) setError("User access records could not be loaded. Check database policy and migration setup.");
    else {
      setAuthUserId(auth.user?.id ?? ""); setProfiles((profileResult.data ?? []) as Profile[]); setFaculty((facultyResult.data ?? []) as Faculty[]); setStudents((studentResult.data ?? []) as StudentRecord[]);
      setProgrammes((programmeResult.data ?? []).map((item) => ({ id: item.id, name: `${item.code} · ${item.name}` })));
      setSemesters((semesterResult.data ?? []).map((item) => ({ id: item.id, name: item.name })));
      setGroups((groupResult.data ?? []).map((item) => ({ id: item.id, name: item.name })));
    }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function changeRole(profile: Profile, role: Profile["role"]) {
    if (profile.id === authUserId) { setError("You cannot change your own role."); return; }
    const supabase = getBrowserSupabase(); if (!supabase) return;
    setBusy(true); setError(""); setMessage("");
    const elevated = role === "Admin";
    const { error: updateError } = await supabase.from("profiles").update({ role, admin_approved: elevated, approved_by: elevated ? authUserId : null, approved_at: elevated ? new Date().toISOString() : null }).eq("id", profile.id);
    if (updateError) setError("Role change was denied or the profile changed concurrently. The database independently protects administrator assignment.");
    else { setMessage(`${profile.display_name}'s role is now ${role}.`); await load(); }
    setBusy(false);
  }

  async function linkFaculty(row: Faculty, profileId: string) {
    const supabase = getBrowserSupabase(); if (!supabase) return;
    setBusy(true); setError(""); setMessage("");
    const { error: updateError } = await supabase.from("faculty").update({ profile_id: profileId || null }).eq("id", row.id);
    if (updateError) setError("Faculty account link could not be saved; the profile may already be linked to another faculty record.");
    else { setMessage(`${row.full_name}'s profile link was updated.`); await load(); }
    setBusy(false);
  }

  async function createStudentRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    if (!studentForm.profile_id || !studentForm.current_semester_id || !studentGroups.length) { setError("Choose a Student profile, active semester, and at least one attendance group."); setBusy(false); return; }
    const supabase = getBrowserSupabase(); if (!supabase) { setBusy(false); return; }
    const { data: record, error: createError } = await supabase.from("student_records").insert({ profile_id: studentForm.profile_id, enrollment_number: studentForm.enrollment_number.trim(), programme_id: studentForm.programme_id || null, current_semester_id: studentForm.current_semester_id }).select("id").single();
    if (createError || !record) { setError("Student record was not created. Confirm the profile is not already linked and the enrollment number is unique."); setBusy(false); return; }
    const { error: enrolmentError } = await supabase.from("student_enrolments").insert(studentGroups.map((group_id) => ({ student_record_id: record.id, group_id, enrolment_kind: "Core" })));
    if (enrolmentError) { await supabase.from("student_records").delete().eq("id", record.id); setError("Student group links failed; the new student record was rolled back where database policy permitted."); }
    else { setMessage("Student account linked to the selected semester and attendance groups."); setStudentForm({ profile_id: "", enrollment_number: "", programme_id: "", current_semester_id: "" }); setStudentGroups([]); await load(); }
    setBusy(false);
  }

  const teacherProfiles = profiles.filter((item) => item.role === "Teacher");
  const studentProfiles = profiles.filter((item) => item.role === "Student" && !students.some((record) => record.profile_id === item.id));
  return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Role-based access</div><h2 style={{ marginTop: 5 }}>User accounts and identity links</h2></div><KeyRound size={18} color="var(--moss)" /></div>
    <div className="notice">Create or invite identities through the institution’s Supabase Auth administration first. This panel only assigns roles to existing profiles and links them to academic records; login-page role selection never grants access.</div>
    {message && <div className="notice" role="status" style={{ marginTop: 12 }}>{message}</div>}{error && <div className="alert" role="alert" style={{ marginTop: 12 }}>{error}</div>}
    {loading ? <div className="empty-state" role="status"><span className="spinner" /> Loading user access records…</div> : <div style={{ display: "grid", gap: 16, marginTop: 15 }}>
      <section className="card" style={{ background: "#faf8f1" }}><div className="card-title"><div><div className="eyebrow">Existing Auth profiles</div><h3>Assign exactly one application role</h3></div><span className="tag">{profiles.length} profiles</span></div>{profiles.length === 0 ? <p className="muted small">Create an identity in Supabase Auth, then refresh.</p> : <div className="table-wrap"><table className="timetable" style={{ minWidth: 680 }}><thead><tr><th>Name</th><th>Email</th><th>Current role</th><th>Change role</th></tr></thead><tbody>{profiles.map((profile) => <tr key={profile.id}><td>{profile.display_name}{profile.id === authUserId && <span className="tag amber" style={{ marginLeft: 6 }}>You</span>}</td><td>{profile.email ?? "—"}</td><td>{profile.role}{profile.admin_approved ? " · approved" : ""}</td><td><select className="select" aria-label={`Assign role for ${profile.display_name}`} value={profile.role} disabled={busy || profile.id === authUserId} onChange={(event) => void changeRole(profile, event.target.value as Profile["role"])}><option value="Student">Student</option><option value="Teacher">Teacher</option><option value="Admin">Admin</option></select></td></tr>)}</tbody></table></div>}</section>
      <section className="card" style={{ background: "#faf8f1" }}><div className="card-title"><div><div className="eyebrow">Teacher links</div><h3>Connect faculty records to Teacher profiles</h3></div><Link2 size={16} color="var(--moss)" /></div>{faculty.length ? <div className="session-list">{faculty.map((row) => <label className="session-row" key={row.id} style={{ gridTemplateColumns: "minmax(0,1fr) minmax(190px,.8fr)" }}><span><strong>{row.full_name}</strong><span className="session-meta">{row.initials}</span></span><select className="select" aria-label={`Link profile to ${row.full_name}`} value={row.profile_id ?? ""} disabled={busy} onChange={(event) => void linkFaculty(row, event.target.value)}><option value="">No linked profile</option>{teacherProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.display_name} · {profile.email}</option>)}</select></label>)}</div> : <p className="muted small">Add faculty records in Academic setup first.</p>}</section>
      <section className="card" style={{ background: "#faf8f1" }}><div className="card-title"><div><div className="eyebrow">Student links</div><h3>Enrol a Student profile in its published scope</h3></div><UserRoundPlus size={17} color="var(--moss)" /></div><form onSubmit={createStudentRecord}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: "0 12px" }}><div className="field"><label htmlFor="student-profile">Student profile</label><select className="select w-full" id="student-profile" required value={studentForm.profile_id} onChange={(event) => setStudentForm({ ...studentForm, profile_id: event.target.value })}><option value="">Choose profile</option>{studentProfiles.map((item) => <option key={item.id} value={item.id}>{item.display_name} · {item.email}</option>)}</select></div><div className="field"><label htmlFor="enrollment-number">Enrollment number</label><input className="input" id="enrollment-number" required maxLength={32} value={studentForm.enrollment_number} onChange={(event) => setStudentForm({ ...studentForm, enrollment_number: event.target.value })} /></div><div className="field"><label htmlFor="student-programme">Programme</label><select className="select w-full" id="student-programme" value={studentForm.programme_id} onChange={(event) => setStudentForm({ ...studentForm, programme_id: event.target.value })}><option value="">Not assigned</option>{programmes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div className="field"><label htmlFor="student-semester">Active semester</label><select className="select w-full" id="student-semester" required value={studentForm.current_semester_id} onChange={(event) => setStudentForm({ ...studentForm, current_semester_id: event.target.value })}><option value="">Choose semester</option>{semesters.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div><fieldset style={{ border: "1px solid var(--line)", borderRadius: 11, padding: 13 }}><legend className="small">Attendance groups</legend>{groups.length ? <div className="filter-row">{groups.map((item) => <label className="tag" key={item.id} style={{ cursor: "pointer" }}><input type="checkbox" checked={studentGroups.includes(item.id)} onChange={() => setStudentGroups((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])} /> {item.name}</label>)}</div> : <span className="muted small">Add student groups in Academic setup first.</span>}</fieldset><button className="btn btn-primary" type="submit" disabled={busy || !studentProfiles.length}>{busy ? "Saving…" : "Create student link"}</button></form></section>
      <p className="muted small">Existing student records: {students.length}. Role updates are protected by the database; an account cannot approve itself as an Admin.</p>
    </div>}
  </section>;
}
