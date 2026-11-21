-- Applied as "primary_admin_multi_admin_scale_10k".
-- ===== Primary (first) administrator is permanent; more admins can be added =====
alter table administrators add column if not exists is_primary boolean not null default false;
update administrators set is_primary = true
where id = (select id from administrators order by created_at asc limit 1)
  and not exists (select 1 from administrators where is_primary);
create unique index if not exists one_primary_admin on administrators (is_primary) where is_primary;

create or replace function protect_primary_admin() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_primary then raise exception 'The primary administrator cannot be removed'; end if;
    return old;
  end if;
  if old.is_primary and (new.is_primary is distinct from old.is_primary or new.is_active is distinct from old.is_active
      or new.id is distinct from old.id or new.email is distinct from old.email) then
    raise exception 'The primary administrator cannot be changed';
  end if;
  if not old.is_primary and new.is_primary then raise exception 'There can only be one primary administrator'; end if;
  return new;
end $$;
drop trigger if exists protect_primary_admin on administrators;
create trigger protect_primary_admin before update or delete on administrators
for each row execute function protect_primary_admin();

create or replace function is_primary_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from administrators where id = auth.uid() and is_primary and is_active) $$;

create function add_administrator(p_email text, p_full_name text default null) returns void
language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid;
begin
  if not is_primary_admin() then raise exception 'Only the primary administrator can add administrators'; end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then raise exception 'No account with that email. Ask them to sign in once first.'; end if;
  insert into administrators (id, email, full_name)
  select id, email, p_full_name from auth.users where id = v_id
  on conflict (id) do update set is_active = true;
  insert into audit_logs (admin_id, action, metadata) values (auth.uid(), 'admin_added', jsonb_build_object('admin_id', v_id));
end $$;

create function set_administrator_active(p_admin_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_primary_admin() then raise exception 'Only the primary administrator can change administrators'; end if;
  update administrators set is_active = p_active where id = p_admin_id;
  insert into audit_logs (admin_id, action, metadata) values (auth.uid(), case when p_active then 'admin_reactivated' else 'admin_deactivated' end, jsonb_build_object('admin_id', p_admin_id));
end $$;

revoke all on function is_primary_admin(), add_administrator(text, text), set_administrator_active(uuid, boolean) from public, anon;
grant execute on function is_primary_admin(), add_administrator(text, text), set_administrator_active(uuid, boolean) to authenticated;

-- ===== Scale: evaluate role checks once per query instead of once per row =====
alter policy "admin manage departments" on departments using ((select is_admin())) with check ((select is_admin()));
alter policy "admin manage courses" on courses using ((select is_admin())) with check ((select is_admin()));
alter policy "admin read admins" on administrators using ((select is_admin()));
alter policy "student read self" on students using (auth_user_id = (select auth.uid()) or (select is_admin()));
alter policy "admin update students" on students using ((select is_admin())) with check ((select is_admin()));
alter policy "read own registrations" on registrations using (student_id = (select current_student_id()) or (select is_admin()));
alter policy "admin sessions" on attendance_sessions using ((select is_admin())) with check ((select is_admin()));
alter policy "admin records" on attendance_records using ((select is_admin())) with check ((select is_admin()));
alter policy "admin read audit" on audit_logs using ((select is_admin()));
alter policy "photos read own or admin" on storage.objects using (bucket_id = 'student-photos' and ((storage.foldername(name))[1] = (select auth.uid())::text or (select is_admin())));

-- ===== Scale: indexes for search, reports and session lists =====
create extension if not exists pg_trgm with schema extensions;
create index if not exists students_name_trgm on students using gin (full_name extensions.gin_trgm_ops);
create index if not exists students_matric_trgm on students using gin (matric_no extensions.gin_trgm_ops);
create index if not exists sessions_created_idx on attendance_sessions (created_at desc);
create index if not exists sessions_course_created_idx on attendance_sessions (course_id, created_at);
create index if not exists sessions_open_idx on attendance_sessions (id) where status = 'open';
create index if not exists records_student_session_idx on attendance_records (student_id, session_id);

create or replace view admin_session_overview with (security_invoker = true) as
select s.id, s.created_at, s.expires_at, s.closed_at, s.status,
  case when s.status = 'open' and s.expires_at < now() then 'expired' else s.status::text end as effective_status,
  s.course_id, s.department_id, c.code as course_code, c.title as course_title, d.name as department,
  coalesce(x.total, 0) as total_students, coalesce(x.present, 0) as present_count
from attendance_sessions s
join courses c on c.id = s.course_id
join departments d on d.id = s.department_id
left join lateral (select count(*) as total, count(*) filter (where status = 'present') as present
                   from attendance_records where session_id = s.id) x on true;

create or replace function admin_attendance_summary(p_department_id uuid default null, p_course_id uuid default null, p_from date default null, p_to date default null)
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
  order by c.code, st.full_name, st.matric_no;
end; $$;
