-- SECURITY: remove direct authenticated-user INSERT access to generation_tasks.
--
-- Current application behavior checked before this migration:
-- - Seedance task creation (generate-prod.html, id="create" -> start()) calls
--   POST /api/seedance-start, which creates rows exclusively via the
--   service-role-only reserve_generation_task RPC (api/_lib/seedance-start.js).
-- - auth-config.js contains a legacy client-side
--   `client.from('generation_tasks').insert(taskPayload)` call inside
--   createAndRun(), but it is dead code in the current UI: it is only wired
--   to an element with id="createBtn", which does not exist in any current
--   HTML page (generate-prod.html's create button has id="create" and uses
--   the /api/seedance-start path instead). No reachable code path currently
--   depends on this INSERT policy.
-- - Admin task management (admin.html) only reads/deletes generation_tasks;
--   it does not insert rows.
-- - No other server-side route was found performing a direct authenticated
--   INSERT into generation_tasks; server-side flows use the service role,
--   which bypasses RLS regardless of this policy.
--
-- This migration intentionally does NOT change UPDATE policies (already
-- handled in 20260714010000_remove_generation_tasks_user_update_policy.sql)
-- or touch reserve_generation_task. Production application requires
-- explicit approval after review/verification.

begin;

drop policy if exists "Users can insert own generation tasks"
on public.generation_tasks;

commit;

-- Expected effective behavior after application:
-- - authenticated users cannot directly insert generation_tasks rows.
-- - service-role/server-owned Seedance flows remain unaffected because
--   service_role bypasses RLS and reserve_generation_task remains
--   service-role-only.
-- - admins retain no direct insert path (none existed before this change).
--
-- Rollback (if unexpected breakage is observed after applying):
--   begin;
--   create policy "Users can insert own generation tasks"
--   on public.generation_tasks
--   for insert
--   with check (auth.uid() = user_id);
--   commit;
