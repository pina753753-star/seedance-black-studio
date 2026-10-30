-- Disposable-database check of supabase/migrations/20261030000000_allow_motion_reference_video_20s.sql.
-- Run against an EMPTY local cluster (never an existing environment) after stubbing the Supabase pieces the
-- first migration needs (roles anon/authenticated/service_role, schema auth with users(id) and uid(),
-- schema storage with buckets(id,name,public,file_size_limit,allowed_mime_types), public.generation_tasks(id)),
-- then applying 20261010000000, 20261016000000 and 20261023061000. Use psql -v ON_ERROR_STOP=1 and:
--   psql -v label=BEFORE -f tests/postgres/motion_reference_video_constraints.sql
--   psql -f supabase/migrations/20261030000000_allow_motion_reference_video_20s.sql
--   psql -v label=AFTER -f tests/postgres/motion_reference_video_constraints.sql
-- Expected BEFORE: 15000/15=ok, 16200/17=REJECT, 20000/20=REJECT (others REJECT except 2000/2=ok).
-- Expected AFTER : 15000/15=ok, 16200/17=ok, 20000/20=ok, 20001/21=REJECT, 16200/16=REJECT (billable must be ceil), 1999/2=REJECT, 2000/2=ok.
insert into auth.users(id) values ('00000000-0000-4000-8000-000000000001') on conflict do nothing;
create or replace function pg_temp.ins(ms int, bill int) returns text language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.seedance_reference_video_uploads(id,user_id,status,staging_path,rights_confirmed_at,duration_ms,billable_seconds,expires_at)
  values (v,'00000000-0000-4000-8000-000000000001','uploading','staging/00000000-0000-4000-8000-000000000001/'||v||'.mp4',now(),ms,bill,now()+interval '1 day');
  return 'ok';
exception when others then return 'REJECT';
end $$;
select :'label' || ' 15000/15=' || pg_temp.ins(15000,15) || ' 16200/17=' || pg_temp.ins(16200,17) || ' 20000/20=' || pg_temp.ins(20000,20)
  || ' 20001/21=' || pg_temp.ins(20001,21) || ' 16200/16(wrong billable)=' || pg_temp.ins(16200,16) || ' 1999/2=' || pg_temp.ins(1999,2) || ' 2000/2=' || pg_temp.ins(2000,2);
