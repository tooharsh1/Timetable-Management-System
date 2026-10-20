# RGIT Timetable Management — Delivery Outcomes

## 1. Secure authentication and the three role experiences — PARTIAL
**Evidence/status:** Exactly three entry roles, role-specific routes, session refresh, server-side profile-role checks, RLS policies, and Admin account assignment are implemented. Live account creation/login and policy behavior require a configured Supabase tenant and remain unverified.
- Provide exactly three user roles: Admin, Teacher, and Student, with separate login entry points and dashboards.
- Enforce permissions on the server and database, not only in the interface. Selecting a role on the login screen must never grant that role.
- Admins can create timetables from scratch; manage departments, academic years, semesters, divisions, batches, subjects, subject codes, teachers, rooms, laboratories, and users; assign eligible faculty to subjects and classes; configure working days, lecture timings, breaks, session durations, and weekly teaching requirements; maintain faculty availability and workload limits; generate, review, edit, lock, regenerate, approve, and publish timetables; access class, batch, teacher, room, and department timetable views; view conflicts, scheduling failures, version history, and change records; and download and print timetables.
- Teachers can view and download their own published timetable; see subject, class, division, batch, room, day, and time for each session; view daily and weekly teaching workload; and submit availability preferences for administrator approval. Teachers cannot directly change academic master data or published schedules.
- Students can view and download the published timetable for their assigned class, division, and batch; see applicable practical sessions and electives; and view subject names, codes, faculty initials, rooms, and timings. Students have no access to administrative controls or other users’ private information.
- Teacher and Student views must not reveal draft or under-review schedules; they continue seeing only the last published version until a revised version is published.

## 2. Configurable university academic model and demonstration data — PARTIAL
**Evidence/status:** Relational schema, seed data, solver-input mapping, explicit class/division/batch overlaps, combined lectures, parallel batch labs, and elective conflict groups are implemented. The migration/seed has not been applied to a live database.
- Support multiple departments and programmes; academic years and semesters; multiple divisions within each year; practical batches within each division; theory lectures, tutorials, laboratory sessions, and electives; shared faculty and rooms across departments; combined lectures attended by multiple divisions; parallel practicals for different batches; parallel open-elective blocks with student enrolment or explicit conflict-group information; and different session lengths, including consecutive laboratory periods.
- Store subject name, code, session type, required weekly sessions, duration, eligible faculty, associated classes or batches, and room requirements.
- Store faculty full name, initials, department, eligible subjects, availability, workload limits, and scheduling preferences.
- Store room name, capacity, type, availability, and laboratory facilities.
- Include realistic, clearly labelled sample data covering multiple divisions, batches, shared teachers/labs, combined classes, and parallel electives. Generated schedules must come from the scheduling engine using the requirements, not hardcoded timetable results.

## 3. Configurable timings, availability, and scheduling rules — PARTIAL
**Evidence/status:** Timing templates, per-period/break/blocked-period schema and editor, durations, availability, priorities, and interval validation are implemented. Current semester mapping selects one timing template, so different department/shift templates within a single semester remain incomplete.
- Provide a dedicated timetable settings page where administrators configure working days; start and end times; individual period timings; short breaks and lunch breaks; theory, tutorial, and laboratory durations; different timing templates where departments or shifts require them; blocked periods and fixed institutional activities; maximum daily teaching load; and consecutive-session limits.
- Do not hardcode one college timing structure.
- Validate all time intervals. Detect overlapping periods, invalid durations, and sessions crossing breaks before generation.
- Administrators configure preference priorities. Soft preferences never override hard constraints.

