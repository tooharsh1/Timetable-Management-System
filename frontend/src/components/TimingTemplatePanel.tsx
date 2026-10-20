"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, CalendarDays, Check, Clock3, Copy, Plus, Save, Settings2, Trash2, X } from "lucide-react";
import { getBrowserSupabase } from "../lib/supabase-browser";

type Template = {
  id: string;
  institution_id: string;
  code: string;
  name: string;
  timezone: string;
  theory_duration_periods: number;
  tutorial_duration_periods: number;
  lab_duration_periods: number;
  max_daily_periods: number;
  max_consecutive_periods: number;
};

type Period = {
  localId: string;
  id?: string;
  sequence_no: number;
  label: string;
  starts_at: string;
  ends_at: string;
  kind: "Teaching" | "Break";
};

type BreakRow = { localId: string; id?: string; label: string; starts_at: string; ends_at: string };
type BlockedRow = { localId: string; id?: string; day_of_week: number; starts_at: string; ends_at: string; reason: string };
type RuleRow = { id?: string; code: string; name: string; weight: number; is_active: boolean; hard_constraint: boolean };
type DayRow = { day_of_week: number; is_working: boolean };

type LoadState = "loading" | "ready" | "missing" | "error";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SOFT_RULES = [
  { code: "SPREAD_SUBJECTS", label: "Spread subjects", help: "Avoid placing the same subject too close together." },
  { code: "BALANCE_LOAD", label: "Balance load", help: "Prefer a balanced daily load across the week." },
  { code: "REDUCE_GAPS", label: "Reduce gaps", help: "Prefer schedules with fewer idle gaps." },
  { code: "PREFER_LAB_BLOCKS", label: "Prefer lab blocks", help: "Keep laboratory sessions in contiguous blocks when possible." },
  { code: "REDUCE_ROOM_CHANGES", label: "Reduce room changes", help: "Prefer fewer room changes between adjacent sessions." },
  { code: "PREFERRED_FACULTY_TIMES", label: "Preferred faculty times", help: "Respect soft faculty time preferences where feasible." },
  { code: "MINIMIZE_REGENERATION_CHANGE", label: "Minimize regeneration change", help: "Prefer stability when regenerating an existing timetable." },
];

const newKey = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const timeValue = (value: string) => value.slice(0, 5);
const minutes = (value: string) => {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};
const displayTime = (value: string) => value ? timeValue(value) : "—";
const asInteger = (value: string) => Number.parseInt(value, 10);
const isIntegerIn = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

function blankTemplate(institutionId: string): Template {
  return {
    id: "",
    institution_id: institutionId,
    code: "DEFAULT",
    name: "Default timing template",
    timezone: "Asia/Kolkata",
    theory_duration_periods: 1,
    tutorial_duration_periods: 1,
    lab_duration_periods: 2,
    max_daily_periods: 6,
    max_consecutive_periods: 3,
  };
}

function blankRule(rule: (typeof SOFT_RULES)[number]): RuleRow {
  return { code: rule.code, name: rule.label, weight: 100, is_active: true, hard_constraint: false };
}

function messageForError(error: { message?: string } | null, fallback: string) {
  if (!error) return fallback;
  if (/permission|row-level security|policy/i.test(error.message ?? "")) return "Your approved administrator account cannot change this record under the current access policy.";
  return error.message || fallback;
}

