begin;

create extension if not exists pgcrypto;

-- Domain enums are deliberately limited to the three product roles and explicit workflow states.
do $$ begin create type public.user_role as enum ('Admin', 'Teacher', 'Student'); exception when duplicate_object then null; end $$;
do $$ begin create type public.group_type as enum ('Class', 'Division', 'Batch', 'Elective'); exception when duplicate_object then null; end $$;
do $$ begin create type public.session_type as enum ('Lecture', 'Tutorial', 'Practical', 'Elective'); exception when duplicate_object then null; end $$;
do $$ begin create type public.version_status as enum ('Draft', 'Under Review', 'Published', 'Archived'); exception when duplicate_object then null; end $$;
do $$ begin create type public.job_status as enum ('Queued', 'Running', 'Feasible', 'Optimal', 'Infeasible', 'Time Limit No Solution', 'Validation Error', 'Execution Error', 'Cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type public.availability_status as enum ('Available', 'Unavailable', 'Preferred'); exception when duplicate_object then null; end $$;
do $$ begin create type public.approval_status as enum ('Pending', 'Approved', 'Rejected', 'Superseded'); exception when duplicate_object then null; end $$;
do $$ begin create type public.room_type as enum ('Classroom', 'Laboratory', 'Seminar', 'Workshop', 'Auditorium', 'Office'); exception when duplicate_object then null; end $$;
do $$ begin create type public.period_kind as enum ('Teaching', 'Break'); exception when duplicate_object then null; end $$;

create table if not exists public.institutions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code) and length(code) between 2 and 20),
  name text not null check (length(trim(name)) > 1),
  timezone text not null default 'Asia/Kolkata',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.institutions is 'Tenant/institution boundary for all academic and scheduling data.';

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null check (length(trim(display_name)) > 0),
  role public.user_role not null default 'Student',
  admin_approved boolean not null default false,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((role = 'Admin' and admin_approved) or (role <> 'Admin' and not admin_approved)),
  check ((admin_approved and approved_by is not null and approved_at is not null) or not admin_approved)
);
comment on table public.profiles is 'Auth identity projection. Role is never accepted from a login form; Admin requires independent approval.';

create table if not exists public.departments (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (institution_id, code),
  unique (institution_id, name)
);
create table if not exists public.programmes (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete cascade,
  code text not null,
  name text not null,
  duration_years smallint not null check (duration_years between 1 and 10),
  created_at timestamptz not null default now(),
  unique (department_id, code)
);
create table if not exists public.academic_years (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  check (ends_on > starts_on),
  unique (institution_id, name)
);
create table if not exists public.semesters (
  id uuid primary key default gen_random_uuid(),
  academic_year_id uuid not null references public.academic_years(id) on delete cascade,
  number smallint not null check (number between 1 and 20),
  name text not null,
  starts_on date not null,
  ends_on date not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  check (ends_on > starts_on),
  unique (academic_year_id, number)
);

