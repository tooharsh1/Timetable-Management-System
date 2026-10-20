# RGIT Timetable Management

An academic timetable management application for MCT’s Rajiv Gandhi Institute of Technology, Mumbai. It separates the Next.js role-based workspace, Supabase authentication/PostgreSQL data, and a Python OR-Tools scheduling service. Timetables are solver-generated, independently validated, saved as private drafts, then reviewed and published.

## Architecture

- **Frontend:** Next.js 15.5 / React 19 / TypeScript / Tailwind CSS. The web app uses relative API paths and the authenticated Supabase session.
- **Identity and data:** Supabase Auth and PostgreSQL. Browser operations use the public anon/publishable key plus row-level security (RLS); no service-role key belongs in the browser. The included SQL migration defines the schema, RLS policies, protected publication/repair functions, audit trail, and scoped published-schedule view.
- **Scheduling:** Python 3.12, FastAPI, Pydantic 2, and OR-Tools CP-SAT. A separately deployable FastAPI API and worker share a Redis queue. The worker returns only complete solver results; the API independently checks them before replying.
- **Exports:** authenticated PDF and XLSX endpoints. Teacher and Student exports use their RLS-scoped published view; Admin exports can target the selected revision.

## Supabase setup

1. Create a dedicated Supabase project for this institution/deployment. Admin permissions are not institution-ID scoped, so do not place multiple colleges in one database. In its SQL Editor, run `supabase/migrations/20261020190000_initial_timetable_schema.sql` as the project owner. Then run `supabase/seed.sql` to add clearly labelled RGIT demonstration master data. The seed deliberately contains no auth users, passwords, timetable sessions, or fabricated generated timetable.
2. Enable email/password sign-in in Supabase Auth.
3. Add the Supabase project URL and **anon/publishable** key to `.env` as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Do not add a service-role key. Copy `.env.example` to `.env`; use different secrets in production.
4. Create the initial administrator account through Supabase Auth. The profile trigger assigns the default `Student` role; the login role picker does not grant permissions. As the trusted Supabase project owner, approve the first administrator once in the SQL Editor, replacing the email below:

   ```sql
   update public.profiles p
   set role = 'Admin', admin_approved = true, approved_by = p.id, approved_at = now()
   where p.email = 'admin@your-college.edu'
     and exists (select 1 from auth.users u where u.id = p.id and u.email = p.email);
   ```

   The SQL owner—not the user signing in—performs this one-time bootstrap. Afterward, an approved Admin can assign roles to existing profiles from **User access** and link Teacher/Student profiles to the corresponding faculty/student records. Add enrolments for each student group before relying on individual student timetables.
5. Open `/login/admin`, `/login/teacher`, or `/login/student`. The account’s stored, server-verified role must match the selected entry point.

## Local development

Requirements: Node.js 22, pnpm 11.25.0, Python 3.12, and Redis 7 (or a compatible Redis service).

```bash
cp .env.example .env
# Fill the Supabase URL and anon/publishable key. Use one long random SOLVER_API_KEY value.
pnpm install --frozen-lockfile
python3 -m venv solver/.venv
solver/.venv/bin/pip install -r solver/requirements.txt
```

Start Redis (or point `REDIS_URL` at your private Redis instance), then use three terminals:

```bash
# Terminal 1 — FastAPI scheduling API
cd solver
export SOLVER_API_KEY='the-same-long-random-value'
export REDIS_URL='redis://127.0.0.1:6379/0'
../solver/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

```bash
# Terminal 2 — separate background solver worker
cd solver
export REDIS_URL='redis://127.0.0.1:6379/0'
../solver/.venv/bin/python -m app.worker
```

```bash
# Terminal 3 — Next.js app (run at repository root)
pnpm dev
```

The web process must have `SOLVER_API_URL=http://127.0.0.1:8000` and the same `SOLVER_API_KEY` as the API. A local `.env` file is loaded by Next.js. Health check: `GET http://127.0.0.1:8000/health`. The app’s Preview listener is port 3000.

## Docker Compose

After applying the database migration/seed and filling `.env`, run from the repository root:

```bash
docker compose up --build
```

Compose starts the web app, private FastAPI API, separate single solver worker, and Redis with persistent queue storage. The web app is available on `http://localhost:${WEB_PORT:-3000}`. The solver API is not published to the host by Compose. Do not expose Redis publicly. Use TLS/private networking and managed Redis in production. Keep exactly one worker replica with the current list-queue recovery logic; it requeues its in-flight job after a restart.

## Production deployment

Deploy **three separate runtime services** plus private Redis:

