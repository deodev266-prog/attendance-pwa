-- Applied as "allow_cascade_delete_registrations": lets deleting a student/auth user
-- cascade to registrations, while direct edits/deletes stay blocked.
create or replace function block_registration_changes()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Course registrations cannot be changed after registration';
end;
$$;
