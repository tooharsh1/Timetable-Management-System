import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Workspace } from "@/components/Workspace";
import { getAuthenticatedProfile } from "@/lib/supabase-server";
import { isAppRole, type AppRole } from "@/lib/supabase-types";

const labels: Record<AppRole, string> = { admin: "Administrator", teacher: "Teacher", student: "Student" };

export default async function WorkspacePage({ params }: { params: Promise<{ role: string }> }) {
  const { role: requested } = await params;
  if (!isAppRole(requested)) notFound();
  const result = await getAuthenticatedProfile();

  if (!result.configured) {
    return <main className="login-form-area" style={{ minHeight: "100vh" }}><section className="card" style={{ width: "min(100%,560px)" }}><div className="eyebrow">Setup required</div><h1 style={{ fontSize: 30, marginTop: 8 }}>Connect the timetable database</h1><p className="muted">Supabase Auth and PostgreSQL credentials are not configured in this environment. The application does not create a demo session or grant a role from the URL.</p><div className="notice">Use the secure environment setup in the project README, then return to this sign-in page.</div><Link className="btn btn-primary" href={`/login/${requested}`} style={{ marginTop: 16 }}>Back to sign in</Link></section></main>;
  }
  if (!result.user) redirect(`/login/${requested}`);
  if (!result.profile) {
    return <main className="login-form-area" style={{ minHeight: "100vh" }}><section className="card" style={{ width: "min(100%,560px)" }}><div className="eyebrow">Account pending</div><h1 style={{ fontSize: 30, marginTop: 8 }}>Your access is not assigned</h1><p className="muted">Your account is authenticated, but it has no approved RGIT timetable profile. Ask an administrator to provision the correct role.</p><Link className="btn btn-secondary" href="/">Choose another sign-in entry</Link></section></main>;
  }
  if (result.profile.role !== requested) {
    return <main className="login-form-area" style={{ minHeight: "100vh" }}><section className="card" role="alert" style={{ width: "min(100%,560px)" }}><div className="eyebrow">Permission denied</div><h1 style={{ fontSize: 30, marginTop: 8 }}>This is not your workspace</h1><p className="muted">Your approved account is assigned to {labels[result.profile.role]}. Selecting another role in the address bar cannot change your permissions.</p><Link className="btn btn-primary" href={`/workspace/${result.profile.role}`}>Open my workspace</Link></section></main>;
  }
  return <Workspace role={requested} profile={result.profile} />;
}
