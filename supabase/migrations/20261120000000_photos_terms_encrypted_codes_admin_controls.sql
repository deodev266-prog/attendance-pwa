-- Applied as "photos_terms_encrypted_codes_admin_controls".
-- Student photo + terms acceptance
alter table students add column if not exists photo_path text;
alter table students add column if not exists terms_accepted_at timestamptz;
alter table students add column if not exists terms_version text;

drop policy if exists "student create self" on students;
create policy "student create self" on students for insert to authenticated
  with check (auth_user_id = (select auth.uid()) and registration_completed = false
    and terms_accepted_at is not null
    and photo_path like (select auth.uid())::text || '/%');

-- Private photo bucket: students write/read only their own folder, admins read all
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('student-photos', 'student-photos', false, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "photos insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'student-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "photos update own" on storage.objects for update to authenticated
  using (bucket_id = 'student-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "photos read own or admin" on storage.objects for select to authenticated
  using (bucket_id = 'student-photos' and ((storage.foldername(name))[1] = (select auth.uid())::text or is_admin()));

-- Encrypted copy of the code (key in Supabase Vault); bcrypt hash is still what verifies attempts
alter table attendance_sessions add column if not exists code_encrypted bytea;
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'attendance_code_key') then
    perform vault.create_secret(encode(gen_random_bytes(32), 'hex'), 'attendance_code_key', 'Key for encrypting attendance codes');
  end if;
end $$;

create or replace function _code_key() returns text
language sql security definer set search_path = public, vault
as $$ select decrypted_secret from vault.decrypted_secrets where name = 'attendance_code_key' $$;

create or replace function _new_code() returns text
language sql volatile set search_path = public, extensions
as $$ select lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0') $$;

create or replace function _apply_code(p_session_id uuid, p_code text) returns void
language plpgsql security definer set search_path = public, extensions
as $$
begin
  update attendance_sessions
  set code_hash = crypt(p_code, gen_salt('bf')), code_encrypted = pgp_sym_encrypt(p_code, _code_key())
  where id = p_session_id;
  update attendance_records set failed_attempts = 0 where session_id = p_session_id and status = 'absent';
end; $$;
revoke all on function _code_key(), _new_code(), _apply_code(uuid, text) from public, anon, authenticated;

create or replace function create_attendance_session(p_course_id uuid, p_department_id uuid, p_student_ids uuid[], p_duration_minutes int default 30)
returns table (session_id uuid, code text)
language plpgsql security definer set search_path = public, extensions
as $$
declare v_code text := _new_code(); v_id uuid; v_n int;
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  if p_duration_minutes is null or p_duration_minutes < 1 or p_duration_minutes > 720 then
    raise exception 'Duration must be 1-720 minutes'; end if;
  if not exists (select 1 from courses where id = p_course_id and department_id = p_department_id) then
    raise exception 'Course does not belong to that department'; end if;
  insert into attendance_sessions (course_id, department_id, created_by, code_hash, expires_at)
  values (p_course_id, p_department_id, auth.uid(), 'pending', now() + make_interval(mins => p_duration_minutes))
  returning id into v_id;
  insert into attendance_records (session_id, student_id)
  select v_id, s.id from students s
  join registrations r on r.student_id = s.id and r.course_id = p_course_id
  where s.id = any (p_student_ids) and s.department_id = p_department_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'None of the selected students are registered for this course'; end if;
  perform _apply_code(v_id, v_code);
  insert into audit_logs (admin_id, session_id, action, metadata)
  values (auth.uid(), v_id, 'session_created', jsonb_build_object('course_id', p_course_id, 'students', v_n, 'minutes', p_duration_minutes));
  return query select v_id, v_code;
end; $$;

create or replace function rotate_session_code(p_session_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_code text := _new_code();
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  if not exists (select 1 from attendance_sessions where id = p_session_id and status = 'open') then
    raise exception 'Session is not open'; end if;
  perform _apply_code(p_session_id, v_code);
  insert into audit_logs (admin_id, session_id, action) values (auth.uid(), p_session_id, 'code_rotated');
  return v_code;
end; $$;

create function set_session_code(p_session_id uuid, p_code text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  if p_code is null or p_code !~ '^[0-9]{6}$' then raise exception 'Code must be exactly 6 digits'; end if;
  if not exists (select 1 from attendance_sessions where id = p_session_id and status = 'open') then
    raise exception 'Session is not open'; end if;
  perform _apply_code(p_session_id, p_code);
  insert into audit_logs (admin_id, session_id, action) values (auth.uid(), p_session_id, 'code_changed');
end; $$;

create function reveal_session_code(p_session_id uuid)
returns text language plpgsql stable security definer set search_path = public, extensions as $$
declare v text;
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  select pgp_sym_decrypt(code_encrypted, _code_key()) into v from attendance_sessions where id = p_session_id and status = 'open';
  return v;
end; $$;

create function set_session_expiry(p_session_id uuid, p_minutes int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Administrators only'; end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 720 then raise exception 'Duration must be 1-720 minutes'; end if;
  update attendance_sessions set expires_at = now() + make_interval(mins => p_minutes), status = 'open', closed_at = null where id = p_session_id;
  insert into audit_logs (admin_id, session_id, action, metadata) values (auth.uid(), p_session_id, 'expiry_changed', jsonb_build_object('minutes_from_now', p_minutes));
end; $$;

revoke all on function set_session_code(uuid, text), reveal_session_code(uuid), set_session_expiry(uuid, int) from public, anon;
grant execute on function set_session_code(uuid, text), reveal_session_code(uuid), set_session_expiry(uuid, int) to authenticated;
