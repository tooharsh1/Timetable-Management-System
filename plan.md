# RGIT Timetable Management — Implementation Plan

## Product approach

Build a responsive, role-aware timetable management application for MCT’s Rajiv Gandhi Institute of Technology, Mumbai, while keeping institution identity, academic calendars, schedules and rules configurable for reuse by other colleges. Follow the stack requested in the brief: Next.js + TypeScript for the application, Supabase Auth and PostgreSQL with row-level security for identity and persistent academic data, and a separate Python FastAPI scheduling API/worker using OR-Tools CP-SAT. Keep the frontend, academic model, solver, independent validator and export code as separable modules. The managed Webdev server/database are enabled in the project, but the application’s declared data design will use the requested Supabase/PostgreSQL service; credentials will be supplied only through protected environment configuration, never committed or exposed to the browser.

The main admin path is setup → validation → generate → independently validate → review/edit → approve → publish. Generation is a background job with explicit progress and solver outcome states. Editing works on a draft copy; a requested placement is fixed during repair, existing locks remain fixed, and CP-SAT minimizes movement of other sessions. A repair preview lists changed sessions and is committed only after administrator acceptance. Failed repairs do not overwrite the previous schedule. Teachers and students resolve only the latest published version, not drafts or under-review revisions.

## Application organization

- `frontend/src/app/`: Next.js App Router pages for role-specific login/workspaces and server API routes for generation, job polling, repair/locks, review/publication, export, and health.
- `frontend/src/components/`: shared dashboard, academic setup, timing-template editor, availability and user-access panels, timetable board/editor, personal metrics, and version review UI.
- `frontend/src/lib/`: browser/server Supabase clients, role/profile helpers, schedule-input mapping, validated API utilities, and display utilities. The selected login role is never treated as authorization; role assignment comes from protected profile data.
- `solver/app/`: FastAPI endpoints, Pydantic request/response contracts, protected generation/validation, Redis-backed generation-job lifecycle, health endpoint, and the separate worker entrypoint.
- `solver/engine/`: explicit models for sessions, times, groups, faculty, rooms and constraints; CP-SAT candidate assignment; objective weights for soft preferences; repair mode with fixed requested placement, locked sessions and movement penalties; independent schedule validator and human-readable diagnostics.
- `solver/tests/`: focused OR-Tools and independent-validator tests using isolated solver inputs. Frontend end-to-end tests are not yet present.
- `supabase/migrations/`: normalized PostgreSQL schema, foreign keys, constraints, indexes, exactly-three-role RLS policies, role escalation prevention, audit, atomic generation/repair/publication, and server-side permission boundaries.
- `supabase/seed.sql`: clearly labelled multi-department RGIT demonstration master data. Demo accounts and generated timetables are created only through operator-controlled setup, not fabricated in the seed.
- Root deployment files: `Dockerfile` for Next.js, `solver/Dockerfile` for API/worker, `docker-compose.yml` for web/API/worker/Redis, pinned package dependencies, `.env.example`, `README.md`, and `TODO.md`. Supabase/PostgreSQL is an external configured service rather than a PostgreSQL container in Compose.

## Data and security model

Model institutions, departments/programmes, academic years, semesters, classes/divisions/batches, student groups and elective enrolments; subjects and weekly teaching requirements; faculty, eligibility, assignments, availability and workload; rooms, facilities and capacity; timing templates, period definitions, breaks and blocked intervals; rule priorities; generation jobs; timetable versions and sessions; participants, locks, approvals, audit entries and publication pointers. Combined sessions attach every attending group to one shared session; parallel practicals and electives remain separate sessions with explicit group/enrolment conflicts.

Supabase Auth establishes identity. A protected user profile maps an authenticated identity to Admin, Teacher or Student and to the relevant faculty/student group. Users cannot assign themselves Admin. Supabase RLS policies scope student and teacher reads to their own published schedules and scope administrative operations to authorized admins; privileged server-side credentials stay on the API/server only. Validate input on both boundaries and use version/revision checks or optimistic locking so concurrent edits cannot silently overwrite one another. Publication updates the active-version pointer transactionally.