create table if not exists public.classes (
  id uuid primary key default gen_random_uuid(),
  programme_id uuid not null references public.programmes(id) on delete cascade,
  code text not null,
  name text not null,
  cohort_year smallint not null check (cohort_year between 1 and 10),
  created_at timestamptz not null default now(),
  unique (programme_id, code)
);
create table if not exists public.divisions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  code text not null,
  name text not null,
  capacity integer check (capacity is null or capacity > 0),
  created_at timestamptz not null default now(),
  unique (class_id, code)
);
create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.divisions(id) on delete cascade,
  code text not null,
  name text not null,
  capacity integer not null check (capacity > 0),
  created_at timestamptz not null default now(),
  unique (division_id, code)
);
create table if not exists public.student_groups (
  id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters(id) on delete cascade,
  name text not null,
  group_type public.group_type not null,
  class_id uuid references public.classes(id) on delete cascade,
  division_id uuid references public.divisions(id) on delete cascade,
  batch_id uuid references public.batches(id) on delete cascade,
  conflict_key text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(class_id, division_id, batch_id) <= 1),
  unique (semester_id, name)
);
comment on table public.student_groups is 'Schedulable attendance groups; one session may have many groups for combined teaching.';
create table if not exists public.student_records (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  enrollment_number text not null unique,
  programme_id uuid references public.programmes(id) on delete set null,
  current_semester_id uuid references public.semesters(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.student_enrolments (
  id uuid primary key default gen_random_uuid(),
  student_record_id uuid not null references public.student_records(id) on delete cascade,
  group_id uuid not null references public.student_groups(id) on delete cascade,
  enrolment_kind text not null default 'Core' check (enrolment_kind in ('Core', 'Elective', 'Audit')),
  enrolled_at timestamptz not null default now(),
  unique (student_record_id, group_id)
);
create table if not exists public.elective_conflicts (
  id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters(id) on delete cascade,
  conflict_group text not null,
  group_id uuid not null references public.student_groups(id) on delete cascade,
  unique (semester_id, conflict_group, group_id)
);
comment on table public.elective_conflicts is 'Explicit conflict sets used by the solver for elective enrolment; no implied hardcoded elective timetable.';

create table if not exists public.subjects (
  id uuid primary key default gen_random_uuid(),
  department_id uuid not null references public.departments(id) on delete restrict,
  code text not null,
  name text not null,
  short_name text,
  credits numeric(4,1) check (credits is null or credits > 0),
  is_elective boolean not null default false,
  created_at timestamptz not null default now(),
  unique (department_id, code)
);
create table if not exists public.subject_requirements (
  id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  session_type public.session_type not null,
  weekly_sessions smallint not null check (weekly_sessions > 0 and weekly_sessions <= 30),
  duration_periods smallint not null check (duration_periods > 0 and duration_periods <= 12),
  expected_size integer check (expected_size is null or expected_size > 0),
  notes text,
  created_at timestamptz not null default now(),
  unique (semester_id, subject_id, session_type)
);
create table if not exists public.subject_requirement_groups (
  requirement_id uuid not null references public.subject_requirements(id) on delete cascade,
  group_id uuid not null references public.student_groups(id) on delete cascade,
  expected_enrolment integer check (expected_enrolment is null or expected_enrolment > 0),
  primary key (requirement_id, group_id)
);

create table if not exists public.faculty (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles(id) on delete set null,
  department_id uuid not null references public.departments(id) on delete restrict,
  employee_code text not null unique,
  full_name text not null,
  initials text not null check (initials = upper(initials) and length(initials) between 2 and 6),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.faculty_subject_eligibility (
  faculty_id uuid not null references public.faculty(id) on delete cascade,
  subject_id uuid not null references public.subjects(id) on delete cascade,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  primary key (faculty_id, subject_id)
);
create table if not exists public.faculty_assignments (
  id uuid primary key default gen_random_uuid(),
  faculty_id uuid not null references public.faculty(id) on delete cascade,
  requirement_id uuid not null references public.subject_requirements(id) on delete cascade,
  group_id uuid not null references public.student_groups(id) on delete cascade,
  allocation_percent numeric(5,2) not null default 100 check (allocation_percent > 0 and allocation_percent <= 100),
  created_at timestamptz not null default now(),
  unique (faculty_id, requirement_id, group_id)
);
create table if not exists public.faculty_availability (
  id uuid primary key default gen_random_uuid(),
  faculty_id uuid not null references public.faculty(id) on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  status public.availability_status not null default 'Available',
  approval public.approval_status not null default 'Pending',
  submitted_by uuid references public.profiles(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table if not exists public.faculty_workload_limits (
  faculty_id uuid not null references public.faculty(id) on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  max_weekly_periods smallint not null check (max_weekly_periods > 0),
  max_daily_periods smallint not null check (max_daily_periods > 0),
  max_consecutive_periods smallint not null default 3 check (max_consecutive_periods > 0),
  primary key (faculty_id, semester_id)
);
create table if not exists public.faculty_preferences (
  id uuid primary key default gen_random_uuid(),
  faculty_id uuid not null references public.faculty(id) on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  day_of_week smallint check (day_of_week between 1 and 7),
  starts_at time,
  ends_at time,
  weight integer not null default 1 check (weight between 1 and 100),
  notes text,
  check ((starts_at is null and ends_at is null) or (starts_at is not null and ends_at is not null and ends_at > starts_at))
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  code text not null,
  name text not null,
  room_type public.room_type not null,
  capacity integer not null check (capacity > 0),
  department_id uuid references public.departments(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (institution_id, code)
);
create table if not exists public.facilities (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (institution_id, code)
);
create table if not exists public.room_facilities (
  room_id uuid not null references public.rooms(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  quantity smallint not null default 1 check (quantity > 0),
  primary key (room_id, facility_id)
);
create table if not exists public.subject_requirement_facilities (
  requirement_id uuid not null references public.subject_requirements(id) on delete cascade,
  facility_id uuid not null references public.facilities(id) on delete cascade,
  quantity smallint not null default 1 check (quantity > 0),
  primary key (requirement_id, facility_id)
);
create table if not exists public.room_availability (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  semester_id uuid not null references public.semesters(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  status public.availability_status not null default 'Available',
  check (ends_at > starts_at)
);

create table if not exists public.timing_templates (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  code text not null,
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  theory_duration_periods smallint not null default 1 check (theory_duration_periods between 1 and 12),
  tutorial_duration_periods smallint not null default 1 check (tutorial_duration_periods between 1 and 12),
  lab_duration_periods smallint not null default 2 check (lab_duration_periods between 1 and 12),
  max_daily_periods smallint not null default 6 check (max_daily_periods between 1 and 24),
  max_consecutive_periods smallint not null default 3 check (max_consecutive_periods between 1 and 24),
  created_at timestamptz not null default now(),
  unique (institution_id, code)
);
create table if not exists public.semester_timing_templates (
  semester_id uuid primary key references public.semesters(id) on delete cascade,
  timing_template_id uuid not null references public.timing_templates(id) on delete restrict,
  is_default boolean not null default true
);
create table if not exists public.timing_working_days (
  timing_template_id uuid not null references public.timing_templates(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  is_working boolean not null default true,
  primary key (timing_template_id, day_of_week)
);
create table if not exists public.timing_periods (
  id uuid primary key default gen_random_uuid(),
  timing_template_id uuid not null references public.timing_templates(id) on delete cascade,
  sequence_no smallint not null check (sequence_no > 0),
  label text not null,
  starts_at time not null,
  ends_at time not null,
  kind public.period_kind not null default 'Teaching',
  check (ends_at > starts_at),
  unique (timing_template_id, sequence_no),
  unique (timing_template_id, starts_at, ends_at)
);
create table if not exists public.timing_breaks (
  id uuid primary key default gen_random_uuid(),
  timing_template_id uuid not null references public.timing_templates(id) on delete cascade,
  label text not null,
  starts_at time not null,
  ends_at time not null,
  check (ends_at > starts_at),
  unique (timing_template_id, starts_at, ends_at)
);
create table if not exists public.blocked_periods (
  id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  reason text not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table if not exists public.scheduling_rules (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id) on delete cascade,
  code text not null,
  name text not null,
  hard_constraint boolean not null default true,
  weight integer not null default 100 check (weight between 1 and 1000),
  configuration jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  unique (institution_id, code)
);
comment on table public.scheduling_rules is 'Hard constraints and weighted soft preferences are data, not hardcoded timing assumptions.';

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters(id) on delete restrict,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  status public.job_status not null default 'Queued',
  progress smallint not null default 0 check (progress between 0 and 100),
  solver_name text,
  solver_version text,
  input_hash text,
  diagnostics jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status in ('Queued', 'Running') and finished_at is null) or status not in ('Queued', 'Running'))
);
create table if not exists public.timetable_versions (
  id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters(id) on delete restrict,
  generation_job_id uuid references public.generation_jobs(id) on delete set null,
  base_version_id uuid references public.timetable_versions(id) on delete set null,
  revision integer not null check (revision > 0),
  label text not null,
  status public.version_status not null default 'Draft',
  created_by uuid not null references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (semester_id, revision),
  check ((status = 'Published' and published_at is not null) or status <> 'Published'),
  check ((approved_by is null and approved_at is null) or (approved_by is not null and approved_at is not null))
);
create unique index if not exists one_published_version_per_semester on public.timetable_versions(semester_id) where status = 'Published';
create table if not exists public.timetable_sessions (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.timetable_versions(id) on delete cascade,
  requirement_id uuid not null references public.subject_requirements(id) on delete restrict,
  subject_id uuid not null references public.subjects(id) on delete restrict,
  session_type public.session_type not null,
  occurrence_no smallint not null check (occurrence_no > 0),
  day_of_week smallint check (day_of_week between 1 and 7),
  starts_at time,
  ends_at time,
  duration_periods smallint not null check (duration_periods > 0),
  faculty_id uuid references public.faculty(id) on delete restrict,
  room_id uuid references public.rooms(id) on delete restrict,
  placement_source text not null default 'Solver',
  validation_state text not null default 'Unvalidated' check (validation_state in ('Unvalidated', 'Valid', 'Invalid')),
  notes text,
  unique (version_id, requirement_id, occurrence_no),
  check ((day_of_week is null and starts_at is null and ends_at is null) or (day_of_week is not null and starts_at is not null and ends_at is not null and ends_at > starts_at))
);
comment on table public.timetable_sessions is 'Engine output only. Seed data intentionally creates no sessions or fabricated timetable.';
create table if not exists public.session_participants (
  session_id uuid not null references public.timetable_sessions(id) on delete cascade,
  group_id uuid not null references public.student_groups(id) on delete restrict,
  attendance_required boolean not null default true,
  primary key (session_id, group_id)
);
create table if not exists public.session_locks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.timetable_sessions(id) on delete cascade,
  locked_by uuid not null references public.profiles(id) on delete restrict,
  lock_reason text not null,
  locked_at timestamptz not null default now(),
  unique (session_id)
);
create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.timetable_versions(id) on delete cascade,
  stage text not null check (stage in ('Validation', 'Review', 'Publication')),
  status public.approval_status not null default 'Pending',
  actor_id uuid references public.profiles(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (version_id, stage)
);
create table if not exists public.repair_proposals (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.timetable_versions(id) on delete cascade,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  expected_updated_at timestamptz not null,
  requested_session_id text not null,
  requested_placement jsonb not null,
  candidate_sessions jsonb not null,
  validation_input jsonb not null,
  validation jsonb not null,
  status text not null default 'Pending' check (status in ('Pending', 'Applied', 'Expired', 'Rejected')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  institution_id uuid references public.institutions(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  old_data jsonb,
  new_data jsonb,
  request_id text,
  created_at timestamptz not null default now()
);
comment on table public.audit_log is 'Append-only operational record. Sensitive auth credentials are never stored here.';

-- A few high-value integrity checks are enforced centrally, including no self-promotion to Admin.
create or replace function public.is_approved_admin()
returns boolean language sql stable security definer set search_path = public, pg_catalog, auth set row_security = off
as $$ select exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'Admin' and p.admin_approved); $$;
create or replace function public.current_profile_id()
returns uuid language sql stable security definer set search_path = public, pg_catalog, auth set row_security = off
as $$ select auth.uid(); $$;
revoke all on function public.is_approved_admin() from public;
revoke all on function public.current_profile_id() from public;
grant execute on function public.is_approved_admin() to authenticated;
grant execute on function public.current_profile_id() to authenticated;

create or replace function public.guard_profile_role_change()
returns trigger language plpgsql security definer set search_path = public, pg_catalog, auth set row_security = off
as $$
begin
  if (new.id = auth.uid()) and (new.role is distinct from old.role or new.admin_approved is distinct from old.admin_approved) then
    raise exception 'A user cannot change their own role or administrator approval';
  end if;
  if new.role = 'Admin' and (not new.admin_approved or new.approved_by is null or new.approved_at is null) then
    raise exception 'Admin profiles require independent approval';
  end if;
  if new.admin_approved and new.role <> 'Admin' then
    raise exception 'Only Admin profiles can be approved as administrators';
  end if;
  if (new.role is distinct from old.role or new.admin_approved is distinct from old.admin_approved)
     and auth.uid() is not null
     and not public.is_approved_admin() then
    raise exception 'Only an approved administrator may assign roles';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_profile_role on public.profiles;
create trigger protect_profile_role before update on public.profiles for each row execute function public.guard_profile_role_change();

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public, pg_catalog
as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (new.id, new.email, coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(coalesce(new.email, 'user'), '@', 1)), 'Student')
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_auth_user();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists institutions_touch_updated_at on public.institutions;
create trigger institutions_touch_updated_at before update on public.institutions for each row execute function public.touch_updated_at();
drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles for each row execute function public.touch_updated_at();
drop trigger if exists versions_touch_updated_at on public.timetable_versions;
create trigger versions_touch_updated_at before update on public.timetable_versions for each row execute function public.touch_updated_at();

create or replace function public.prevent_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'Audit records are append-only';
end;
$$;
drop trigger if exists audit_append_only on public.audit_log;
create trigger audit_append_only before update or delete on public.audit_log for each row execute function public.prevent_audit_mutation();

create or replace function public.invalidate_timetable_approval(p_version_id uuid, p_reason text)
returns void language plpgsql security definer
set search_path = public, pg_catalog, auth set row_security = off
as $$
begin
  update public.approvals
     set status = 'Superseded', actor_id = coalesce(auth.uid(), actor_id),
         notes = left(coalesce(notes || E'\n', '') || p_reason, 1000), decided_at = now()
   where version_id = p_version_id and status in ('Pending', 'Approved');
  update public.timetable_versions
     set status = 'Draft', approved_by = null, approved_at = null, updated_at = now()
   where id = p_version_id and status = 'Under Review';
end;
$$;
revoke all on function public.invalidate_timetable_approval(uuid, text) from public;

create or replace function public.guard_timetable_version_write()
returns trigger language plpgsql security definer
set search_path = public, pg_catalog, auth set row_security = off
as $$
begin
  if current_setting('app.allow_timetable_publish', true) = 'on' then return new; end if;
  if new.status = 'Published' and old.status <> 'Published' then
    raise exception 'Use the atomic publish_timetable_version function to publish';
  end if;
  if old.status in ('Published', 'Archived') then
    raise exception 'Published or archived timetable versions are immutable';
  end if;
  if old.status = 'Under Review' and new.status = 'Draft' then
    update public.approvals
       set status = 'Superseded', actor_id = coalesce(auth.uid(), actor_id),
           notes = left(coalesce(notes || E'\n', '') || 'Approval invalidated because the reviewed version changed.', 1000), decided_at = now()
     where version_id = old.id and status in ('Pending', 'Approved');
    new.approved_by := null;
    new.approved_at := null;
  elsif old.status = 'Under Review' and new.status = 'Under Review' and (
       new.semester_id is distinct from old.semester_id
    or new.generation_job_id is distinct from old.generation_job_id
    or new.base_version_id is distinct from old.base_version_id
    or new.revision is distinct from old.revision
    or new.label is distinct from old.label
    or new.created_by is distinct from old.created_by
    or new.published_at is distinct from old.published_at
  ) then
    update public.approvals
       set status = 'Superseded', actor_id = coalesce(auth.uid(), actor_id),
           notes = left(coalesce(notes || E'\n', '') || 'Approval invalidated because the reviewed version changed.', 1000), decided_at = now()
     where version_id = old.id and status in ('Pending', 'Approved');
    new.status := 'Draft';
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists timetable_version_write_guard on public.timetable_versions;
create trigger timetable_version_write_guard before update on public.timetable_versions
for each row execute function public.guard_timetable_version_write();

create or replace function public.guard_timetable_content_write()
returns trigger language plpgsql security definer
set search_path = public, pg_catalog, auth set row_security = off
as $$
declare
  v_version_id uuid;
  v_status public.version_status;
  v_session_id uuid;
begin
  if tg_table_name = 'timetable_sessions' then
    if tg_op = 'DELETE' then v_version_id := old.version_id; else v_version_id := new.version_id; end if;
    if tg_op = 'UPDATE' and new.version_id is distinct from old.version_id then
      raise exception 'A session cannot be moved between timetable versions';
    end if;
  else
    if tg_op = 'DELETE' then v_session_id := old.session_id; else v_session_id := new.session_id; end if;
    if tg_op = 'UPDATE' and new.session_id is distinct from old.session_id then
      raise exception 'Session participants and locks cannot be moved between sessions';
    end if;
    select version_id into v_version_id from public.timetable_sessions where id = v_session_id;
    if not found and tg_op = 'DELETE' then return old; end if;
  end if;
  if v_version_id is null then raise exception 'The parent timetable version could not be found'; end if;
  select status into v_status from public.timetable_versions where id = v_version_id for update;
  if not found then raise exception 'The parent timetable version could not be found'; end if;
  if v_status in ('Published', 'Archived') then
    raise exception 'Published and archived timetable sessions are immutable; restore to a Draft first';
  end if;
  if v_status = 'Under Review' then
    perform public.invalidate_timetable_approval(v_version_id, 'Approval invalidated because timetable sessions, participants, or locks changed.');
  elsif v_status = 'Draft' then
    update public.timetable_versions set updated_at = now() where id = v_version_id and status = 'Draft';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists timetable_session_state_guard on public.timetable_sessions;
create trigger timetable_session_state_guard before insert or update or delete on public.timetable_sessions
for each row execute function public.guard_timetable_content_write();
drop trigger if exists session_participant_state_guard on public.session_participants;
create trigger session_participant_state_guard before insert or update or delete on public.session_participants
for each row execute function public.guard_timetable_content_write();
drop trigger if exists session_lock_state_guard on public.session_locks;
create trigger session_lock_state_guard before insert or update or delete on public.session_locks
for each row execute function public.guard_timetable_content_write();

create or replace function public.audit_row_mutation()
returns trigger language plpgsql security definer
set search_path = public, pg_catalog, auth set row_security = off
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_entity_id uuid;
  v_institution_id uuid;
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);
  begin v_entity_id := nullif(v_row->>'id', '')::uuid; exception when invalid_text_representation then v_entity_id := null; end;
  begin v_institution_id := nullif(v_row->>'institution_id', '')::uuid; exception when invalid_text_representation then v_institution_id := null; end;
  insert into public.audit_log(institution_id, actor_id, entity_type, entity_id, action, old_data, new_data)
  values (v_institution_id, auth.uid(), tg_table_name, v_entity_id, tg_op, v_old, v_new);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array[
    'institutions','profiles','departments','programmes','academic_years','semesters','classes','divisions','batches',
    'student_groups','student_records','student_enrolments','elective_conflicts','subjects','subject_requirements',
    'subject_requirement_groups','faculty','faculty_subject_eligibility','faculty_assignments','faculty_availability',
    'faculty_workload_limits','faculty_preferences','rooms','facilities','room_facilities','subject_requirement_facilities',
    'room_availability','timing_templates','semester_timing_templates','timing_working_days','timing_periods','timing_breaks',
    'blocked_periods','scheduling_rules','generation_jobs','timetable_versions','timetable_sessions','session_participants',
    'session_locks','approvals','repair_proposals'
  ] loop
    execute format('drop trigger if exists audit_row_mutation on public.%I', t);
    execute format('create trigger audit_row_mutation after insert or update or delete on public.%I for each row execute function public.audit_row_mutation()', t);
  end loop;
end $$;

create or replace function public.publish_timetable_version(p_version_id uuid)
returns public.timetable_versions language plpgsql security definer set search_path = public, pg_catalog, auth set row_security = off
as $$
declare v public.timetable_versions;
begin
  if not public.is_approved_admin() then raise exception 'Only an approved administrator can publish a timetable'; end if;
  select * into v from public.timetable_versions where id = p_version_id for update;
  if not found then raise exception 'Timetable version not found'; end if;
  if v.status <> 'Under Review' then raise exception 'Only an Under Review version may be published'; end if;
  if v.approved_by is null or v.approved_at is null then raise exception 'The version approval has been invalidated; validate and approve it again'; end if;
  if not exists (select 1 from public.approvals a where a.version_id = v.id and a.stage = 'Review' and a.status = 'Approved') then
    raise exception 'Review approval is required before publication';
  end if;
  perform set_config('app.allow_timetable_publish', 'on', true);
  update public.timetable_versions set status = 'Archived', updated_at = now()
   where semester_id = v.semester_id and status = 'Published' and id <> v.id;
  update public.timetable_versions set status = 'Published', published_at = now(), updated_at = now()
   where id = v.id returning * into v;
  insert into public.audit_log(institution_id, actor_id, entity_type, entity_id, action, new_data)
    select ay.institution_id, auth.uid(), 'timetable_version', v.id, 'published', to_jsonb(v)
    from public.semesters s join public.academic_years ay on ay.id = s.academic_year_id where s.id = v.semester_id;
  return v;
end;
$$;
revoke all on function public.publish_timetable_version(uuid) from public;
grant execute on function public.publish_timetable_version(uuid) to authenticated;

create or replace function public.apply_timetable_repair(p_proposal_id uuid)
returns public.timetable_versions language plpgsql security definer
set search_path = public, pg_catalog, auth set row_security = off
as $$
declare
  p public.repair_proposals;
  v public.timetable_versions;
  item jsonb;
  group_id uuid;
  session_id uuid;
begin
  if not public.is_approved_admin() then raise exception 'Only an approved administrator can apply timetable repairs'; end if;
  select * into p from public.repair_proposals where id = p_proposal_id for update;
  if not found or p.requested_by <> auth.uid() or p.status <> 'Pending' then raise exception 'Repair proposal is missing or no longer pending'; end if;
  if p.expires_at <= now() then update public.repair_proposals set status = 'Expired' where id = p.id; raise exception 'Repair proposal expired; preview again'; end if;
  select * into v from public.timetable_versions where id = p.version_id for update;
  if not found or v.status <> 'Draft' then raise exception 'Only a current Draft version can be repaired'; end if;
  if v.updated_at <> p.expected_updated_at then raise exception 'Draft changed since preview; reload and try again'; end if;

  delete from public.timetable_sessions where version_id = v.id;
  for item in select value from jsonb_array_elements(p.candidate_sessions) loop
    session_id := gen_random_uuid();
    insert into public.timetable_sessions(id, version_id, requirement_id, subject_id, session_type, occurrence_no,
      day_of_week, starts_at, ends_at, duration_periods, faculty_id, room_id, placement_source, validation_state, notes)
    values (session_id, v.id, (item->>'requirement_id')::uuid, (item->>'subject_id')::uuid,
      (item->>'session_type')::public.session_type, (item->>'occurrence_no')::smallint,
      (item->>'day_of_week')::smallint, (item->>'starts_at')::time, (item->>'ends_at')::time,
      (item->>'duration_periods')::smallint, (item->>'faculty_id')::uuid, (item->>'room_id')::uuid,
      'Manual Repair', 'Valid', jsonb_build_object('solver_session_id', item->>'solver_session_id', 'repair_proposal_id', p.id)::text);
    for group_id in select jsonb_array_elements_text(item->'group_ids')::uuid loop
      insert into public.session_participants(session_id, group_id, attendance_required) values (session_id, group_id, true);
    end loop;
    if coalesce((item->>'locked')::boolean, false) then
      insert into public.session_locks(session_id, locked_by, lock_reason) values (session_id, auth.uid(), coalesce(nullif(item->>'lock_reason', ''), 'Preserved by validated repair'));
    end if;
  end loop;
  if v.generation_job_id is not null and p.validation_input ? 'schedule' then
    update public.generation_jobs
       set diagnostics = diagnostics || jsonb_build_object('schedule_request', p.validation_input->'schedule',
         'last_repair_proposal_id', p.id, 'last_repair_applied_at', now())
     where id = v.generation_job_id;
  end if;
  update public.approvals set status = 'Superseded' where version_id = v.id and status = 'Approved';
  update public.timetable_versions set approved_by = null, approved_at = null, updated_at = now() where id = v.id returning * into v;
  update public.repair_proposals set status = 'Applied' where id = p.id;
  insert into public.audit_log(institution_id, actor_id, entity_type, entity_id, action, old_data, new_data)
    select ay.institution_id, auth.uid(), 'timetable_version', v.id, 'sessions_repaired',
      jsonb_build_object('updated_at', p.expected_updated_at), jsonb_build_object('repair_proposal_id', p.id, 'session_count', jsonb_array_length(p.candidate_sessions))
    from public.semesters s join public.academic_years ay on ay.id = s.academic_year_id where s.id = v.semester_id;
  return v;
end;
$$;
revoke all on function public.apply_timetable_repair(uuid) from public;
grant execute on function public.apply_timetable_repair(uuid) to authenticated;

create or replace function public.set_session_lock(p_session_id uuid, p_locked boolean, p_reason text default null)
returns boolean language plpgsql security definer
set search_path = public, pg_catalog, auth set row_security = off
as $$
declare
  v public.timetable_versions;
  s public.timetable_sessions;
begin
  if not public.is_approved_admin() then raise exception 'Only an approved administrator can change session locks'; end if;
  select ts.* into s from public.timetable_sessions ts where ts.id = p_session_id for update;
  if not found then raise exception 'Session not found'; end if;
  select tv.* into v from public.timetable_versions tv where tv.id = s.version_id for update;
  if not found or v.status <> 'Draft' then raise exception 'Only Draft sessions may be locked or unlocked'; end if;
  if p_locked then
    insert into public.session_locks(session_id, locked_by, lock_reason)
      values (s.id, auth.uid(), coalesce(nullif(trim(p_reason), ''), 'Administrator lock'))
      on conflict (session_id) do update set locked_by = excluded.locked_by, lock_reason = excluded.lock_reason, locked_at = now();
  else
    delete from public.session_locks where session_id = s.id;
  end if;
  update public.timetable_versions set updated_at = now() where id = v.id;
  insert into public.audit_log(institution_id, actor_id, entity_type, entity_id, action, old_data, new_data)
    select ay.institution_id, auth.uid(), 'timetable_session', s.id, case when p_locked then 'locked' else 'unlocked' end,
      jsonb_build_object('locked', not p_locked), jsonb_build_object('locked', p_locked, 'reason', p_reason)
    from public.semesters sem join public.academic_years ay on ay.id = sem.academic_year_id where sem.id = v.semester_id;
  return p_locked;
end;
$$;
revoke all on function public.set_session_lock(uuid, boolean, text) from public;
grant execute on function public.set_session_lock(uuid, boolean, text) to authenticated;

create or replace function public.persist_generated_timetable_draft(
  p_job_id uuid,
  p_sessions jsonb,
  p_session_map jsonb,
  p_solver_outcome text,
  p_solver_diagnostics jsonb,
  p_validation jsonb
)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog, auth set row_security = off
as $$
declare
  j public.generation_jobs;
  v public.timetable_versions;
  v_base_version public.timetable_versions;
  item jsonb;
  mapping jsonb;
  v_session_type public.session_type;
  occurrence_text text;
  db_occurrence integer;
  occurrence_counters jsonb := '{}'::jsonb;
  session_id uuid;
  group_text text;
  next_revision integer;
  current_revision integer;
  base_version_id uuid;
begin
  if not public.is_approved_admin() then raise exception 'Only an approved administrator may save a generated timetable'; end if;
  select * into j from public.generation_jobs where id = p_job_id for update;
  if not found or j.requested_by <> auth.uid() then raise exception 'Generation job not found or not owned by this administrator'; end if;
  if j.diagnostics ? 'version_id' then
    return jsonb_build_object('version_id', j.diagnostics->>'version_id', 'revision', (j.diagnostics->>'revision')::integer, 'idempotent', true);
  end if;
  if j.status not in ('Queued', 'Running') then raise exception 'Generation job is no longer eligible for draft persistence'; end if;
  if p_solver_outcome not in ('FEASIBLE', 'OPTIMAL') or coalesce(p_validation->>'valid', 'false') <> 'true' then
    raise exception 'Only a complete independently validated schedule may be persisted';
  end if;
  if coalesce(jsonb_typeof(p_sessions), 'null') <> 'array' or jsonb_array_length(p_sessions) = 0 then raise exception 'A non-empty complete session array is required'; end if;
  if coalesce(jsonb_typeof(p_session_map), 'null') <> 'object' then raise exception 'The solver requirement mapping is missing'; end if;

  perform 1 from public.semesters where id = j.semester_id for update;
  if not found then raise exception 'The generation job semester no longer exists'; end if;
  select coalesce(max(revision), 0) into current_revision from public.timetable_versions where semester_id = j.semester_id;
  if current_revision <> coalesce(nullif(j.diagnostics->>'base_version_revision', '')::integer, 0) then
    raise exception 'The timetable changed while scheduling was running; review the newest version and generate again';
  end if;
  base_version_id := nullif(j.diagnostics->>'base_version_id', '')::uuid;
  if base_version_id is not null then
    select * into v_base_version from public.timetable_versions where id = base_version_id for update;
    if not found or v_base_version.semester_id <> j.semester_id or v_base_version.revision <> current_revision
       or v_base_version.status::text is distinct from j.diagnostics->>'base_version_status'
       or v_base_version.updated_at is distinct from (j.diagnostics->>'base_version_updated_at')::timestamptz then
      raise exception 'The timetable or its approval changed while scheduling was running; generate again from the latest data';
    end if;
  end if;
  select coalesce(max(revision), 0) + 1 into next_revision from public.timetable_versions where semester_id = j.semester_id;
  insert into public.timetable_versions(semester_id, generation_job_id, base_version_id, revision, label, status, created_by)
  values (j.semester_id, j.id, nullif(j.diagnostics->>'base_version_id', '')::uuid, next_revision,
          'Solver draft ' || next_revision, 'Draft', auth.uid()) returning * into v;

  for item in select value from jsonb_array_elements(p_sessions) loop
    mapping := p_session_map->(item->>'requirement_id');
    if mapping is null or mapping->>'requirementId' is null or mapping->>'subjectId' is null then
      raise exception 'Solver session % has no academic requirement mapping', item->>'session_id';
    end if;
    occurrence_text := regexp_replace(coalesce(item->>'session_id', ''), '^.*__', '');
    if occurrence_text !~ '^[1-9][0-9]*$' then raise exception 'Solver session has an invalid occurrence number'; end if;
    db_occurrence := coalesce((occurrence_counters->>(mapping->>'requirementId'))::integer, 0) + 1;
    occurrence_counters := jsonb_set(occurrence_counters, array[mapping->>'requirementId'], to_jsonb(db_occurrence), true);
    v_session_type := case lower(item->>'session_type') when 'theory' then 'Lecture'::public.session_type
      when 'tutorial' then 'Tutorial'::public.session_type when 'lab' then 'Practical'::public.session_type
      when 'elective' then 'Elective'::public.session_type else null end;
    if v_session_type is null then raise exception 'Unknown solver session type: %', item->>'session_type'; end if;
    session_id := gen_random_uuid();
    insert into public.timetable_sessions(id, version_id, requirement_id, subject_id, session_type, occurrence_no,
      day_of_week, starts_at, ends_at, duration_periods, faculty_id, room_id, placement_source, validation_state, notes)
    values (session_id, v.id, (mapping->>'requirementId')::uuid, (mapping->>'subjectId')::uuid, v_session_type,
      db_occurrence::smallint, (item->>'day_id')::smallint,
      case when (item->>'start_minute')::integer = 1440 then time '24:00' else make_time((item->>'start_minute')::integer / 60, (item->>'start_minute')::integer % 60, 0) end,
      case when (item->>'end_minute')::integer = 1440 then time '24:00' else make_time((item->>'end_minute')::integer / 60, (item->>'end_minute')::integer % 60, 0) end,
      greatest(1, (item->>'end_period_index')::integer - (item->>'start_period_index')::integer + 1),
      (item->>'faculty_id')::uuid, (item->>'room_id')::uuid, 'Solver', 'Valid',
      jsonb_build_object('solver_session_id', item->>'session_id', 'lock_preserved', coalesce((item->>'locked')::boolean, false))::text);
    if coalesce(jsonb_typeof(item->'group_ids'), 'null') <> 'array' or jsonb_array_length(item->'group_ids') = 0 then
      raise exception 'Solver session % has no participant groups', item->>'session_id';
    end if;
    for group_text in select jsonb_array_elements_text(item->'group_ids') loop
      insert into public.session_participants(session_id, group_id, attendance_required) values (session_id, group_text::uuid, true);
    end loop;
    if coalesce((item->>'locked')::boolean, false) then
      insert into public.session_locks(session_id, locked_by, lock_reason) values (session_id, auth.uid(), 'Preserved by the scheduling engine');
    end if;
  end loop;

  update public.generation_jobs
     set status = case p_solver_outcome when 'OPTIMAL' then 'Optimal'::public.job_status else 'Feasible'::public.job_status end,
         progress = 100, finished_at = now(),
         diagnostics = diagnostics || jsonb_build_object('outcome', p_solver_outcome,
           'solver_diagnostics', coalesce(p_solver_diagnostics, '[]'::jsonb), 'validation', p_validation,
           'version_id', v.id, 'revision', v.revision, 'completed_at', now())
   where id = j.id;
  return jsonb_build_object('version_id', v.id, 'revision', v.revision, 'idempotent', false);
end;
$$;
revoke all on function public.persist_generated_timetable_draft(uuid, jsonb, jsonb, text, jsonb, jsonb) from public;
grant execute on function public.persist_generated_timetable_draft(uuid, jsonb, jsonb, text, jsonb, jsonb) to authenticated;
 
create or replace function public.can_read_published_version(p_version_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_catalog, auth set row_security = off
as $$ select exists (
  select 1 from public.timetable_versions v
  where v.id = p_version_id and v.status = 'Published'
    and (exists (select 1 from public.timetable_sessions s join public.faculty f on f.id = s.faculty_id where s.version_id = v.id and f.profile_id = auth.uid())
      or exists (select 1 from public.timetable_sessions s join public.session_participants sp on sp.session_id = s.id join public.student_enrolments se on se.group_id = sp.group_id join public.student_records sr on sr.id = se.student_record_id where s.version_id = v.id and sr.profile_id = auth.uid()))
); $$;
create or replace function public.can_read_published_session(p_session_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_catalog, auth set row_security = off
as $$ select exists (
  select 1 from public.timetable_sessions s join public.timetable_versions v on v.id = s.version_id
  where s.id = p_session_id and v.status = 'Published'
    and (exists (select 1 from public.faculty f where f.id = s.faculty_id and f.profile_id = auth.uid())
      or exists (select 1 from public.session_participants sp join public.student_enrolments se on se.group_id = sp.group_id join public.student_records sr on sr.id = se.student_record_id where sp.session_id = s.id and sr.profile_id = auth.uid()))
); $$;
create or replace function public.can_read_published_participant(p_session_id uuid, p_group_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_catalog, auth set row_security = off
as $$ select exists (
  select 1 from public.timetable_sessions s join public.timetable_versions v on v.id = s.version_id
  where s.id = p_session_id and v.status = 'Published'
    and (exists (select 1 from public.faculty f where f.id = s.faculty_id and f.profile_id = auth.uid())
      or exists (select 1 from public.student_enrolments se join public.student_records sr on sr.id = se.student_record_id where se.group_id = p_group_id and sr.profile_id = auth.uid()))
); $$;
revoke all on function public.can_read_published_version(uuid) from public;
revoke all on function public.can_read_published_session(uuid) from public;
revoke all on function public.can_read_published_participant(uuid, uuid) from public;
grant execute on function public.can_read_published_version(uuid) to authenticated;
grant execute on function public.can_read_published_session(uuid) to authenticated;
grant execute on function public.can_read_published_participant(uuid, uuid) to authenticated;

-- RLS is deny-by-default for non-admin users. A published_schedule view is the only broad schedule surface.
do $$
declare t text;
begin
  foreach t in array array['institutions','profiles','departments','programmes','academic_years','semesters','classes','divisions','batches','student_groups','student_records','student_enrolments','elective_conflicts','subjects','subject_requirements','subject_requirement_groups','faculty','faculty_subject_eligibility','faculty_assignments','faculty_availability','faculty_workload_limits','faculty_preferences','rooms','facilities','room_facilities','subject_requirement_facilities','room_availability','timing_templates','semester_timing_templates','timing_working_days','timing_periods','timing_breaks','blocked_periods','scheduling_rules','generation_jobs','timetable_versions','timetable_sessions','session_participants','session_locks','approvals','repair_proposals','audit_log'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_manage_%I on public.%I', t, t);
    execute format('create policy admin_manage_%I on public.%I for all to authenticated using (public.is_approved_admin()) with check (public.is_approved_admin())', t, t);
  end loop;
end $$;

-- Private identity and preference scope.
drop policy if exists profile_self_read on public.profiles;
create policy profile_self_read on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists active_semester_read on public.semesters;
create policy active_semester_read on public.semesters for select to authenticated using (is_active);
drop policy if exists profile_self_update on public.profiles;
create policy profile_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists faculty_self_read on public.faculty;
create policy faculty_self_read on public.faculty for select to authenticated using (profile_id = auth.uid());
drop policy if exists student_record_self_read on public.student_records;
create policy student_record_self_read on public.student_records for select to authenticated using (profile_id = auth.uid());
drop policy if exists student_enrolment_self_read on public.student_enrolments;
create policy student_enrolment_self_read on public.student_enrolments for select to authenticated using (exists (select 1 from public.student_records sr where sr.id = student_record_id and sr.profile_id = auth.uid()));
drop policy if exists faculty_availability_self_read on public.faculty_availability;
create policy faculty_availability_self_read on public.faculty_availability for select to authenticated using (exists (select 1 from public.faculty f where f.id = faculty_id and f.profile_id = auth.uid()));
drop policy if exists faculty_availability_self_insert on public.faculty_availability;
create policy faculty_availability_self_insert on public.faculty_availability for insert to authenticated with check (approval = 'Pending' and submitted_by = auth.uid() and exists (select 1 from public.faculty f where f.id = faculty_id and f.profile_id = auth.uid()));
drop policy if exists faculty_availability_self_update on public.faculty_availability;
create policy faculty_availability_self_update on public.faculty_availability for update to authenticated using (approval = 'Pending' and exists (select 1 from public.faculty f where f.id = faculty_id and f.profile_id = auth.uid())) with check (approval = 'Pending' and submitted_by = auth.uid() and exists (select 1 from public.faculty f where f.id = faculty_id and f.profile_id = auth.uid()));

-- Direct session reads are still scoped; detailed joins should use published_schedule.
drop policy if exists published_version_self_read on public.timetable_versions;
create policy published_version_self_read on public.timetable_versions for select to authenticated using (public.can_read_published_version(id));
drop policy if exists published_session_self_read on public.timetable_sessions;
create policy published_session_self_read on public.timetable_sessions for select to authenticated using (public.can_read_published_session(id));
drop policy if exists published_participant_self_read on public.session_participants;
create policy published_participant_self_read on public.session_participants for select to authenticated using (public.can_read_published_participant(session_id, group_id));

create or replace view public.published_schedule
with (security_barrier = true)
as
select s.id as session_id, v.id as version_id, v.semester_id, s.subject_id,
       sub.code as subject_code, coalesce(sub.short_name, sub.name) as subject_name,
       s.session_type, s.occurrence_no, s.day_of_week, s.starts_at, s.ends_at,
       s.duration_periods, s.faculty_id, f.initials as faculty_initials,
       s.room_id, r.code as room_code, r.name as room_name,
       coalesce(string_agg(distinct sg.name, ', ' order by sg.name), '') as participant_groups
from public.timetable_sessions s
join public.timetable_versions v on v.id = s.version_id and v.status = 'Published'
join public.subjects sub on sub.id = s.subject_id
left join public.faculty f on f.id = s.faculty_id
left join public.rooms r on r.id = s.room_id
left join public.session_participants sp on sp.session_id = s.id
left join public.student_groups sg on sg.id = sp.group_id
where exists (select 1 from public.faculty own_f where own_f.id = s.faculty_id and own_f.profile_id = auth.uid())
   or exists (select 1 from public.session_participants own_sp join public.student_enrolments se on se.group_id = own_sp.group_id join public.student_records sr on sr.id = se.student_record_id where own_sp.session_id = s.id and sr.profile_id = auth.uid())
group by s.id, v.id, v.semester_id, s.subject_id, sub.code, sub.short_name, sub.name,
         s.session_type, s.occurrence_no, s.day_of_week, s.starts_at, s.ends_at,
         s.duration_periods, s.faculty_id, f.initials, s.room_id, r.code, r.name;
comment on view public.published_schedule is 'Scoped view: teachers and students receive only rows from the latest Published version that they teach or attend; drafts are never visible.';

-- Privileges permit RLS evaluation but policies remain the authorization boundary.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.published_schedule to authenticated;

create index if not exists departments_institution_idx on public.departments(institution_id);
create index if not exists programmes_department_idx on public.programmes(department_id);
create index if not exists semesters_year_idx on public.semesters(academic_year_id);
create index if not exists groups_semester_type_idx on public.student_groups(semester_id, group_type);
create index if not exists enrolments_group_idx on public.student_enrolments(group_id);
create index if not exists requirements_semester_subject_idx on public.subject_requirements(semester_id, subject_id);
create index if not exists assignments_requirement_idx on public.faculty_assignments(requirement_id);
create index if not exists availability_faculty_semester_idx on public.faculty_availability(faculty_id, semester_id, day_of_week);
create index if not exists rooms_institution_type_idx on public.rooms(institution_id, room_type);
create index if not exists periods_template_sequence_idx on public.timing_periods(timing_template_id, sequence_no);
create index if not exists jobs_semester_status_idx on public.generation_jobs(semester_id, status);
create index if not exists versions_semester_status_idx on public.timetable_versions(semester_id, status);
create index if not exists sessions_version_day_time_idx on public.timetable_sessions(version_id, day_of_week, starts_at);
create index if not exists participants_group_idx on public.session_participants(group_id);
create index if not exists audit_entity_idx on public.audit_log(entity_type, entity_id, created_at desc);

comment on column public.profiles.role is 'Exactly Admin, Teacher, or Student. Admin changes require an approved administrator or protected service-side provisioning.';
comment on column public.timetable_versions.status is 'Only Published versions are exposed to teacher/student schedule views.';

commit;