export default function TimingTemplatePanel() {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadingMessage, setLoadingMessage] = useState("Loading the active semester timing configuration…");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [saving, setSaving] = useState(false);
  const [institutionId, setInstitutionId] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [semester, setSemester] = useState<{ id: string; name: string; number: number } | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [template, setTemplate] = useState<Template | null>(null);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [originalPeriodIds, setOriginalPeriodIds] = useState<string[]>([]);
  const [breaks, setBreaks] = useState<BreakRow[]>([]);
  const [originalBreakIds, setOriginalBreakIds] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<BlockedRow[]>([]);
  const [originalBlockedIds, setOriginalBlockedIds] = useState<string[]>([]);
  const [workingDays, setWorkingDays] = useState<DayRow[]>(DAYS.map((_, index) => ({ day_of_week: index + 1, is_working: index < 5 })));
  const [rules, setRules] = useState<RuleRow[]>(SOFT_RULES.map(blankRule));
  const [templateName, setTemplateName] = useState("");
  const [templateCode, setTemplateCode] = useState("");
  const [showNewTemplate, setShowNewTemplate] = useState(false);

  const selectedTemplateId = template?.id ?? "";

  const load = useCallback(async (nextTemplateId?: string) => {
    const supabase = getBrowserSupabase();
    setError("");
    setSaved("");
    if (!supabase) {
      setLoadState("error");
      setError("Supabase is not configured. Timing settings cannot be loaded or saved.");
      return;
    }
    setLoadState("loading");
    setLoadingMessage("Checking the active semester and administrator scope…");
    try {
      const { data: semesterRows, error: semesterError } = await supabase
        .from("semesters")
        .select("id, name, number, academic_year_id, academic_years!inner(id, name, institution_id, institutions(name))")
        .eq("is_active", true)
        .order("starts_on", { ascending: true })
        .limit(1);
      if (semesterError) throw semesterError;
      const active = semesterRows?.[0];
      if (!active) {
        setSemester(null);
        setLoadState("missing");
        setLoadingMessage("There is no active semester yet.");
        return;
      }
      const year = Array.isArray(active.academic_years) ? active.academic_years[0] : active.academic_years;
      const institution = year?.institution_id;
      if (!institution) {
        setSemester(null);
        setLoadState("missing");
        setLoadingMessage("The active semester is not linked to an institution.");
        return;
      }
      setSemester({ id: active.id, name: active.name, number: active.number });
      setInstitutionId(institution);
      const institutionRelation = year?.institutions as { name?: string } | { name?: string }[] | null | undefined;
      setInstitutionName(Array.isArray(institutionRelation) ? institutionRelation[0]?.name ?? "" : institutionRelation?.name ?? "");

      const [templateResult, ruleResult, mappingResult] = await Promise.all([
        supabase.from("timing_templates").select("id,institution_id,code,name,timezone,theory_duration_periods,tutorial_duration_periods,lab_duration_periods,max_daily_periods,max_consecutive_periods").eq("institution_id", institution).order("name"),
        supabase.from("scheduling_rules").select("id,code,name,weight,is_active,hard_constraint").eq("institution_id", institution).eq("hard_constraint", false).in("code", SOFT_RULES.map((rule) => rule.code)),
        supabase.from("semester_timing_templates").select("semester_id,timing_template_id,is_default").eq("semester_id", active.id).maybeSingle(),
      ]);
      if (templateResult.error) throw templateResult.error;
      if (ruleResult.error) throw ruleResult.error;
      if (mappingResult.error) throw mappingResult.error;
      const loadedTemplates = (templateResult.data ?? []) as Template[];
      setTemplates(loadedTemplates);
      const mappedTemplateId = mappingResult.data?.timing_template_id;
      const chosen = loadedTemplates.find((item) => item.id === nextTemplateId) ?? loadedTemplates.find((item) => item.id === mappedTemplateId) ?? loadedTemplates[0] ?? null;
      setRules(SOFT_RULES.map((rule) => {
        const row = (ruleResult.data ?? []).find((item: RuleRow) => item.code === rule.code);
        return row ? { ...blankRule(rule), ...row, hard_constraint: false } : blankRule(rule);
      }));
      if (!chosen) {
        setTemplate(null);
        setPeriods([]);
        setBreaks([]);
        setBlocked([]);
        setLoadState("ready");
        setLoadingMessage("No timing template exists for this institution.");
        return;
      }
      setTemplate(chosen);
      setTemplateCode(chosen.code);
      setTemplateName(chosen.name);
      setLoadingMessage("Loading periods, breaks, working days, and blocked intervals…");
      const [daysResult, periodsResult, breaksResult, blockedResult] = await Promise.all([
        supabase.from("timing_working_days").select("day_of_week,is_working").eq("timing_template_id", chosen.id).order("day_of_week"),
        supabase.from("timing_periods").select("id,sequence_no,label,starts_at,ends_at,kind").eq("timing_template_id", chosen.id).order("sequence_no"),
        supabase.from("timing_breaks").select("id,label,starts_at,ends_at").eq("timing_template_id", chosen.id).order("starts_at"),
        supabase.from("blocked_periods").select("id,day_of_week,starts_at,ends_at,reason").eq("semester_id", active.id).order("day_of_week").order("starts_at"),
      ]);
      for (const result of [daysResult, periodsResult, breaksResult, blockedResult]) if (result.error) throw result.error;
      const days = (daysResult.data ?? []) as DayRow[];
      setWorkingDays(DAYS.map((_, index) => days.find((row) => row.day_of_week === index + 1) ?? { day_of_week: index + 1, is_working: false }));
      const loadedPeriods = (periodsResult.data ?? []).map((row: Omit<Period, "localId">) => ({ ...row, localId: row.id })) as Period[];
      const loadedBreaks = (breaksResult.data ?? []).map((row: Omit<BreakRow, "localId">) => ({ ...row, localId: row.id })) as BreakRow[];
      const loadedBlocked = (blockedResult.data ?? []).map((row: Omit<BlockedRow, "localId">) => ({ ...row, localId: row.id })) as BlockedRow[];
      setPeriods(loadedPeriods);
      setOriginalPeriodIds(loadedPeriods.map((row) => row.id).filter((id): id is string => Boolean(id)));
      setBreaks(loadedBreaks);
      setOriginalBreakIds(loadedBreaks.map((row) => row.id).filter((id): id is string => Boolean(id)));
      setBlocked(loadedBlocked);
      setOriginalBlockedIds(loadedBlocked.map((row) => row.id).filter((id): id is string => Boolean(id)));
      setLoadState("ready");
    } catch (loadError) {
      setLoadState("error");
      setError(messageForError(loadError as { message?: string }, "The timing configuration could not be loaded."));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const teachingPeriods = useMemo(() => periods.filter((period) => period.kind === "Teaching"), [periods]);
  const workingDayCount = workingDays.filter((day) => day.is_working).length;

  function updateTemplate(field: keyof Template, value: string) {
    setSaved("");
    setTemplate((current) => current ? { ...current, [field]: field === "timezone" || field === "code" || field === "name" ? value : asInteger(value) } : current);
  }
  function updatePeriod(localId: string, field: keyof Period, value: string) {
    setSaved("");
    setPeriods((current) => current.map((row) => row.localId === localId ? { ...row, [field]: field === "sequence_no" ? asInteger(value) : value } : row));
  }
  function updateBreak(localId: string, field: keyof BreakRow, value: string) {
    setSaved("");
    setBreaks((current) => current.map((row) => row.localId === localId ? { ...row, [field]: value } : row));
  }
  function updateBlocked(localId: string, field: keyof BlockedRow, value: string) {
    setSaved("");
    setBlocked((current) => current.map((row) => row.localId === localId ? { ...row, [field]: field === "day_of_week" ? asInteger(value) : value } : row));
  }

  function validate(): string | null {
    if (!template) return "Create or select a timing template first.";
    if (!template.code.trim() || !/^[A-Za-z0-9_-]{2,40}$/.test(template.code.trim())) return "Template code must be 2–40 letters, numbers, underscores, or hyphens.";
    if (!template.name.trim()) return "Enter a name for this timing template.";
    const integerFields: Array<[string, number, number, number]> = [
      ["Theory duration", template.theory_duration_periods, 1, 12],
      ["Tutorial duration", template.tutorial_duration_periods, 1, 12],
      ["Lab duration", template.lab_duration_periods, 1, 12],
      ["Maximum daily periods", template.max_daily_periods, 1, 24],
      ["Maximum consecutive periods", template.max_consecutive_periods, 1, 24],
    ];
    for (const [label, value, min, max] of integerFields) if (!isIntegerIn(value, min, max)) return `${label} must be an integer from ${min} to ${max}.`;
    if (!workingDayCount) return "Choose at least one working weekday.";
    if (!periods.length) return "Add at least one period before saving the template.";
    const sequenceNumbers = new Set<number>();
    for (const period of periods) {
      if (!isIntegerIn(period.sequence_no, 1, 999)) return "Every period sequence number must be an integer from 1 to 999.";
      if (sequenceNumbers.has(period.sequence_no)) return `Sequence number ${period.sequence_no} is used more than once.`;
      sequenceNumbers.add(period.sequence_no);
      if (!period.label.trim()) return "Every period needs a label.";
      if (!Number.isFinite(minutes(period.starts_at)) || !Number.isFinite(minutes(period.ends_at)) || minutes(period.ends_at) <= minutes(period.starts_at)) return `Period “${period.label || period.sequence_no}” must end after it starts.`;
    }
    const byStart = [...periods].sort((a, b) => minutes(a.starts_at) - minutes(b.starts_at));
    for (let index = 1; index < byStart.length; index += 1) if (minutes(byStart[index].starts_at) < minutes(byStart[index - 1].ends_at)) return `Periods “${byStart[index - 1].label}” and “${byStart[index].label}” overlap.`;
    const boundsStart = Math.min(...periods.map((period) => minutes(period.starts_at)));
    const boundsEnd = Math.max(...periods.map((period) => minutes(period.ends_at)));
    if (!Number.isFinite(boundsStart) || !Number.isFinite(boundsEnd) || boundsStart >= boundsEnd) return "Working-day bounds could not be determined from the period rows.";
    for (const period of periods) if (minutes(period.starts_at) < boundsStart || minutes(period.ends_at) > boundsEnd) return `Period “${period.label}” is outside the working-day bounds.`;
    for (const row of breaks) {
      if (!row.label.trim()) return "Every break needs a label.";
      if (!Number.isFinite(minutes(row.starts_at)) || !Number.isFinite(minutes(row.ends_at)) || minutes(row.ends_at) <= minutes(row.starts_at)) return `Break “${row.label || "unnamed"}” must end after it starts.`;
    }
    for (const row of breaks) for (const period of teachingPeriods) if (minutes(period.starts_at) < minutes(row.ends_at) && minutes(period.ends_at) > minutes(row.starts_at)) return `Teaching period “${period.label}” intersects break “${row.label}”.`;
    for (let index = 1; index < [...breaks].sort((a, b) => minutes(a.starts_at) - minutes(b.starts_at)).length; index += 1) {
      const sorted = [...breaks].sort((a, b) => minutes(a.starts_at) - minutes(b.starts_at));
      if (minutes(sorted[index].starts_at) < minutes(sorted[index - 1].ends_at)) return `Breaks “${sorted[index - 1].label}” and “${sorted[index].label}” overlap.`;
    }
    for (const row of blocked) {
      if (!isIntegerIn(row.day_of_week, 1, 7)) return "Blocked intervals must use a valid weekday.";
      if (!row.reason.trim()) return "Every blocked interval needs a reason.";
      if (!Number.isFinite(minutes(row.starts_at)) || !Number.isFinite(minutes(row.ends_at)) || minutes(row.ends_at) <= minutes(row.starts_at)) return `Blocked interval “${row.reason || "unnamed"}” must end after it starts.`;
    }
    for (const rule of rules) if (!isIntegerIn(rule.weight, 1, 1000)) return `Weight for “${rule.name}” must be an integer from 1 to 1000.`;
    return null;
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setSaved("");
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    const supabase = getBrowserSupabase();
    if (!supabase || !template || !semester) { setError("The authenticated database connection or active semester is unavailable."); return; }
    setSaving(true);
    try {
      const templatePayload = {
        institution_id: institutionId,
        code: template.code.trim(),
        name: template.name.trim(),
        timezone: template.timezone.trim() || "Asia/Kolkata",
        theory_duration_periods: template.theory_duration_periods,
        tutorial_duration_periods: template.tutorial_duration_periods,
        lab_duration_periods: template.lab_duration_periods,
        max_daily_periods: template.max_daily_periods,
        max_consecutive_periods: template.max_consecutive_periods,
      };
      let templateId = template.id;
      if (templateId) {
        const { error: updateError } = await supabase.from("timing_templates").update(templatePayload).eq("id", templateId).eq("institution_id", institutionId);
        if (updateError) throw updateError;
      } else {
        const { data, error: insertError } = await supabase.from("timing_templates").insert(templatePayload).select("id,institution_id,code,name,timezone,theory_duration_periods,tutorial_duration_periods,lab_duration_periods,max_daily_periods,max_consecutive_periods").single();
        if (insertError) throw insertError;
        templateId = data.id;
      }
      const { error: mappingError } = await supabase.from("semester_timing_templates").upsert({ semester_id: semester.id, timing_template_id: templateId, is_default: true }, { onConflict: "semester_id" });
      if (mappingError) throw mappingError;
      const dayPayload = workingDays.map((day) => ({ timing_template_id: templateId, day_of_week: day.day_of_week, is_working: day.is_working }));
      const { error: daysError } = await supabase.from("timing_working_days").upsert(dayPayload, { onConflict: "timing_template_id,day_of_week" });
      if (daysError) throw daysError;
      for (const row of periods) {
        const payload = { timing_template_id: templateId, sequence_no: row.sequence_no, label: row.label.trim(), starts_at: timeValue(row.starts_at), ends_at: timeValue(row.ends_at), kind: row.kind };
        const result = row.id ? await supabase.from("timing_periods").update(payload).eq("id", row.id).eq("timing_template_id", templateId) : await supabase.from("timing_periods").insert(payload);
        if (result.error) throw result.error;
      }
      for (const id of originalPeriodIds.filter((value) => !periods.some((row) => row.id === value))) {
        const { error: deleteError } = await supabase.from("timing_periods").delete().eq("id", id).eq("timing_template_id", templateId);
        if (deleteError) throw deleteError;
      }
      for (const row of breaks) {
        const payload = { timing_template_id: templateId, label: row.label.trim(), starts_at: timeValue(row.starts_at), ends_at: timeValue(row.ends_at) };
        const result = row.id ? await supabase.from("timing_breaks").update(payload).eq("id", row.id).eq("timing_template_id", templateId) : await supabase.from("timing_breaks").insert(payload);
        if (result.error) throw result.error;
      }
      for (const id of originalBreakIds.filter((value) => !breaks.some((row) => row.id === value))) {
        const { error: deleteError } = await supabase.from("timing_breaks").delete().eq("id", id).eq("timing_template_id", templateId);
        if (deleteError) throw deleteError;
      }
      for (const row of blocked) {
        const payload = { semester_id: semester.id, day_of_week: row.day_of_week, starts_at: timeValue(row.starts_at), ends_at: timeValue(row.ends_at), reason: row.reason.trim() };
        const result = row.id ? await supabase.from("blocked_periods").update(payload).eq("id", row.id).eq("semester_id", semester.id) : await supabase.from("blocked_periods").insert(payload);
        if (result.error) throw result.error;
      }
      for (const id of originalBlockedIds.filter((value) => !blocked.some((row) => row.id === value))) {
        const { error: deleteError } = await supabase.from("blocked_periods").delete().eq("id", id).eq("semester_id", semester.id);
        if (deleteError) throw deleteError;
      }
      for (const rule of rules) {
        const { error: ruleError } = await supabase.from("scheduling_rules").upsert({ institution_id: institutionId, code: rule.code, name: rule.name, hard_constraint: false, weight: rule.weight, configuration: {}, is_active: rule.is_active }, { onConflict: "institution_id,code" });
        if (ruleError) throw ruleError;
      }
      setSaved("Timing template, semester mapping, and soft preferences saved.");
      await load(templateId);
    } catch (saveError) {
      setError(messageForError(saveError as { message?: string }, "Some timing changes could not be saved. No hard constraints were changed."));
    } finally {
      setSaving(false);
    }
  }

  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setSaved("");
    const code = templateCode.trim(); const name = templateName.trim();
    if (!institutionId || !code || !name || !/^[A-Za-z0-9_-]{2,40}$/.test(code)) { setError("Enter a template name and a 2–40 character code using letters, numbers, underscores, or hyphens."); return; }
    const supabase = getBrowserSupabase();
    if (!supabase) { setError("Supabase is not configured."); return; }
    setSaving(true);
    const { data, error: insertError } = await supabase.from("timing_templates").insert({ institution_id: institutionId, code, name, timezone: "Asia/Kolkata", theory_duration_periods: 1, tutorial_duration_periods: 1, lab_duration_periods: 2, max_daily_periods: 6, max_consecutive_periods: 3 }).select("id,institution_id,code,name,timezone,theory_duration_periods,tutorial_duration_periods,lab_duration_periods,max_daily_periods,max_consecutive_periods").single();
    setSaving(false);
    if (insertError) { setError(messageForError(insertError, "The timing template could not be created.")); return; }
    setShowNewTemplate(false); setTemplateCode(""); setTemplateName("");
    await load(data.id);
  }

  if (loadState === "loading") return <section className="card fade-in" aria-busy="true"><div className="card-title"><div><div className="eyebrow">Scheduling configuration</div><h2 style={{ marginTop: 5 }}>Timing templates</h2></div><span className="spinner" aria-label="Loading" /></div><p className="muted">{loadingMessage}</p></section>;
  if (loadState === "missing") return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Scheduling configuration</div><h2 style={{ marginTop: 5 }}>Timing templates</h2></div><CalendarDays size={19} color="var(--moss)" /></div><div className="empty-state"><div className="empty-icon"><CalendarDays size={19} /></div><h3>{loadingMessage}</h3><p className="muted small">An approved administrator can configure timing after an academic year and active semester have been created.</p></div></section>;
  if (loadState === "error") return <section className="card fade-in"><div className="card-title"><div><div className="eyebrow">Scheduling configuration</div><h2 style={{ marginTop: 5 }}>Timing templates</h2></div><AlertCircle size={19} color="var(--clay)" /></div><div className="alert" role="alert">{error}</div><button className="btn btn-secondary" type="button" onClick={() => void load()}>Retry loading</button></section>;

  return <section className="fade-in" aria-labelledby="timing-panel-title">
    <div className="card" style={{ marginBottom: 13 }}>
      <div className="card-title"><div><div className="eyebrow">Admin-only · {institutionName || "Institution"}</div><h2 id="timing-panel-title" style={{ marginTop: 5 }}>Timing templates</h2><p className="muted small" style={{ margin: "7px 0 0" }}>Configure the reusable day structure for <strong>{semester ? `${semester.name} · Semester ${semester.number}` : "the active semester"}</strong>. All changes use the signed-in browser session and database RLS.</p></div><Settings2 size={19} color="var(--moss)" /></div>
      <div className="filter-row" style={{ alignItems: "end" }}><div className="field" style={{ minWidth: 260, flex: 1, margin: 0 }}><label htmlFor="template-picker">Selected timing template</label><select className="select" id="template-picker" value={selectedTemplateId} onChange={(event) => void load(event.target.value)} disabled={!templates.length}><option value="">{templates.length ? "Choose a template" : "No template yet"}</option>{templates.map((item) => <option value={item.id} key={item.id}>{item.name} ({item.code})</option>)}</select></div><button className="btn btn-secondary" type="button" onClick={() => { setShowNewTemplate((current) => !current); setError(""); }}><Plus size={14} /> New template</button>{template?.id && <button className="btn btn-ghost" type="button" onClick={() => { setTemplate({ ...template, id: "" }); setTemplateCode(`${template.code}-COPY`); setTemplateName(`${template.name} copy`); setPeriods(periods.map((row) => ({ ...row, id: undefined, localId: newKey("period") }))); setBreaks(breaks.map((row) => ({ ...row, id: undefined, localId: newKey("break") }))); setOriginalPeriodIds([]); setOriginalBreakIds([]); setError(""); }}><Copy size={14} /> Duplicate locally</button>}</div>
      {showNewTemplate && <form onSubmit={createTemplate} className="notice" style={{ marginTop: 15 }}><div className="filter-row" style={{ alignItems: "end" }}><div className="field" style={{ flex: 1, margin: 0 }}><label htmlFor="new-template-name">Template name</label><input className="input" id="new-template-name" value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Monday–Saturday" required /></div><div className="field" style={{ width: 170, margin: 0 }}><label htmlFor="new-template-code">Code</label><input className="input" id="new-template-code" value={templateCode} onChange={(event) => setTemplateCode(event.target.value.toUpperCase())} placeholder="WEEKDAY" required /></div><button className="btn btn-primary" type="submit" disabled={saving}>Create</button></div></form>}
      {!template && <div className="empty-state" style={{ padding: "25px 8px 10px" }}><div className="empty-icon"><Clock3 size={19} /></div><h3>No timing template for this institution</h3><p className="muted small">Create one above, then add its working days, period rows, breaks, and limits.</p></div>}
    </div>
    {template && <form onSubmit={save}>
      <div className="dashboard-grid" style={{ alignItems: "start" }}>
        <section className="card"><div className="card-title"><div><div className="eyebrow">Template identity</div><h3 style={{ marginTop: 5 }}>Defaults & workload limits</h3></div><Clock3 size={17} color="var(--moss)" /></div><div className="filter-row"><div className="field" style={{ flex: 1 }}><label htmlFor="timing-name">Name</label><input className="input" id="timing-name" value={template.name} onChange={(event) => updateTemplate("name", event.target.value)} /></div><div className="field" style={{ width: 150 }}><label htmlFor="timing-code">Code</label><input className="input" id="timing-code" value={template.code} onChange={(event) => updateTemplate("code", event.target.value.toUpperCase())} /></div></div><div className="field"><label htmlFor="timing-timezone">Timezone</label><input className="input" id="timing-timezone" value={template.timezone} onChange={(event) => updateTemplate("timezone", event.target.value)} /></div><div className="filter-row"><NumberField id="theory-duration" label="Theory duration (periods)" value={template.theory_duration_periods} onChange={(value) => updateTemplate("theory_duration_periods", value)} min={1} max={12} /><NumberField id="tutorial-duration" label="Tutorial duration" value={template.tutorial_duration_periods} onChange={(value) => updateTemplate("tutorial_duration_periods", value)} min={1} max={12} /><NumberField id="lab-duration" label="Lab duration" value={template.lab_duration_periods} onChange={(value) => updateTemplate("lab_duration_periods", value)} min={1} max={12} /></div><div className="filter-row"><NumberField id="max-daily" label="Max daily periods" value={template.max_daily_periods} onChange={(value) => updateTemplate("max_daily_periods", value)} min={1} max={24} /><NumberField id="max-consecutive" label="Max consecutive" value={template.max_consecutive_periods} onChange={(value) => updateTemplate("max_consecutive_periods", value)} min={1} max={24} /></div><p className="muted small" style={{ marginBottom: 0 }}>Durations and limits are persisted on <code>timing_templates</code>; hard scheduling constraints remain untouched.</p></section>
        <section className="card"><div className="card-title"><div><div className="eyebrow">Weekly cadence</div><h3 style={{ marginTop: 5 }}>Working weekdays</h3></div><CalendarDays size={17} color="var(--moss)" /></div><p className="muted small">Select the days on which teaching may be scheduled.</p><div style={{ display: "grid", gap: 8 }}>{workingDays.map((day) => <label key={day.day_of_week} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 9, background: day.is_working ? "#f4f7ef" : "white" }}><input type="checkbox" checked={day.is_working} onChange={(event) => { setSaved(""); setWorkingDays((current) => current.map((item) => item.day_of_week === day.day_of_week ? { ...item, is_working: event.target.checked } : item)); }} /><span><strong>{DAYS[day.day_of_week - 1]}</strong><span className="muted small" style={{ display: "block" }}>{day.is_working ? "Teaching enabled" : "Non-working day"}</span></span></label>)}</div></section>
      </div>
      <EditorCard title="Periods" eyebrow="Period rows" icon={<Clock3 size={17} color="var(--moss)" />} description="Define non-overlapping period intervals. Teaching rows cannot intersect a break." action={<button className="btn btn-secondary" type="button" onClick={() => setPeriods((current) => [...current, { localId: newKey("period"), sequence_no: current.length + 1, label: `Period ${current.length + 1}`, starts_at: "08:30", ends_at: "09:30", kind: "Teaching" }])}><Plus size={14} /> Add period</button>}>
        {periods.length ? <div className="table-wrap"><table className="timetable"><thead><tr><th>Seq.</th><th>Label</th><th>Starts</th><th>Ends</th><th>Kind</th><th><span className="sr-only">Remove</span></th></tr></thead><tbody>{periods.map((row) => <tr key={row.localId}><td><input className="input" aria-label={`Sequence for ${row.label}`} style={{ width: 72 }} type="number" min={1} max={999} value={row.sequence_no} onChange={(event) => updatePeriod(row.localId, "sequence_no", event.target.value)} /></td><td><input className="input" aria-label={`Label for period ${row.sequence_no}`} value={row.label} onChange={(event) => updatePeriod(row.localId, "label", event.target.value)} /></td><td><input className="input" aria-label={`Start time for ${row.label}`} type="time" value={timeValue(row.starts_at)} onChange={(event) => updatePeriod(row.localId, "starts_at", event.target.value)} /></td><td><input className="input" aria-label={`End time for ${row.label}`} type="time" value={timeValue(row.ends_at)} onChange={(event) => updatePeriod(row.localId, "ends_at", event.target.value)} /></td><td><select className="select" aria-label={`Kind for ${row.label}`} value={row.kind} onChange={(event) => updatePeriod(row.localId, "kind", event.target.value)}><option value="Teaching">Teaching</option><option value="Break">Break row</option></select></td><td><button className="btn btn-ghost" type="button" aria-label={`Remove ${row.label}`} onClick={() => setPeriods((current) => current.filter((item) => item.localId !== row.localId))}><Trash2 size={14} /></button></td></tr>)}</tbody></table></div> : <p className="muted small">No periods yet. Add the first teaching period.</p>}
      </EditorCard>
      <div className="dashboard-grid" style={{ alignItems: "start" }}><EditorCard title="Breaks" eyebrow="Protected intervals" icon={<Clock3 size={17} color="var(--amber)" />} description="Breaks are template-wide intervals and cannot overlap teaching periods." action={<button className="btn btn-secondary" type="button" onClick={() => setBreaks((current) => [...current, { localId: newKey("break"), label: "Break", starts_at: "12:30", ends_at: "13:00" }])}><Plus size={14} /> Add break</button>}>{breaks.length ? <div style={{ display: "grid", gap: 8 }}>{breaks.map((row) => <div key={row.localId} className="filter-row" style={{ alignItems: "end", padding: 10, border: "1px solid var(--line)", borderRadius: 9 }}><div className="field" style={{ flex: 1, margin: 0 }}><label htmlFor={`break-label-${row.localId}`}>Label</label><input className="input" id={`break-label-${row.localId}`} value={row.label} onChange={(event) => updateBreak(row.localId, "label", event.target.value)} /></div><div className="field" style={{ width: 125, margin: 0 }}><label htmlFor={`break-start-${row.localId}`}>Starts</label><input className="input" id={`break-start-${row.localId}`} type="time" value={timeValue(row.starts_at)} onChange={(event) => updateBreak(row.localId, "starts_at", event.target.value)} /></div><div className="field" style={{ width: 125, margin: 0 }}><label htmlFor={`break-end-${row.localId}`}>Ends</label><input className="input" id={`break-end-${row.localId}`} type="time" value={timeValue(row.ends_at)} onChange={(event) => updateBreak(row.localId, "ends_at", event.target.value)} /></div><button className="btn btn-ghost" type="button" aria-label={`Remove ${row.label}`} onClick={() => setBreaks((current) => current.filter((item) => item.localId !== row.localId))}><Trash2 size={14} /></button></div>)}</div> : <p className="muted small">No breaks configured.</p>}</EditorCard>
        <EditorCard title="Blocked intervals" eyebrow="Semester-specific" icon={<CalendarDays size={17} color="var(--clay)" />} description="Use these for events or closures in this semester only." action={<button className="btn btn-secondary" type="button" onClick={() => setBlocked((current) => [...current, { localId: newKey("blocked"), day_of_week: 1, starts_at: "08:30", ends_at: "09:30", reason: "Institution event" }])}><Plus size={14} /> Add block</button>}>{blocked.length ? <div style={{ display: "grid", gap: 8 }}>{blocked.map((row) => <div key={row.localId} style={{ padding: 10, border: "1px solid var(--line)", borderRadius: 9 }}><div className="filter-row" style={{ alignItems: "end" }}><div className="field" style={{ flex: 1, margin: 0 }}><label htmlFor={`blocked-day-${row.localId}`}>Weekday</label><select className="select" id={`blocked-day-${row.localId}`} value={row.day_of_week} onChange={(event) => updateBlocked(row.localId, "day_of_week", event.target.value)}>{DAYS.map((day, index) => <option value={index + 1} key={day}>{day}</option>)}</select></div><div className="field" style={{ width: 112, margin: 0 }}><label htmlFor={`blocked-start-${row.localId}`}>Starts</label><input className="input" id={`blocked-start-${row.localId}`} type="time" value={timeValue(row.starts_at)} onChange={(event) => updateBlocked(row.localId, "starts_at", event.target.value)} /></div><div className="field" style={{ width: 112, margin: 0 }}><label htmlFor={`blocked-end-${row.localId}`}>Ends</label><input className="input" id={`blocked-end-${row.localId}`} type="time" value={timeValue(row.ends_at)} onChange={(event) => updateBlocked(row.localId, "ends_at", event.target.value)} /></div><button className="btn btn-ghost" type="button" aria-label={`Remove blocked interval on ${DAYS[row.day_of_week - 1]}`} onClick={() => setBlocked((current) => current.filter((item) => item.localId !== row.localId))}><Trash2 size={14} /></button></div><div className="field" style={{ marginBottom: 0 }}><label htmlFor={`blocked-reason-${row.localId}`}>Reason</label><input className="input" id={`blocked-reason-${row.localId}`} value={row.reason} onChange={(event) => updateBlocked(row.localId, "reason", event.target.value)} /></div></div>)}</div> : <p className="muted small">No semester-specific blocked intervals.</p>}</EditorCard></div>
      <section className="card" style={{ marginBottom: 13 }}><div className="card-title"><div><div className="eyebrow">Soft preferences</div><h3 style={{ marginTop: 5 }}>Weighted scheduling rules</h3></div><Settings2 size={17} color="var(--moss)" /></div><p className="muted small">Weights are advisory only. This panel writes only rows with <code>hard_constraint = false</code>; hard constraints are never changed here.</p><div className="table-wrap"><table className="timetable"><thead><tr><th>Use</th><th>Preference</th><th>Weight (1–1000)</th><th>What it influences</th></tr></thead><tbody>{rules.map((rule) => <tr key={rule.code}><td><input type="checkbox" aria-label={`Enable ${rule.name}`} checked={rule.is_active} onChange={(event) => setRules((current) => current.map((item) => item.code === rule.code ? { ...item, is_active: event.target.checked } : item))} /></td><td><strong>{rule.name}</strong><div className="muted small">{rule.code}</div></td><td><input className="input" aria-label={`Weight for ${rule.name}`} type="number" min={1} max={1000} value={rule.weight} onChange={(event) => setRules((current) => current.map((item) => item.code === rule.code ? { ...item, weight: asInteger(event.target.value) } : item))} /></td><td className="muted small">{SOFT_RULES.find((item) => item.code === rule.code)?.help}</td></tr>)}</tbody></table></div></section>
      {error && <div className="alert" role="alert" style={{ marginBottom: 13 }}><AlertCircle size={15} /> {error}</div>}{saved && <div className="notice" role="status" style={{ marginBottom: 13 }}><Check size={15} /> {saved}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, alignItems: "center" }}><span className="muted small">{periods.length} periods · {workingDayCount} working days · {blocked.length} blocked intervals</span><button className="btn btn-primary" type="submit" disabled={saving} aria-busy={saving}>{saving ? <span className="spinner" aria-hidden="true" /> : <Save size={14} />} {saving ? "Saving…" : "Save timing configuration"}</button></div>
    </form>}
  </section>;
}

function NumberField({ id, label, value, onChange, min, max }: { id: string; label: string; value: number; onChange: (value: string) => void; min: number; max: number }) {
  return <div className="field" style={{ flex: 1, minWidth: 125 }}><label htmlFor={id}>{label}</label><input className="input" id={id} type="number" min={min} max={max} step={1} value={Number.isFinite(value) ? value : ""} onChange={(event) => onChange(event.target.value)} /></div>;
}

function EditorCard({ title, eyebrow, icon, description, action, children }: { title: string; eyebrow: string; icon: React.ReactNode; description: string; action: React.ReactNode; children: React.ReactNode }) {
  return <section className="card" style={{ marginBottom: 13 }}><div className="card-title"><div><div className="eyebrow">{eyebrow}</div><h3 style={{ marginTop: 5 }}>{title}</h3></div><div style={{ display: "flex", alignItems: "center", gap: 10 }}>{icon}{action}</div></div><p className="muted small">{description}</p>{children}</section>;
}
