-- Applied as "roles_super_admin_and_admin".
-- ===== Roles: super_admin | admin =====
alter table administrators add column if not exists role text not null default 'admin';
alter table administrators drop constraint if exists administrators_role_chk;
alter table administrators add constraint administrators_role_chk check (role in ('super_admin', 'admin'));

-- Controlled assignment of the FIRST Super Admin: the existing permanent primary administrator.
-- (On a fresh project, make your own account the first admin and Super Admin with:
--    insert into administrators (id, email, role, is_primary)
--    select id, email, 'super_admin', true from auth.users where email = 'you@example.com';)
update administrators set role = 'super_admin' where is_primary;

-- The primary admin can never be demoted, deactivated, re-keyed or deleted
create or replace function protect_primary_admin() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.is_primary then raise exception 'The primary administrator cannot be removed'; end if;
    return old;
  end if;
  if old.is_primary and (new.is_primary is distinct from old.is_primary or new.is_active is distinct from old.is_active
      or new.id is distinct from old.id or new.email is distinct from old.email or new.role is distinct from old.role) then
    raise exception 'The primary administrator cannot be changed';
  end if;
  if not old.is_primary and new.is_primary then raise exception 'There can only be one primary administrator'; end if;
  return new;
end $$;

-- Nobody can edit administrator rows from the browser: only the security-definer functions below can.
revoke insert, update, delete, truncate on administrators from anon, authenticated;

create or replace function is_super_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from administrators where id = auth.uid() and is_active and role = 'super_admin') $$;

drop function if exists add_administrator(text, text);
create function add_administrator(p_email text, p_full_name text default null, p_role text default 'admin') returns void
language plpgsql security definer set search_path = public, auth as $$
declare v_id uuid;
begin
  if not is_super_admin() then raise exception 'Only a Super Admin can add administrators'; end if;
  if p_role not in ('admin', 'super_admin') then raise exception 'Invalid role'; end if;
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then raise exception 'No account with that email. Create the account first, or ask them to sign in once.'; end if;
  insert into administrators (id, email, full_name, role)
  select id, email, p_full_name, p_role from auth.users where id = v_id
  on conflict (id) do update set is_active = true;
  insert into audit_logs (admin_id, action, metadata) values (auth.uid(), 'admin_added', jsonb_build_object('admin_id', v_id, 'role', p_role));
end $$;

create function set_administrator_role(p_admin_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then raise exception 'Only a Super Admin can change roles'; end if;
  if p_role not in ('admin', 'super_admin') then raise exception 'Invalid role'; end if;
  if p_admin_id = auth.uid() then raise exception 'You cannot change your own role'; end if;
  update administrators set role = p_role where id = p_admin_id;
  insert into audit_logs (admin_id, action, metadata) values (auth.uid(), 'admin_role_changed', jsonb_build_object('admin_id', p_admin_id, 'role', p_role));
end $$;

create or replace function set_administrator_active(p_admin_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_super_admin() then raise exception 'Only a Super Admin can change administrators'; end if;
  if p_admin_id = auth.uid() then raise exception 'You cannot change your own access'; end if;
  update administrators set is_active = p_active where id = p_admin_id;
  insert into audit_logs (admin_id, action, metadata) values (auth.uid(), case when p_active then 'admin_reactivated' else 'admin_deactivated' end, jsonb_build_object('admin_id', p_admin_id));
end $$;

-- Reports / percentages / export data: Super Admin only
create or replace function admin_attendance_summary(p_department_id uuid default null, p_course_id uuid default null, p_from date default null, p_to date default null)
returns table (matric_no text, full_name text, department text, course_code text, course_title text,
  sessions_held bigint, sessions_attended bigint, attendance_percentage numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_super_admin() then raise exception 'Super Admins only'; end if;
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

revoke all on function is_super_admin(), add_administrator(text, text, text), set_administrator_role(uuid, text) from public, anon;
grant execute on function is_super_admin(), add_administrator(text, text, text), set_administrator_role(uuid, text) to authenticated;

-- ===== RLS: structure/student management and audit = Super Admin; sessions & records stay with all active admins =====
alter policy "admin manage departments" on departments using ((select is_super_admin())) with check ((select is_super_admin()));
alter policy "admin manage courses" on courses using ((select is_super_admin())) with check ((select is_super_admin()));
alter policy "admin manage faculties" on faculties using ((select is_super_admin())) with check ((select is_super_admin()));
alter policy "admin update students" on students using ((select is_super_admin())) with check ((select is_super_admin()));
alter policy "admin read audit" on audit_logs using ((select is_super_admin()));
alter policy "admin read admins" on administrators using (id = (select auth.uid()) or (select is_super_admin()));
