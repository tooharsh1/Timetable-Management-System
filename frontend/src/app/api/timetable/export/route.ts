import { NextResponse, type NextRequest } from "next/server";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { getAuthenticatedProfile } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExportRow = { day: string; start: string; end: string; subjectCode: string; subject: string; type: string; groups: string; faculty: string; room: string; duration: number; isBreak: boolean };
const DAYS: Record<number, string> = { 1: "Monday", 2: "Tuesday", 3: "Wednesday", 4: "Thursday", 5: "Friday", 6: "Saturday", 7: "Sunday" };
function relation(value: any) { return Array.isArray(value) ? value[0] ?? {} : value ?? {}; }
function normalize(row: any, scoped: boolean): ExportRow {
  const subject = relation(row.subjects);
  const faculty = relation(row.faculty);
  const room = relation(row.rooms);
  const dayNo = Number(row.day_of_week);
  return {
    day: DAYS[dayNo] ?? "—",
    start: String(row.starts_at ?? "").slice(0, 5),
    end: String(row.ends_at ?? "").slice(0, 5),
    subjectCode: String(row.subject_code ?? subject.code ?? ""),
    subject: String(row.subject_name ?? subject.short_name ?? subject.name ?? ""),
    type: String(row.session_type ?? "").replace("Lecture", "Lecture").replace("Practical", "Practical"),
    groups: String(row.participant_groups ?? (row.session_participants ?? []).map((item: any) => relation(item.student_groups).name).filter(Boolean).join(", ")),
    faculty: String(row.faculty_initials ?? faculty.initials ?? "—"),
    room: String(row.room_code ?? room.code ?? "—"),
    duration: Number(row.duration_periods ?? 1),
    isBreak: false,
  };
}

