import Link from "next/link";

const roleCards = [
  { role: "admin", title: "Administrator", summary: "Configure academic data, generate schedules, and publish revisions.", icon: "✳" },
  { role: "teacher", title: "Teacher", summary: "Check your teaching week and share availability preferences.", icon: "⌂" },
  { role: "student", title: "Student", summary: "Find your published class and practical timetable.", icon: "◷" },
] as const;

export default function HomePage() {
  return (
    <main className="login-page">
      <section className="login-art" aria-label="About the timetable system">
        <div className="login-side-brand"><img src="/rgit-mark.svg" alt="" /><span>RGIT <span style={{ color: "#d6b66a" }}>·</span> Timetable</span></div>
        <div className="login-hero-copy">
          <div className="eyebrow" style={{ color: "#d4bd83" }}>MCT · Rajiv Gandhi Institute of Technology</div>
          <h1>A well-planned week leaves room to learn.</h1>
          <p>A calm, dependable place to build schedules, coordinate shared resources, and stay in step with the semester.</p>
        </div>
        <div className="login-caption">A flexible academic scheduling workspace · Mumbai</div>
      </section>
      <section className="login-form-area">
        <div className="login-card fade-in">
          <div className="eyebrow">Choose your workspace</div>
          <h1 style={{ fontSize: 30, marginTop: 7 }}>Sign in to continue</h1>
          <p className="subtitle">Your access is determined by your account permissions, not this selection.</p>
          <div style={{ display: "grid", gap: 11, marginTop: 25 }}>
            {roleCards.map((item) => (
              <Link className="card" href={`/login/${item.role}`} key={item.role} style={{ display: "flex", alignItems: "center", gap: 14, padding: 15, transition: "transform .16s ease" }}>
                <span className="empty-icon" style={{ margin: 0, width: 42, height: 42, flexShrink: 0 }}>{item.icon}</span>
                <span style={{ flex: 1 }}><strong style={{ display: "block", fontSize: 13 }}>{item.title}</strong><span className="muted small">{item.summary}</span></span>
                <span aria-hidden="true" style={{ color: "var(--moss)" }}>→</span>
              </Link>
            ))}
          </div>
          <p className="muted small" style={{ marginTop: 19 }}>Accounts are provisioned by an administrator. New users cannot assign themselves a role.</p>
        </div>
      </section>
    </main>
  );
}
