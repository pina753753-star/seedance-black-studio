-- Prevent concurrent video generations per user.
-- Confirmed active statuses from code: 'queued' (set at INSERT) and 'processing' (set after OpenRouter call).
-- These are the only statuses that represent an in-progress generation.
-- Completed/failed/cancelled tasks are NOT affected by this index.
-- Do not run automatically against production without explicit approval.
--
-- Before running, verify with the read-only check queries below:
--   1. SELECT status, COUNT(*) FROM generation_tasks GROUP BY status ORDER BY status;
--   2. SELECT user_id, COUNT(*) FROM generation_tasks WHERE status IN ('queued','processing') GROUP BY user_id HAVING COUNT(*) > 1;
--   3. SELECT id, user_id, status, created_at FROM generation_tasks WHERE status IN ('queued','processing') AND created_at < NOW() - INTERVAL '1 hour' ORDER BY created_at;
--   4. SELECT indexname FROM pg_indexes WHERE tablename = 'generation_tasks' AND indexname = 'generation_tasks_one_active_per_user_idx';
-- If query 2 returns any rows, resolve duplicate active tasks before running this migration.

CREATE UNIQUE INDEX generation_tasks_one_active_per_user_idx
ON public.generation_tasks (user_id)
WHERE status IN ('queued', 'processing');