async function pdfBuffer(title: string, rows: ExportRow[]) {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margins: { top: 34, bottom: 34, left: 32, right: 32 }, info: { Title: title, Author: "RGIT Timetable Office" } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const pageWidth = doc.page.width - 64;
  const columns = [
    { label: "DAY", key: "day" as const, width: 61 },
    { label: "TIME", key: "start" as const, width: 82 },
    { label: "SUBJECT", key: "subject" as const, width: 171 },
    { label: "CODE", key: "subjectCode" as const, width: 72 },
    { label: "SESSION / CLASS", key: "type" as const, width: 150 },
    { label: "FACULTY", key: "faculty" as const, width: 70 },
    { label: "ROOM", key: "room" as const, width: 82 },
  ];
  columns[4].width = pageWidth - columns.slice(0, 4).reduce((sum, col) => sum + col.width, 0) - columns[5].width - columns[6].width;
  const drawHeader = () => {
    doc.font("Helvetica-Bold").fontSize(15).fillColor("#304f40").text(title, 32, 28);
    doc.font("Helvetica").fontSize(8).fillColor("#738078").text("Rajiv Gandhi Institute of Technology · MCT · RGIT Timetable Management", 32, 48);
    let x = 32; const y = 68; const h = 22;
    columns.forEach((column) => { doc.rect(x, y, column.width, h).fillAndStroke("#e9eee4", "#d8ded3"); doc.fillColor("#3b5143").font("Helvetica-Bold").fontSize(7).text(column.label, x + 5, y + 7, { width: column.width - 10 }); x += column.width; });
    return y + h;
  };
  let y = drawHeader();
  for (const row of rows) {
    const cells = [row.day, `${row.start}–${row.end}`, row.subject, row.subjectCode, row.isBreak ? "Break" : `${row.type}${row.groups ? ` · ${row.groups}` : ""} · ${row.duration} period${row.duration === 1 ? "" : "s"}`, row.faculty, row.room];
    const heights = cells.map((value, i) => doc.font("Helvetica").fontSize(8).heightOfString(value || "—", { width: columns[i].width - 10 }));
    const h = Math.max(25, ...heights.map((height) => height + 9));
    if (y + h > doc.page.height - 45) { doc.addPage(); y = drawHeader(); }
    let x = 32;
    cells.forEach((value, i) => { doc.rect(x, y, columns[i].width, h).fillAndStroke("#fffdf7", "#e7e2d8"); doc.fillColor("#26362e").font("Helvetica").fontSize(8).text(value || "—", x + 5, y + 5, { width: columns[i].width - 10, height: h - 8 }); x += columns[i].width; });
    y += h;
  }
  const subjects = [...new Set(rows.filter((row) => !row.isBreak).map((row) => `${row.subjectCode} — ${row.subject}`).filter((value) => value !== " — "))];
  const faculty = [...new Set(rows.filter((row) => !row.isBreak).map((row) => row.faculty).filter((value) => value !== "—"))];
  if (y + 48 > doc.page.height - 34) { doc.addPage(); y = 42; }
  doc.moveDown(1).font("Helvetica-Bold").fontSize(8).fillColor("#304f40").text("SUBJECT LEGEND", 32, y + 9);
  doc.font("Helvetica").fontSize(7).fillColor("#4d5b52").text(subjects.join("   ·   ") || "No subject legend", 32, y + 21, { width: pageWidth });
  doc.font("Helvetica-Bold").fontSize(8).fillColor("#304f40").text("FACULTY INITIALS", 32, y + 36);
  doc.font("Helvetica").fontSize(7).fillColor("#4d5b52").text(faculty.join("   ·   ") || "No faculty legend", 32, y + 48, { width: pageWidth });
  doc.end();
  return done;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const format = searchParams.get("format");
  const requestedSemester = searchParams.get("semester_id");
  const requestedVersion = searchParams.get("version_id");
  if (format !== "pdf" && format !== "xlsx") return NextResponse.json({ error: "Choose pdf or xlsx." }, { status: 400 });
  const { supabase, user, profile, configured } = await getAuthenticatedProfile();
  if (!configured) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  if (!user || !profile) return NextResponse.json({ error: "Authentication is required." }, { status: 401 });

  try {
    let data: any[] = [];
    let semesterId = "";
    let exportStatus = "Published";
    if (profile.role === "admin") {
      const semesterQuery = supabase!.from("semesters").select("id");
      const { data: semester, error: semesterError } = requestedSemester ? await semesterQuery.eq("id", requestedSemester).maybeSingle() : await semesterQuery.eq("is_active", true).order("starts_on", { ascending: false }).limit(1).maybeSingle();
      if (semesterError) throw new Error(semesterError.message);
      if (!semester) return NextResponse.json({ error: "Choose an existing semester before exporting." }, { status: 404 });
      semesterId = String(semester.id);
      const versionQuery = supabase!.from("timetable_versions").select("id,status").eq("semester_id", semesterId);
      const { data: version, error: versionError } = requestedVersion ? await versionQuery.eq("id", requestedVersion).in("status", ["Draft", "Under Review", "Published"]).maybeSingle() : await versionQuery.eq("status", "Published").limit(1).maybeSingle();
      if (versionError) throw new Error(versionError.message);
      if (!version) return NextResponse.json({ error: "That timetable version is unavailable in this semester." }, { status: 404 });
      exportStatus = String(version.status);
      const result = await supabase!.from("timetable_sessions").select("id,day_of_week,starts_at,ends_at,duration_periods,session_type,subjects(code,name,short_name),faculty(initials),rooms(code,name),session_participants(student_groups(name))").eq("version_id", version.id).order("day_of_week").order("starts_at");
      if (result.error) throw new Error(result.error.message);
      data = result.data ?? [];
    } else {
      const { data: semesters, error: semesterError } = await supabase!.from("semesters").select("id").eq("is_active", true).order("starts_on", { ascending: false }).limit(1);
      if (semesterError) throw new Error(semesterError.message);
      semesterId = String(semesters?.[0]?.id ?? "");
      if (!semesterId) return NextResponse.json({ error: "There is no active semester." }, { status: 404 });
      const result = await supabase!.from("published_schedule").select("session_id,semester_id,subject_code,subject_name,session_type,day_of_week,starts_at,ends_at,duration_periods,faculty_initials,room_code,room_name,participant_groups").eq("semester_id", semesterId).order("day_of_week").order("starts_at");
      if (result.error) throw new Error(result.error.message);
      data = result.data ?? [];
    }
    if (!data.length) return NextResponse.json({ error: "No published sessions are available for this account." }, { status: 404 });
    const normalized = data.map((row) => normalize(row, profile.role !== "admin"));
    const { data: mapping, error: mappingError } = await supabase!.from("semester_timing_templates").select("timing_template_id").eq("semester_id", semesterId).maybeSingle();
    if (mappingError) throw new Error(mappingError.message);
    if (mapping?.timing_template_id) {
      const [{ data: breaks, error: breaksError }, { data: workingDays, error: daysError }] = await Promise.all([
        supabase!.from("timing_breaks").select("label,starts_at,ends_at").eq("timing_template_id", String(mapping.timing_template_id)).order("starts_at"),
        supabase!.from("timing_working_days").select("day_of_week").eq("timing_template_id", String(mapping.timing_template_id)).eq("is_working", true),
      ]);
      if (breaksError || daysError) throw new Error(breaksError?.message ?? daysError?.message ?? "Breaks could not be loaded.");
      for (const dayNo of (workingDays ?? []).map((row) => Number(row.day_of_week))) for (const item of breaks ?? []) normalized.push({ day: DAYS[dayNo] ?? "—", start: String(item.starts_at).slice(0, 5), end: String(item.ends_at).slice(0, 5), subjectCode: "", subject: String(item.label), type: "Break", groups: "", faculty: "—", room: "—", duration: 0, isBreak: true });
    }
    normalized.sort((a, b) => Object.keys(DAYS).findIndex((key) => DAYS[Number(key)] === a.day) - Object.keys(DAYS).findIndex((key) => DAYS[Number(key)] === b.day) || a.start.localeCompare(b.start));
    const institution = await supabase!.from("institutions").select("name").limit(1).maybeSingle();
    const title = institution.data?.name?.replace(" (DEMO DATA)", "") ?? "RGIT Timetable";
    const reportTitle = `${title} · ${exportStatus} Timetable`;

    if (format === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "RGIT Timetable Office";
      workbook.created = new Date();
      const sheet = workbook.addWorksheet(`${exportStatus} timetable`, { views: [{ state: "frozen", ySplit: 1 }] });
      sheet.columns = [
        { header: "Day", key: "day", width: 15 }, { header: "Start", key: "start", width: 12 }, { header: "End", key: "end", width: 12 },
        { header: "Subject code", key: "subjectCode", width: 17 }, { header: "Subject", key: "subject", width: 32 }, { header: "Session type", key: "type", width: 16 },
        { header: "Class / division / batch", key: "groups", width: 34 }, { header: "Faculty initials", key: "faculty", width: 16 }, { header: "Room", key: "room", width: 18 }, { header: "Duration (periods)", key: "duration", width: 19 },
      ];
      sheet.addRows(normalized);
      sheet.getRow(1).font = { bold: true, color: { argb: "FF304F40" } };
      sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EEE4" } };
      sheet.autoFilter = { from: "A1", to: "J1" };
      sheet.eachRow((row, rowNumber) => { if (rowNumber > 1) row.alignment = { vertical: "top", wrapText: true }; });
      const buffer = await workbook.xlsx.writeBuffer();
      return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=rgit-published-timetable.xlsx", "Cache-Control": "private, no-store" } });
    }
    const buffer = await pdfBuffer(reportTitle, normalized);
    return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename=rgit-${exportStatus.toLowerCase().replace(/\s+/g, "-")}-timetable.pdf`, "Cache-Control": "private, no-store" } });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Export could not be generated.";
    return NextResponse.json({ error: message }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