## 4. Genuine automatic scheduling service and independent validation — PARTIAL
**Evidence/status:** Python/FastAPI, OR-Tools CP-SAT, independent validator, background Redis queue/worker, explicit outcomes, hard constraints, and configurable soft weights are implemented. Fifteen Python tests pass, including eligibility/capacity and independent blocked-period, timing, subject, and workload checks; an isolated sandbox Redis/API/worker integration produced an OPTIMAL validated result. Live academic-database generation remains unverified.
- Implement a Python scheduling service with a genuine constraint-solving approach such as OR-Tools CP-SAT. Represent session requirements, times, faculty, student groups, and rooms explicitly. Separate hard constraints from configurable soft preferences.
- Hard constraints: a faculty member cannot teach overlapping sessions; a room cannot host overlapping sessions; a student or overlapping student group cannot attend overlapping sessions; a whole-class lecture conflicts with any simultaneous practical attended by members of that class; separate batches may have parallel practicals when faculty and rooms are available; required weekly sessions and teaching durations are satisfied; faculty are eligible and available; room capacity and required facilities are adequate; practical sessions occupy the required continuous time; sessions respect working hours, breaks, and blocked intervals; locked sessions remain fixed; combined classes are modelled as one shared session with all participating groups and adequate room capacity; electives respect actual enrolment conflicts or configured conflict groups; shared resources are checked across all departments in the scheduling scope.
- Soft preferences: spread subject sessions across the week; reduce unnecessary student and teacher gaps; balance teaching load across days; avoid excessive consecutive lectures; prefer suitable laboratory blocks; reduce unnecessary room changes; respect preferred faculty timings where feasible; minimize changes during regeneration.
- Provide a background-job mechanism for generation tasks that may exceed ordinary request timeouts. Show generation progress and distinguish: feasible schedule found; optimal schedule found where the solver establishes optimality; proven infeasible; time limit reached without finding a schedule; validation or execution error.
- Never label a timeout as proof that no timetable exists. Never display a partial timetable as a complete successful result.
- Provide useful diagnostics and suggested data corrections when generation fails. Do not claim an exact conflicting constraint set unless the implementation can actually establish it.
- Independently validate generated schedules before allowing publication.

## 5. Editing, repair, locks, and safe change acceptance — PARTIAL
**Evidence/status:** Admin drag-to-day and accessible repair form support time, faculty, room, and occurrence-specific participant group changes; the solver previews, independently revalidates, preserves only current database locks, uses optimistic revision checking, and commits through an atomic draft RPC. A requested placement is fixed during the repair without silently becoming a permanent lock. Tests cover a group change affecting one weekly occurrence. Full database-backed repair remains unverified without the configured tenant.
- Provide a timetable editor with drag-and-drop and an accessible edit form. Administrators can change a session’s time, faculty, room, or applicable group.
- For every change, validate the proposed edit; identify affected sessions and shared resources; treat the administrator’s requested placement as fixed for that repair attempt; reconfigure affected unlocked sessions; preserve existing locks; minimize movement of unaffected sessions; show a before-and-after preview and a list of changed sessions; require administrator acceptance before committing the revision.
- If no valid repair is found, preserve the previous timetable and explain the problem.
- Use draft versions for edits to published schedules. Students and teachers continue seeing the last published version until the revised version is approved and published.

## 6. Approval, publication, version history, and audit trail — PARTIAL
**Evidence/status:** Draft/Under Review/Published workflow, database approval invalidation on reviewed-version/session edits, atomic generation and repair persistence, atomic publication, restore, and row-level audit triggers across academic/workflow tables are implemented. Live SQL and workflow behavior have not been exercised against Supabase.
- Implement the workflow: academic data entry → validation → automatic generation → independent conflict checking → administrator review → approval → publication.
- Maintain Draft, Under Review, and Published states.
- Support saving drafts; comparing revisions; viewing change history; restoring an earlier version into a draft; recording who changed or published a timetable and when; and atomic publication so users never see a partially updated schedule.
- Any change after approval invalidates that approval and requires validation again.

## 7. Timetable views, legends, and filters — PARTIAL
**Evidence/status:** Role-specific schedule boards, teacher/student published-view queries, Admin semester/version and day/week selection, separate class/division and batch filters, teacher/room/department filters, and live subject-code/faculty-initial legends are implemented. Live role-scoped data is unverified without Supabase accounts and rows.
- Provide class timetable, batch timetable, teacher timetable, room timetable, department overview, daily view, and weekly view.
- Each session clearly displays subject name or abbreviation, subject code, faculty initials, class/division/batch where relevant, room or laboratory, start and end times, and session type.
- Show parallel batch practicals and electives clearly within the same time block. Include a faculty-initials legend and subject legend.
- Provide filters by department, semester, class, batch, teacher, and room.

## 8. Exports and print — PARTIAL
**Evidence/status:** Authenticated PDF and XLSX export routes and print-specific timetable styling are implemented; full populated exports have not been visually inspected against a live institution schedule.
- Provide readable PDF downloads, spreadsheet exports, and print layouts.
- Exports preserve parallel sessions, merged laboratory durations, breaks, legends, and institution details without clipping.

