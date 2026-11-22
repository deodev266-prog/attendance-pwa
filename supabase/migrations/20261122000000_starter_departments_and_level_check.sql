-- Applied as "starter_departments_and_level_check".
-- Starter department list (edit/add in Setup; matched by name so re-running is safe)
insert into departments (name) values
  ('Agricultural Economics and Extension'),
  ('Agricultural Engineering'),
  ('Agronomy'),
  ('Animal Science'),
  ('Business Administration'),
  ('Computer Science'),
  ('Crop Science'),
  ('Development Studies'),
  ('Economics'),
  ('Fisheries and Aquaculture'),
  ('Food Science and Technology'),
  ('Forestry and Wildlife Management'),
  ('Nursing Science'),
  ('Soil Science')
on conflict (name) do nothing;

-- Level is one of 100/200/300/400 (enforced in the database, not just the form)
alter table students drop constraint if exists students_level_chk;
alter table students add constraint students_level_chk check (level is null or level in ('100', '200', '300', '400'));
