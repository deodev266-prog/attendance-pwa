-- Applied as "faculties_departments_2026_and_photo_lqip".
create table faculties (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table faculties enable row level security;
create policy "read faculties" on faculties for select to authenticated using (true);
create policy "admin manage faculties" on faculties for all to authenticated
  using ((select is_admin())) with check ((select is_admin()));

alter table departments add column faculty_id uuid references faculties(id) on delete restrict;
alter table departments add column description text;
alter table departments add column is_new boolean not null default false;   -- new programme (2026)
create index departments_faculty_idx on departments (faculty_id);

-- Tiny blurred placeholder for profile photos (LQIP), generated in the browser
alter table students add column photo_lqip text;
alter table students add constraint students_lqip_chk check (photo_lqip is null or (photo_lqip like 'data:image/%' and length(photo_lqip) < 3000));

-- Remove earlier placeholder departments that are not in the real list (only if nothing uses them)
delete from departments d
where d.name in ('Agricultural Economics and Extension','Agricultural Engineering','Business Administration','Crop Science',
                 'Development Studies','Fisheries and Aquaculture','Nursing Science','Soil Science')
  and not exists (select 1 from courses c where c.department_id = d.id)
  and not exists (select 1 from students s where s.department_id = d.id);

insert into faculties (name, sort_order) values
  ('Faculty of Agriculture & Renewable Natural Resources', 1),
  ('Faculty of Natural and Applied Sciences', 2),
  ('Faculty of Social and Management Sciences', 3);

insert into departments (name, description, faculty_id, is_new)
select v.name, v.descr, f.id, v.is_new
from (values
  ('Agricultural Economics, Extension and Agribusiness', null, 1, false),
  ('Agronomy', null, 1, false),
  ('Animal Science', null, 1, false),
  ('Food Science and Technology', null, 1, false),
  ('Forestry and Wildlife Management', null, 1, false),
  ('Water Resources Management and Agro-Meteorology', null, 1, false),
  ('Computer Science', null, 2, false),
  ('Mathematics', null, 2, false),
  ('Physics with Electronics', null, 2, false),
  ('Industrial Chemistry', null, 2, false),
  ('Plant Science', 'Botany', 2, false),
  ('Animal and Environmental Biology', 'Zoology', 2, false),
  ('Chemistry', null, 2, false),
  ('Biochemistry', null, 2, false),
  ('Meteorology', null, 2, false),
  ('Microbiology', null, 2, false),
  ('Biological Sciences', null, 2, false),
  ('Accounting', null, 3, false),
  ('Economics', null, 3, false),
  ('Management Sciences', 'Business Administration, Entrepreneurship', 3, false),
  ('Peace Management Studies', 'Peace and Conflict Resolution', 3, false),
  -- New programmes (2026). Faculty placement is an assumption - change in Setup/SQL if different.
  ('Information Technology', null, 2, true),
  ('Cyber Security', null, 2, true),
  ('Software Engineering', null, 2, true),
  ('Criminology and Security Studies', null, 3, true),
  ('Mass Communication', null, 3, true),
  ('International Relations', null, 3, true),
  ('Public Administration', null, 3, true)
) as v(name, descr, fac, is_new)
join faculties f on f.sort_order = v.fac
on conflict (name) do update set faculty_id = excluded.faculty_id, description = excluded.description, is_new = excluded.is_new;
