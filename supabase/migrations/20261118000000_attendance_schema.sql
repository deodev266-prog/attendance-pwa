-- =====================================================================
-- Campus Attendance PWA - Supabase schema
-- Run in the Supabase SQL editor, top to bottom.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Enums ----------------------------------------------------
create type attendance_status as enum ('present', 'absent');
create type session_status   as enum ('open', 'closed');

-- ---------- Core tables ----------------------------------------------
create table departments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table courses (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references departments(id) on delete restrict,
  code          text not null unique,          -- e.g. NSC 201
  title         text not null,
  created_at    timestamptz not null default now()
);

-- Admins are Supabase Auth users (Google sign-in) that you add here.
create table administrators (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  full_name  text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table students (
  id                     uuid primary key default gen_random_uuid(),
  auth_user_id           uuid not null unique references auth.users(id) on delete cascade,
  matric_no              text not null unique,
  full_name              text not null,
  email                  text,
  department_id          uuid not null references departments(id),
  level                  text,
  registration_completed boolean not null default false,  -- locks course choice
  created_at             timestamptz not null default now()
);

-- Written once, by register_courses(). Never editable afterwards.
create table registrations (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid not null references students(id) on delete cascade,
  course_id     uuid not null references courses(id) on delete restrict,
  registered_at timestamptz not null default now(),
  unique (student_id, course_id)
);

create table attendance_sessions (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references courses(id),
  department_id uuid not null references departments(id),
  created_by    uuid not null references administrators(id),
  code_hash     text not null,                 -- bcrypt hash; plain code is never stored
  status        session_status not null default 'open',
  created_at    timestamptz not null default now(),
  closed_at     timestamptz
);

-- One row per selected student per session. Created as 'absent',
-- flipped to 'present' by mark_attendance().
create table attendance_records (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references attendance_sessions(id) on delete cascade,
  student_id      uuid not null references students(id) on delete cascade,
  status          attendance_status not null default 'absent',
  marked_at       timestamptz,
  authorized_by   uuid references administrators(id),  -- admin who owns the session
  failed_attempts int not null default 0,
  unique (session_id, student_id)                       -- no duplicates
);

create table audit_logs (
  id          bigint generated always as identity primary key,
  admin_id    uuid references administrators(id),
  student_id  uuid references students(id),
  session_id  uuid references attendance_sessions(id),
  action      text not null,
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index on courses (department_id);
create index on students (department_id);
create index on registrations (student_id);
create index on registrations (course_id);
create index on attendance_records (student_id);
create index on attendance_records (session_id);
create index on attendance_sessions (course_id, status);
create index on attendance_sessions (created_by);
create index on attendance_records (authorized_by);
create index on audit_logs (admin_id);
create index on audit_logs (student_id);
create index on audit_logs (session_id);

-- ---------- Helpers --------------------------------------------------
create or replace function is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from administrators where id = auth.uid() and is_active
  );
$$;

create or replace function current_student_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from students where auth_user_id = auth.uid();
$$;

-- ---------- Registrations are immutable ------------------------------
create or replace function block_registration_changes()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'Course registrations cannot be changed after registration';
end;
$$;

create trigger registrations_immutable
before update or delete on registrations
for each row execute function block_registration_changes();

-- Student submits their courses ONCE.
create or replace function register_courses(p_course_ids uuid[])
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_student students%rowtype;
begin
  select * into v_student from students where auth_user_id = auth.uid() for update;
  if not found then raise exception 'Student profile not found'; end if;
  if v_student.registration_completed then
    raise exception 'Courses already registered and locked';
  end if;
  if coalesce(array_length(p_course_ids, 1), 0) = 0 then
    raise exception 'Select at least one course';
  end if;

  insert into registrations (student_id, course_id)
  select v_student.id, c.id
  from courses c
  where c.id = any (p_course_ids);

  update students set registration_completed = true where id = v_student.id;
end;
$$;

-- ---------- Admin: create a session ----------------------------------
-- Returns the plain code ONCE. Only the hash is stored.
create or replace function create_attendance_session(
  p_course_id     uuid,
  p_department_id uuid,
  p_student_ids   uuid[]
)
returns table (session_id uuid, code text)
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_code text;
  v_id   uuid;
begin
  if not is_admin() then raise exception 'Administrators only'; end if;

  v_code := lpad(
    ((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text,
    6, '0');

  insert into attendance_sessions (course_id, department_id, created_by, code_hash)
  values (p_course_id, p_department_id, auth.uid(), crypt(v_code, gen_salt('bf')))
  returning id into v_id;

  -- Only students who are in the department AND registered for the course
  insert into attendance_records (session_id, student_id)
  select v_id, s.id
  from students s
  join registrations r on r.student_id = s.id and r.course_id = p_course_id
  where s.id = any (p_student_ids)
    and s.department_id = p_department_id;

  insert into audit_logs (admin_id, session_id, action, metadata)
  values (auth.uid(), v_id, 'session_created',
          jsonb_build_object('course_id', p_course_id,
                             'students', coalesce(array_length(p_student_ids, 1), 0)));

  return query select v_id, v_code;
end;
$$;

-- ---------- Mark attendance (admin types code on student's device) ---
-- Called from the student's authenticated session. The authorizing
-- admin is the session creator. Wrong codes are counted; 5 failures
-- lock that student's row until an admin resets it.
create or replace function mark_attendance(p_session_id uuid, p_code text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_student_id uuid := current_student_id();
  v_session    attendance_sessions%rowtype;
  v_record     attendance_records%rowtype;
begin
  if v_student_id is null then return 'not_a_student'; end if;

  select * into v_session from attendance_sessions where id = p_session_id;
  if not found or v_session.status <> 'open' then return 'session_closed'; end if;

  select * into v_record from attendance_records
  where session_id = p_session_id and student_id = v_student_id
  for update;
  if not found then return 'not_on_roster'; end if;
  if v_record.status = 'present' then return 'already_marked'; end if;
  if v_record.failed_attempts >= 5 then return 'locked'; end if;

  if v_session.code_hash <> crypt(p_code, v_session.code_hash) then
    update attendance_records set failed_attempts = failed_attempts + 1
    where id = v_record.id;
    insert into audit_logs (student_id, session_id, action)
    values (v_student_id, p_session_id, 'wrong_code');
    return 'invalid_code';
  end if;

  update attendance_records
  set status = 'present', marked_at = now(), authorized_by = v_session.created_by
  where id = v_record.id;

  insert into audit_logs (admin_id, student_id, session_id, action)
  values (v_session.created_by, v_student_id, p_session_id, 'marked_present');

  return 'ok';
end;
$$;

-- Sessions the signed-in student can currently be marked in (no code, no status)
create or replace function my_open_sessions()
returns table (session_id uuid, course_code text, course_title text)
language sql stable security definer set search_path = public
as $$
  select s.id, c.code, c.title
  from attendance_records ar
  join attendance_sessions s on s.id = ar.session_id and s.status = 'open'
  join courses c on c.id = s.course_id
  where ar.student_id = current_student_id()
    and ar.status = 'absent';
$$;

create or replace function close_attendance_session(p_session_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  update attendance_sessions
  set status = 'closed', closed_at = now()
  where id = p_session_id;
  insert into audit_logs (admin_id, session_id, action)
  values (auth.uid(), p_session_id, 'session_closed');
end;
$$;

create or replace function reset_failed_attempts(p_session_id uuid, p_student_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  update attendance_records set failed_attempts = 0
  where session_id = p_session_id and student_id = p_student_id;
  insert into audit_logs (admin_id, student_id, session_id, action)
  values (auth.uid(), p_student_id, p_session_id, 'attempts_reset');
end;
$$;

-- ---------- Views ----------------------------------------------------
-- Student view: counts and percentage only. No status, no timestamps.
-- (Runs as owner, filtered to the signed-in student.)
create or replace view student_attendance_summary as
select
  r.student_id,
  c.id   as course_id,
  c.code as course_code,
  c.title as course_title,
  count(ar.id) filter (where s.status = 'closed')                         as sessions_held,
  count(ar.id) filter (where s.status = 'closed' and ar.status = 'present') as sessions_attended,
  case when count(ar.id) filter (where s.status = 'closed') = 0 then 0
       else round(100.0 * count(ar.id) filter (where s.status = 'closed' and ar.status = 'present')
                  / count(ar.id) filter (where s.status = 'closed'), 1)
  end as attendance_percentage
from registrations r
join courses c on c.id = r.course_id
left join attendance_sessions s on s.course_id = r.course_id
left join attendance_records ar on ar.session_id = s.id and ar.student_id = r.student_id
where r.student_id = current_student_id()
group by r.student_id, c.id, c.code, c.title;

-- Admin report: full detail (feed this to Google Sheets export)
create or replace view admin_attendance_report
with (security_invoker = true) as
select
  ar.id, s.id as session_id, s.created_at as session_date,
  d.name as department, c.code as course_code, c.title as course_title,
  st.matric_no, st.full_name, ar.status, ar.marked_at,
  a.email as authorized_by_email
from attendance_records ar
join attendance_sessions s on s.id = ar.session_id
join courses c on c.id = s.course_id
join departments d on d.id = s.department_id
join students st on st.id = ar.student_id
left join administrators a on a.id = ar.authorized_by;

-- ---------- Row Level Security ---------------------------------------
alter table departments         enable row level security;
alter table courses             enable row level security;
alter table administrators      enable row level security;
alter table students            enable row level security;
alter table registrations       enable row level security;
alter table attendance_sessions enable row level security;
alter table attendance_records  enable row level security;
alter table audit_logs          enable row level security;

-- Departments / courses: signed-in users read, admins manage
create policy "read departments" on departments for select to authenticated using (true);
create policy "admin manage departments" on departments for all to authenticated
  using (is_admin()) with check (is_admin());

create policy "read courses" on courses for select to authenticated using (true);
create policy "admin manage courses" on courses for all to authenticated
  using (is_admin()) with check (is_admin());

-- Administrators: admins can read; changes only via SQL editor / service role
create policy "admin read admins" on administrators for select to authenticated
  using (is_admin());

-- Students: own row (or admin); students create their own profile once
create policy "student read self" on students for select to authenticated
  using (auth_user_id = (select auth.uid()) or is_admin());
create policy "student create self" on students for insert to authenticated
  with check (auth_user_id = (select auth.uid()) and registration_completed = false);
create policy "admin update students" on students for update to authenticated
  using (is_admin()) with check (is_admin());

-- Registrations: read-only (inserts go through register_courses())
create policy "read own registrations" on registrations for select to authenticated
  using (student_id = current_student_id() or is_admin());

-- Sessions, records, audit: admin only (students use the functions/views above)
create policy "admin sessions" on attendance_sessions for all to authenticated
  using (is_admin()) with check (is_admin());
create policy "admin records" on attendance_records for all to authenticated
  using (is_admin()) with check (is_admin());
create policy "admin read audit" on audit_logs for select to authenticated
  using (is_admin());

-- ---------- Function permissions -------------------------------------
revoke all on function create_attendance_session(uuid, uuid, uuid[]) from public, anon;
revoke all on function close_attendance_session(uuid)               from public, anon;
revoke all on function reset_failed_attempts(uuid, uuid)            from public, anon;
revoke all on function register_courses(uuid[])                     from public, anon;
revoke all on function mark_attendance(uuid, text)                  from public, anon;
revoke all on function my_open_sessions()                           from public, anon;

grant execute on function create_attendance_session(uuid, uuid, uuid[]) to authenticated;
grant execute on function close_attendance_session(uuid)               to authenticated;
grant execute on function reset_failed_attempts(uuid, uuid)            to authenticated;
grant execute on function register_courses(uuid[])                     to authenticated;
grant execute on function mark_attendance(uuid, text)                  to authenticated;
grant execute on function my_open_sessions()                           to authenticated;

revoke all on student_attendance_summary from anon;
revoke all on admin_attendance_report    from anon;
grant select on student_attendance_summary to authenticated;
grant select on admin_attendance_report    to authenticated;

-- ---------- First admin (replace with your Google account email) -----
-- Sign in once with Google, then run:
-- insert into administrators (id, email, full_name)
-- select id, email, 'Your Name' from auth.users where email = 'you@example.com';
