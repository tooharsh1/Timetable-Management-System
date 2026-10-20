"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LockKeyhole, LoaderCircle } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase-browser";
import type { AppRole } from "@/lib/supabase-types";

const roleLabels: Record<AppRole, string> = { admin: "Administrator", teacher: "Teacher", student: "Student" };

export function LoginForm({ role, configured }: { role: AppRole; configured: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    if (!configured) {
      setMessage("Supabase is not configured yet. Add the required environment values from .env.example before signing in.");
      return;
    }
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setMessage("Sign-in is unavailable because Supabase configuration is incomplete.");
      return;
    }
    setBusy(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (signInError) {
      setMessage("We could not sign you in. Check your details or ask an administrator to provision your account.");
      setBusy(false);
      return;
    }
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      setMessage("Your session could not be verified. Please try again.");
      setBusy(false);
      return;
    }
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("role, admin_approved")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError || !profile) {
      setMessage("Your account is signed in, but no approved timetable role is assigned yet. Contact an administrator.");
      setBusy(false);
      return;
    }
    const assignedRole = String(profile.role).toLowerCase() as AppRole;
    if (assignedRole === "admin" && profile.admin_approved !== true) {
      setMessage("Administrator approval is required before this account can use the admin workspace.");
      setBusy(false);
      return;
    }
    if (!(assignedRole in roleLabels)) {
      setMessage("This account has no valid timetable role. Contact an administrator.");
      setBusy(false);
      return;
    }
    if (assignedRole !== role) {
      setMessage(`This account is assigned as ${roleLabels[assignedRole]}. Choose the matching sign-in entry point.`);
      setBusy(false);
      return;
    }
    router.replace(`/workspace/${assignedRole}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} aria-label={`${roleLabels[role]} sign in`}>
      {!configured && <div className="notice" role="status" style={{ marginBottom: 16 }}>Supabase setup is required before accounts can sign in. No demo role is granted from this page.</div>}
      {message && <div className="alert" role="alert" style={{ marginBottom: 14 }}>{message}</div>}
      <div className="field">
        <label htmlFor="email">Institution email</label>
        <input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@rgit.ac.in" />
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" />
      </div>
      <button className="btn btn-primary w-full" type="submit" disabled={busy} aria-busy={busy}>
        {busy ? <LoaderCircle className="spinner" aria-hidden="true" /> : <LockKeyhole size={15} aria-hidden="true" />}
        {busy ? "Verifying access…" : `Sign in as ${roleLabels[role]}`}
        {!busy && <ArrowRight size={14} aria-hidden="true" />}
      </button>
      <p className="muted small" style={{ margin: "14px 0 0", textAlign: "center" }}>Your role comes from your approved account profile.</p>
    </form>
  );
}