1. **Next.js web service:** build from the repository-root `Dockerfile`; expose port 3000 and honor `PORT`. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SOLVER_API_URL` (private API URL), and `SOLVER_API_KEY` at runtime. Never set a service-role key in any browser-facing environment.
2. **FastAPI API:** build with `solver/Dockerfile` using the repository root as the build context. Run the default `uvicorn app.main:app --host 0.0.0.0 --port 8000` command. Set `REDIS_URL` and `SOLVER_API_KEY`; permit only the web service to reach the API. Readiness endpoint: `/health`.
3. **Worker:** build the same solver image, override the command to `python -m app.worker`, and set the same `REDIS_URL`. Run one worker replica. Use a durable/private Redis service with persistence enabled. The API and worker must share the same Redis database and have compatible releases.

The front end may also be hosted on Vercel, but generation still requires the separately deployed always-on Python API, worker, Redis, and Supabase project. Configure the Next.js deployment’s runtime environment with the Supabase public values and private solver values. Do not deploy the solver as a static asset or assume a static host can run Python.

## Administrator workflow

Create academic structure and participant groups; set subjects, weekly requirements, assigned eligible faculty, room types/capacity/facilities, and student enrolments; configure the timing template and faculty availability; choose **Generate timetable**. The API creates a generation job and queues the request. Polling distinguishes solver completion, feasible vs. optimal, proven infeasibility, timeout without a solution, and errors. Only a complete result that passes the independent validator is saved as a Draft. Use **Versions & review** to validate and submit a draft for review, approve, then publish. The database publication function archives the previous version and activates the approved revision atomically.

On a Draft, an administrator can drag an unlocked session to a weekday column or use the keyboard-operable **Reconfigure** form to change its time, faculty, room, or participant group(s). Group changes are scoped to that weekly occurrence. The placement is previewed by rerunning the solver with a fixed requested placement, independently validated, and only committed after explicit acceptance. Locks are stored in the database, carried into regeneration, and protected by the database repair function. A failed preview does not replace the current timetable. Teacher and Student accounts see only their own currently published sessions; Draft and Under Review versions are not returned to their view.

## Solver and constraint model

The CP-SAT model represents each required occurrence, eligible faculty, participant groups, available periods, candidate rooms, and duration. Hard constraints prohibit resource conflicts, enforce eligibility and availability, enforce capacity/facilities, maintain continuous multi-period practicals, honour working days, breaks and blocked intervals, satisfy required weekly occurrences, respect workload/consecutive-period limits, and retain locked placements. A combined lecture is modelled once with every participating group; explicit class/division/batch hierarchy relationships make it conflict with attended lower-level sessions while allowing sibling batches to run parallel practicals. Practical requirements are split into per-group requirements where appropriate. Elective enrolment IDs and configured conflict groups prevent incompatible simultaneous electives. Shared faculty and rooms are loaded institution-wide for the semester and participate in one solve.

Soft preferences are scaled from the administrator’s configured priorities: subject spreading, daily load balance, fewer student/faculty gaps, practical placement in laboratories, reduced room changes, preferred faculty times, and regeneration stability. Soft weights do not remove or relax hard constraints. A time limit without a solution is reported as **Time Limit No Solution**, never as proof of infeasibility. Solver outputs are independently validated before persistence and again before approval/publication.

## Tests and current limitations

Run:

```bash
pnpm --filter @rgit/timetable-web typecheck
pnpm --filter @rgit/timetable-web test
solver/.venv/bin/python -m pytest -q
solver/.venv/bin/pyright -p pyrightconfig.json
```

The verified Python suite reports **15 passed** and covers multi-period practicals; faculty conflicts, eligibility, workload, and consecutive limits; locked sessions; infeasible inputs without partial success; independent checks for blocked/mistimed sessions, capacity, facilities, faculty, and participants; combined classes; parallel sibling-batch practicals; elective conflict groups; and a group change on one weekly occurrence. Pyright reports **0 errors, 0 warnings, 0 informational findings**. The Redis-backed worker was exercised locally against an isolated Redis server: health check succeeded, a missing solver key was denied (401), a permitted job finished as **OPTIMAL** with one complete session, and an unknown job returned 404. The latest Next.js production build, TypeScript check, and PostgreSQL outer-SQL parser check pass. The Node test command currently discovers **0 frontend tests**. The project includes two-department, three-division, multiple-batch, shared-lab, combined-lecture, parallel-elective, and availability seed data. The application has not been validated against a live Supabase tenant in this workspace: database DDL/seed execution, real account roles, RLS policy behavior, and end-to-end login/generation/publication/export require the operator to configure and apply their own Supabase project. The included seed has no precomputed timetable, by design.

Known current scope limits: the schema supports reusable institutional timing templates, but `semester_timing_templates` maps only one template per semester today, so distinct department/shift templates within the same semester are not yet implemented. The academic setup UI is strongest for creating records; full edit/archive workflows for every master-data entity are not complete. Use one institution per Supabase project/deployment until Admin permissions are institution-scoped. Automated end-to-end browser tests, real PDF/XLSX inspection across a full institution schedule, and live production deployment checks remain outstanding. Docker/Compose image builds could not be checked because Docker is not installed in the sandbox. Redis queue execution requires a running Redis service and a single worker replica with this recovery implementation.

## Repository map

```text
frontend/                  Next.js app, API routes, components, tests, public assets
solver/app/                FastAPI endpoints, request/result schemas, Redis worker
solver/engine/             CP-SAT model and independent schedule validator
solver/tests/              Python solver/validator tests
supabase/migrations/       PostgreSQL schema, roles/RLS, atomic workflows, audit log
supabase/seed.sql          Fictional RGIT demonstration academic data only
Dockerfile                 Next.js production image
solver/Dockerfile          Shared Python API/worker image
docker-compose.yml         Local web/API/worker/Redis stack
plan.md                    Approved implementation and design plan
TODO.md                    Acceptance criteria and delivery status
RGIT-Timetable-Management.zip  Complete source archive (no credentials or build caches)
```
#   T i m e t a b l e - M a n a g e m e n t - S y s t e m  
 