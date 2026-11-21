-- Applied to the live project as "attendance_sessions_expiry_reports".
-- Adds session expiry, reopen/rotate-code, admin overview + report function.
alter table attendance_sessions add column if not exists expires_at timestamptz;

drop function if exists create_attendance_session(uuid, uuid, uuid[]);
create function create_attendance_session(p_course_id uuid, p_department_id uuid, p_student_ids uuid[], p_duration_minutes int default 30)
returns table (session_id uuid, code text)
language plpgsql security definer set search_path = public, extensions
as $$
declare v_code text; v_id uuid; v_n int;
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  if p_duration_minutes is null or p_duration_minutes < 1 or p_duration_minutes > 720 then
    raise exception 'Duration must be 1-720 minutes'; end if;
  if not exists (select 1 from courses where id = p_course_id and department_id = p_department_id) then
    raise exception 'Course does not belong to that department'; end if;
  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  insert into attendance_sessions (course_id, department_id, created_by, code_hash, expires_at)
  values (p_course_id, p_department_id, auth.uid(), crypt(v_code, gen_salt('bf')), now() + make_interval(mins => p_duration_minutes))
  returning id into v_id;
  insert into attendance_records (session_id, student_id)
  select v_id, s.id from students s
  join registrations r on r.student_id = s.id and r.course_id = p_course_id
  where s.id = any (p_student_ids) and s.department_id = p_department_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'None of the selected students are registered for this course'; end if;
  insert into audit_logs (admin_id, session_id, action, metadata)
  values (auth.uid(), v_id, 'session_created', jsonb_build_object('course_id', p_course_id, 'students', v_n, 'minutes', p_duration_minutes));
  return query select v_id, v_code;
end; $$;

create or replace function mark_attendance(p_session_id uuid, p_code text)
returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_student_id uuid := current_student_id();
  v_session attendance_sessions%rowtype;
  v_record attendance_records%rowtype;
begin
  if v_student_id is null then return 'not_a_student'; end if;
  if p_code is null or p_code !~ '^[0-9]{6}$' then return 'invalid_format'; end if;
  select * into v_session from attendance_sessions where id = p_session_id;
  if not found or v_session.status <> 'open' then return 'session_closed'; end if;
  if v_session.expires_at is not null and v_session.expires_at < now() then return 'expired'; end if;
  select * into v_record from attendance_records where session_id = p_session_id and student_id = v_student_id for update;
  if not found then return 'not_on_roster'; end if;
  if v_record.status = 'present' then return 'already_marked'; end if;
  if v_record.failed_attempts >= 5 then return 'locked'; end if;
  if v_session.code_hash <> crypt(p_code, v_session.code_hash) then
    update attendance_records set failed_attempts = failed_attempts + 1 where id = v_record.id;
    insert into audit_logs (student_id, session_id, action) values (v_student_id, p_session_id, 'wrong_code');
    return 'invalid_code:' || greatest(0, 4 - v_record.failed_attempts);
  end if;
  update attendance_records set status = 'present', marked_at = now(), authorized_by = v_session.created_by where id = v_record.id;
  insert into audit_logs (admin_id, student_id, session_id, action) values (v_session.created_by, v_student_id, p_session_id, 'marked_present');
  return 'ok';
end; $$;

create or replace function my_open_sessions()
returns table (session_id uuid, course_code text, course_title text)
language sql stable security definer set search_path = public
as $$
  select s.id, c.code, c.title
  from attendance_records ar
  join attendance_sessions s on s.id = ar.session_id and s.status = 'open'
    and (s.expires_at is null or s.expires_at > now())
  join courses c on c.id = s.course_id
  where ar.student_id = current_student_id() and ar.status = 'absent';
$$;

create function reopen_attendance_session(p_session_id uuid, p_duration_minutes int default 30)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  if p_duration_minutes < 1 or p_duration_minutes > 720 then raise exception 'Duration must be 1-720 minutes'; end if;
  update attendance_sessions set status = 'open', closed_at = null, expires_at = now() + make_interval(mins => p_duration_minutes) where id = p_session_id;
  insert into audit_logs (admin_id, session_id, action) values (auth.uid(), p_session_id, 'session_reopened');
