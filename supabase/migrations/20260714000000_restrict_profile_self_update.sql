-- SECURITY: prevent authenticated users from escalating privileges through public.profiles.
--
-- Current application behavior checked before this migration:
-- - profile.html reads display_name, role, and plan.
-- - No current user-facing code updates public.profiles.
-- - Admin/server-owned profile changes must continue to use service-role or owner privileges.
--
-- This migration intentionally does NOT touch generation_tasks.

begin;

-- Remove the broad table-level UPDATE grants that made every profile column
-- writable whenever an UPDATE RLS policy matched.
revoke update on table public.profiles from anon;
revoke update on table public.profiles from authenticated;

-- Replace the existing owner-only row policy with an authenticated-only policy.
-- Row ownership remains required, while column privileges below limit what may
-- be changed to display_name only.
drop policy if exists "Users can update own profile" on public.profiles;

create policy "Users can update own display name"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- The only direct self-service profile field currently permitted.
grant update (display_name) on table public.profiles to authenticated;

commit;

-- Expected effective behavior after application:
-- - authenticated users may update only their own display_name.
-- - authenticated users cannot update id, email, role, plan,
--   stripe_customer_id, created_at, or updated_at.
-- - admins/service-role/server-owned flows remain unaffected by RLS bypass or
--   their separate privileges.
