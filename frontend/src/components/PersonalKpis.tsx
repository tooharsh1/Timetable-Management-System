"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Clock3 } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import type { AppRole } from "@/lib/supabase-types";

type Stats = { published: number; today: number; weekCount: number; hours: number; loading: boolean; error: boolean };
function minutes(value: string) { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return hour * 60 + minute; }

export function PersonalKpis({ role }: { role: Extract<AppRole, "teacher" | "student"> }) {
  const [stats, setStats] = useState<Stats>({ published: 0, today: 0, weekCount: 0, hours: 0, loading: true, error: false });
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = getBrowserSupabase();
      if (!supabase) { if (!cancelled) setStats((current) => ({ ...current, loading: false, error: true })); return; }
      const { data, error } = await supabase.from("published_schedule").select("day_of_week,starts_at,ends_at");
      if (error) { if (!cancelled) setStats({ published: 0, today: 0, weekCount: 0, hours: 0, loading: false, error: true }); return; }
      const rows = data ?? [];
      const today = new Date().getDay() || 7;
      const totalMinutes = rows.reduce((total, row) => total + Math.max(0, minutes(String(row.ends_at)) - minutes(String(row.starts_at))), 0);
      if (!cancelled) setStats({ published: rows.length, today: rows.filter((row) => Number(row.day_of_week) === today).length, weekCount: rows.length, hours: Math.round(totalMinutes / 60 * 10) / 10, loading: false, error: false });
    }
    void load();
    return () => { cancelled = true; };
  }, []);
  const waiting = stats.loading ? "Loading…" : stats.error ? "Unavailable" : stats.published ? "Available" : "Awaiting publication";
  return <div className="kpi-grid">
    <div className="card kpi"><div className="kpi-label">Published schedule</div><div className="kpi-value" style={{ fontFamily: "inherit", fontSize: 17, marginTop: 15 }}>{waiting}</div><div className="kpi-note">Only approved sessions appear here</div></div>
    <div className="card kpi"><div className="kpi-label">Today</div><div className="kpi-value">{stats.loading ? "—" : stats.error ? "—" : stats.today}</div><div className="kpi-note"><CalendarDays size={11} style={{ display: "inline" }} /> {role === "teacher" ? "teaching sessions" : "class sessions"}</div></div>
    <div className="card kpi"><div className="kpi-label">This week</div><div className="kpi-value">{stats.loading || stats.error ? "—" : stats.weekCount}</div><div className="kpi-note">published sessions · {stats.hours} hours</div></div>
    <div className="card kpi"><div className="kpi-label">Academic period</div><div className="kpi-value" style={{ fontFamily: "inherit", fontSize: 17, marginTop: 15 }}>Active semester</div><div className="kpi-note"><Clock3 size={11} style={{ display: "inline" }} /> timetable follows your assigned scope</div></div>
  </div>;
}