## 9. Interface design, accessibility, responsive behavior, and states — PARTIAL
**Evidence/status:** Warm cream, muted green, terracotta, and amber dashboard styling, responsive navigation, labeled controls, keyboard-operable repair fields, and loading/error/empty/success states are implemented. No end-to-end browser accessibility or device-layout audit was performed.
- Use a polished design inspired by the warmth and character of “Cozy Eating Village,” adapted to an academic management application: warm cream backgrounds, muted green, terracotta, and soft amber accents; clear typography; restrained decorative details; rounded cards; subtle shadows; consistent spacing; small purposeful animations; strong visual hierarchy; readable timetable cells; accessible contrast; keyboard navigation; and labelled controls.
- Keep the timetable workspace spacious and efficient. Avoid oversized decorative elements that reduce usable space.
- Admin dashboard shows setup completeness, scheduling status, unresolved conflicts, workload summaries, and publication status. Teacher dashboard shows today’s lectures and weekly teaching schedule. Student dashboard shows today’s classes and class/batch timetable.
- Desktop views support large timetable grids; mobile navigation is usable and mobile timetables include daily views.
- Include loading, empty, error, success, and permission-denied states. All visible actions work.

## 10. Persistent data model, authorization, and operational safety — PARTIAL
**Evidence/status:** Migration, RLS policies, role triggers, service-only solver credentials, audit history, concurrency guards, and `.env.example` are present. Database policy semantics and data persistence were not run against a live Supabase project.
- Provide migrations and relationships for users and roles; departments and programmes; academic years and semesters; classes, divisions, and batches; student group and elective enrolments; subjects and teaching requirements; faculty eligibility and assignments; rooms and facilities; availability and timing templates; scheduling rules and priorities; generation jobs; timetable versions and sessions; session participants and locks; approvals; and audit records.
- Protect credentials through environment variables. Never expose privileged database keys to the browser.
- Prevent self-assignment of administrator privileges. Enforce authorization on every protected operation.
- Validate inputs, handle errors clearly, and prevent concurrent edits from silently overwriting one another.
- Preserve data persistence after refresh and login.

## 11. Meaningful tests, reported evidence, and known limitations — PARTIAL
**Evidence/status:** `pytest`: 15 passed; Pyright: 0 errors/warnings/information; TypeScript check, clean optimized production build, and PostgreSQL outer-SQL parsing pass. A local Redis-backed API/worker job and HTTP checks for role login entry points/health succeeded earlier. The Node test runner currently finds 0 frontend tests. Live Supabase/browser flows, database execution, and populated PDF/XLSX inspection are outstanding.
- Verify complete user flows with realistic data covering multiple divisions, batches, shared teachers, shared laboratories, combined classes, and parallel electives.
- Include meaningful checks for login and role restrictions; required-field and timing validation; faculty, room, class, and batch conflicts; multi-period laboratory scheduling; elective enrolment conflicts; weekly session completeness; locked-session preservation; successful repair after an edit; failed repair preserving the previous timetable; infeasible input and solver timeouts; drafts remaining hidden from teachers and students; publication and revision history; correct PDF and spreadsheet exports; and data persistence after refresh and login.
- Report what was actually tested and any remaining limitations. Do not claim that the application is bug-free without evidence.

## 12. Complete source delivery and deployment documentation — PARTIAL
**Evidence/status:** Complete source, migrations/seed, `.env.example`, README local/container/per-service deployment guidance, solver explanation, test evidence, and limitations are present. `/home/ubuntu/rgittime/RGIT-Timetable-Management.zip` was assembled and validated (59 files; no real credentials or build caches). The final live role-to-publication demonstration cannot be completed until an operator configures and applies a Supabase project; Docker/Compose images were not built in this sandbox. A canonical Git checkpoint could not be recorded because the configured managed credential-helper module is missing from the runtime.
- Deliver complete frontend and backend source code; Python scheduling engine; database migrations and seed data; environment-variable example files; clearly documented demo-account setup; local installation and run instructions; deployment instructions for each service; concise explanation of the scheduling algorithm and constraints; test results and known limitations; and a ZIP containing the complete project.
- Use supported, mutually compatible dependency versions and document them.
- The frontend may be deployed on Vercel. Provide a separate suitable deployment configuration for the Python scheduling service and worker. Do not assume a continuously running Python solver can operate inside a static frontend deployment.
- Payment integration is an optional extension, separate from the core academic workflow. Payment is never required to generate or view timetables.
- The final demonstration flow must show an administrator configuring academic data, generating a valid timetable, editing a lecture, reviewing automatic reconfiguration, publishing the revision, and teachers and students viewing and downloading their correct schedules.
