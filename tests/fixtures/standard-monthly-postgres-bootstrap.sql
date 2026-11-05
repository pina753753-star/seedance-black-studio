-- Disposable PostgreSQL fixture only. Not a migration or a production role setup.
-- Supabase-managed roles/auth schema are emulated explicitly; public table RLS
-- and security migrations are loaded unchanged from the repository by the test.
create role anon login nosuperuser nobypassrls noinherit;
create role authenticated login nosuperuser nobypassrls noinherit;
create role service_role login nosuperuser bypassrls noinherit;
create role service_without_bypass login nosuperuser nobypassrls noinherit;
create schema auth;
create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role, service_without_bypass;
grant execute on function auth.uid() to anon, authenticated, service_role, service_without_bypass;
-- These explicit broad grants emulate Supabase defaults and let the real RLS
-- policies (not absent grants) establish ordinary-user table boundaries.
alter default privileges in schema public grant select,insert,update,delete on tables to anon,authenticated,service_role;