end; $$;

-- New code for an open session (e.g. admin lost it). Old code stops working.
create function rotate_session_code(p_session_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_code text;
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  if not exists (select 1 from attendance_sessions where id = p_session_id and status = 'open') then
    raise exception 'Session is not open'; end if;
  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');
  update attendance_sessions set code_hash = crypt(v_code, gen_salt('bf')) where id = p_session_id;
  update attendance_records set failed_attempts = 0 where session_id = p_session_id and status = 'absent';
  insert into audit_logs (admin_id, session_id, action) values (auth.uid(), p_session_id, 'code_rotated');
  return v_code;
end; $$;

create or replace view student_attendance_summary as
select r.student_id, c.id as course_id, c.code as course_code, c.title as course_title,
  count(ar.id) filter (where s.id is not null and (s.status = 'closed' or s.expires_at < now())) as sessions_held,
  count(ar.id) filter (where (s.status = 'closed' or s.expires_at < now()) and ar.status = 'present') as sessions_attended,
  case when count(ar.id) filter (where s.status = 'closed' or s.expires_at < now()) = 0 then 0
       else round(100.0 * count(ar.id) filter (where (s.status = 'closed' or s.expires_at < now()) and ar.status = 'present')
            / count(ar.id) filter (where s.status = 'closed' or s.expires_at < now()), 1) end as attendance_percentage
from registrations r
join courses c on c.id = r.course_id
left join attendance_sessions s on s.course_id = r.course_id
left join attendance_records ar on ar.session_id = s.id and ar.student_id = r.student_id
where r.student_id = current_student_id()
group by r.student_id, c.id, c.code, c.title;

create view admin_session_overview with (security_invoker = true) as
select s.id, s.created_at, s.expires_at, s.closed_at, s.status,
  case when s.status = 'open' and s.expires_at < now() then 'expired' else s.status::text end as effective_status,
  s.course_id, s.department_id, c.code as course_code, c.title as course_title, d.name as department,
  count(ar.id) as total_students, count(ar.id) filter (where ar.status = 'present') as present_count
from attendance_sessions s
join courses c on c.id = s.course_id join departments d on d.id = s.department_id
left join attendance_records ar on ar.session_id = s.id
group by s.id, c.id, d.id;

create function admin_attendance_summary(p_department_id uuid default null, p_course_id uuid default null, p_from date default null, p_to date default null)
returns table (matric_no text, full_name text, department text, course_code text, course_title text,
  sessions_held bigint, sessions_attended bigint, attendance_percentage numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  return query
  select st.matric_no, st.full_name, d.name, c.code, c.title,
    count(ar.id), count(ar.id) filter (where ar.status = 'present'),
    case when count(ar.id) = 0 then 0 else round(100.0 * count(ar.id) filter (where ar.status = 'present') / count(ar.id), 1) end
  from registrations r
  join students st on st.id = r.student_id
  join departments d on d.id = st.department_id
  join courses c on c.id = r.course_id
  left join attendance_sessions s on s.course_id = c.id
    and (s.status = 'closed' or s.expires_at < now())
    and (p_from is null or s.created_at >= p_from) and (p_to is null or s.created_at < p_to + 1)
  left join attendance_records ar on ar.session_id = s.id and ar.student_id = st.id
  where (p_department_id is null or st.department_id = p_department_id)
    and (p_course_id is null or c.id = p_course_id)
  group by st.matric_no, st.full_name, d.name, c.code, c.title
  order by c.code, st.full_name;
end; $$;

revoke all on function create_attendance_session(uuid, uuid, uuid[], int), reopen_attendance_session(uuid, int),
  rotate_session_code(uuid), admin_attendance_summary(uuid, uuid, date, date) from public, anon;
grant execute on function create_attendance_session(uuid, uuid, uuid[], int), reopen_attendance_session(uuid, int),
  rotate_session_code(uuid), admin_attendance_summary(uuid, uuid, date, date) to authenticated;
revoke all on admin_session_overview from anon;
grant select on admin_session_overview to authenticated;