## Scheduling and workflow behavior

Expand weekly requirements into explicit session instances. Generate candidate placements only where working-day periods and continuous duration fit the configured timing template, including breaks and blocked activities. Model hard constraints for faculty, room and overlapping-group clashes; shared teachers/rooms across departments; combined-class attendance; elective conflict groups/enrolment; faculty eligibility/availability/workload; room capacity/facilities; required weekly counts; locks; and lab continuity. Weighted soft objectives can spread repeated subjects, balance daily load, reduce gaps/room changes, respect faculty preferences and minimize regeneration movement, without relaxing a hard constraint.

Return and display distinct `FEASIBLE`, `OPTIMAL`, `INFEASIBLE`, `TIME_LIMIT_NO_SOLUTION`, `VALIDATION_ERROR` and `EXECUTION_ERROR` outcomes. A timeout is not called infeasible and a partial schedule is never presented as a successful complete result. Before approval/publication, independently recompute completeness, interval fit, conflicts, capacity, participant overlap and lock preservation. Diagnostics identify actionable setup gaps without claiming an exact unsatisfiable core unless the solver actually produces one.

Maintain Draft, Under Review and Published versions with actor/time audit, comparisons and restore-to-draft. Any edit after approval invalidates that approval. PDF/spreadsheet/print output includes institution metadata, periods/breaks, legends, parallel session lanes and continuous lab blocks; exports are generated from the selected version and filters.

## Design direction

- **Design Movement:** Cozy, village-inspired editorial warmth translated into a precise academic operations workspace.
- **Core Principles:** Calm clarity; useful density; visible state and ownership; accessible, predictable controls.
- **Color Philosophy:** Warm cream grounds long work sessions; muted leaf green signals stable/published states; terracotta highlights changes and attention; soft amber marks pending decisions. Use dark ink for readable contrast and never rely on color alone.
- **Layout Paradigm:** A compact left navigation rail and broad, work-first canvas; dashboards use a narrow status rail beside actionable content, while timetable pages give most width to the schedule with filters and legends in a slim control band.
- **Signature Elements:** Fine timetable-rule lines; small leaf-like status marks; warm terracotta edit indicators and lock chips.
- **Interaction Philosophy:** Immediate validation, clear previews before committing consequential schedule changes, keyboard-operable menus and forms, and concise explanations close to the affected control.
- **Animation:** Short, restrained 120–180 ms transitions for navigation, card/state changes and dialogs; reduced-motion preference respected; no motion on schedule grids that interferes with scanning.
- **Typography System:** A readable humanist sans-serif for UI and data, paired with a restrained serif display face only for page headings; tabular numerals for times, consistent label hierarchy, and compact but legible grid text.
- **Brand Essence:** A dependable planning desk for RGIT and adaptable university teams; warm, precise, considerate.
- **Brand Voice:** Clear, helpful and operational. Example: “The week is ready for review.” “This change affects two practical groups; nothing has been moved yet.”
- **Wordmark & Logo:** A compact RGIT monogram formed from three stacked timetable rows with one terracotta session block; institution name remains configurable beside it.
- **Signature Brand Color:** Deep garden green, used for the primary navigation and stable schedule states.

## Runtime and deployment boundaries

The Next.js frontend and Python API/worker are separate deployable services. The frontend is suitable for Vercel; the solver API and background worker use a Docker-capable service with Redis and the configured PostgreSQL/Supabase database. Local development uses pinned dependencies and Compose for web/API/worker/Redis, with credentials in ignored environment files. No long-running solver is placed inside a static frontend deployment. Deployment docs cover Supabase project setup, migrations, demo user creation, environment variables, frontend/API origins, worker/broker, health checks, and separate releases. Current scope limitations are one timing template per semester and one institution per Supabase project until Admin permissions are institution-scoped.

## Scope boundary and material dependency

The optional payment extension is excluded. The working application depends on a Supabase project and its Auth/PostgreSQL credentials. The repository will include migrations, seed data, integration code and protected environment-variable examples; the actual credentials must be configured securely before cloud persistence and real account login can operate. No role-selecting login shortcut or hardcoded successful generated timetable will be used.
