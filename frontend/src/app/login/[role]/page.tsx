import Link from "next/link";
import { notFound } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { hasSupabaseConfig } from "@/lib/supabase-browser";
import { isAppRole, type AppRole } from "@/lib/supabase-types";

const copy: Record<AppRole, { title: string; text: string; icon: string }> = {
  admin: { title: "Set the week in motion.", text: "A focused workspace for academic setup, conflict-aware generation, review, and publication.", icon: "✳" },
  teacher: { title: "Your week, at a glance.", text: "Keep your teaching schedule close and share availability preferences with the administration.", icon: "⌂" },
  student: { title: "Know where your day begins.", text: "Find the latest published sessions for your class, division, and practical batch.", icon: "◷" },
};

export default async function RoleLoginPage({ params }: { params: Promise<{ role: string }> }) {
  const { role: rawRole } = await params;
  if (!isAppRole(rawRole)) notFound();
  const role = rawRole;
  const text = copy[role];
  return (
    <main className="login-page">
      <section className="login-art" aria-label="Institution information">
        <Link className="login-side-brand" href="/"><img src="/rgit-mark.svg" alt="" /><span>RGIT <span style={{ color: "#d6b66a" }}>·</span> Timetable</span></Link>
        <div className="login-hero-copy">
          <div className="eyebrow" style={{ color: "#d4bd83" }}>MCT · Rajiv Gandhi Institute of Technology</div>
          <h1>{text.title}</h1>
          <p>{text.text}</p>
        </div>
        <div className="login-caption">Your approved account determines what you can see and change.</div>
      </section>
      <section className="login-form-area">
        <div className="login-card fade-in">
          <Link href="/" className="muted small">← All workspaces</Link>
          <div className="eyebrow" style={{ marginTop: 22 }}>{role} workspace</div>
          <h1 style={{ fontSize: 29, marginTop: 6 }}>Sign in</h1>
          <p className="subtitle">Use the account provisioned for your role.</p>
          <div className="role-switch" aria-label="Select sign-in entry point">
            {(["admin", "teacher", "student"] as const).map((value) => (
              <Link key={value} className={`role-option ${value === role ? "selected" : ""}`} href={`/login/${value}`} aria-current={value === role ? "page" : undefined}>{value === "admin" ? "Admin" : value[0].toUpperCase() + value.slice(1)}</Link>
            ))}
          </div>
          <LoginForm role={role} configured={hasSupabaseConfig()} />
          <p className="muted small" style={{ marginTop: 19 }}>Need access? Ask an RGIT administrator to create your account and assign your academic scope.</p>
        </div>
      </section>
    </main>
  );
}
