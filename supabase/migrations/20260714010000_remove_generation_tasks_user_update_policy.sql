-- SECURITY: remove direct authenticated-user UPDATE access to generation_tasks.
--
-- Current application behavior checked before this migration:
-- - Seedance task creation uses the service-role-only reserve_generation_task RPC.
-- - Seedance tracking, completion, failure, refund, persistence, and watermark updates use server-side service-role clients.
-- - No current user-facing code path requires direct UPDATE access to public.generation_tasks.
-- - Admin updates continue through the separate "Admins can update generation tasks" policy.
--
-- This migration intentionally does NOT change INSERT policies or add INSERT triggers.
-- Production application requires explicit approval after preview verification.

begin;

drop policy if exists "Users can update own draft generation tasks"
on public.generation_tasks;

commit;

-- Expected effective behavior after application:
-- - authenticated users cannot directly update generation_tasks rows, including
--   status, output_url, credit_cost, user_id, api_task_id, polling_url, or settings.
-- - admins retain UPDATE access through the existing admin policy.
-- - service-role/server-owned Seedance flows remain unaffected because service_role
--   bypasses RLS and reserve_generation_task remains service-role-only.
