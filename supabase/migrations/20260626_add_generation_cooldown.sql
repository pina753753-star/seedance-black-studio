-- Add post-generation cooldown (60 seconds) enforcement.
--
-- WHY finished_at instead of updated_at:
--   After status transitions to completed/failed/cancelled, additional columns
--   (output_url, watermarked_url, settings, etc.) may be updated, bumping
--   updated_at. Using updated_at as the cooldown start would silently extend
--   the cooldown window. finished_at is set once on the first terminal transition
--   and never overwritten by subsequent updates.
--
-- DO NOT run against production without explicit approval.
-- Run the read-only pre-check queries at the bottom first.
--
-- ============================================================
-- PRE-CHECK QUERIES (run read-only before executing this file)
-- ============================================================
--
-- 1. finished_at column existence:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public'
--      AND table_name = 'generation_tasks'
--      AND column_name = 'finished_at';
--    → If returns a row, column already exists — STOP and investigate before running.
--
-- 2. Trigger function existence:
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public'
--      AND routine_name = 'set_generation_task_finished_at';
--    → If returns a row, function already exists — STOP and investigate.
--
-- 3. Trigger existence:
--    SELECT trigger_name FROM information_schema.triggers
--    WHERE event_object_schema = 'public'
--      AND event_object_table = 'generation_tasks'
--      AND trigger_name = 'trg_generation_task_finished_at';
--    → If returns a row, trigger already exists — STOP and investigate.
--
-- 4. RPC function existence:
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public'
--      AND routine_name = 'reserve_generation_task';
--    → If returns a row, function already exists — STOP and investigate.
--
-- 5. Active duplicate check:
--    SELECT user_id, COUNT(*) FROM generation_tasks
--    WHERE status IN ('queued','processing') GROUP BY user_id HAVING COUNT(*) > 1;
--    → Should return 0 rows before running.
--
-- 6. Existing partial unique index:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'generation_tasks'
--      AND indexname = 'generation_tasks_one_active_per_user_idx';
--    → Must already exist (from previous migration).
--
-- 7. Current active task count:
--    SELECT status, COUNT(*) FROM generation_tasks
--    WHERE status IN ('queued','processing') GROUP BY status;
--
-- 8. Recent terminal tasks:
--    SELECT id, user_id, status, updated_at, created_at
--    FROM generation_tasks
--    WHERE status IN ('completed','failed','cancelled')
--    ORDER BY updated_at DESC LIMIT 20;
-- ============================================================

-- Step 1: Add finished_at column (nullable, not backfilled for existing rows)
ALTER TABLE public.generation_tasks
  ADD COLUMN finished_at timestamptz NULL;

-- Step 2: Trigger function — sets finished_at once on first terminal transition.
-- Handles: any → completed, any → failed, any → cancelled.
-- Does NOT set finished_at when:
--   - transitioning queued → processing
--   - re-entering the same terminal status (idempotent guard)
--   - any other update after terminal status (output_url, watermarked_url, etc.)
CREATE OR REPLACE FUNCTION public.set_generation_task_finished_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act on status column changes
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Only set finished_at on first transition INTO a terminal status
  IF NEW.status IN ('completed', 'failed', 'cancelled')
     AND OLD.status NOT IN ('completed', 'failed', 'cancelled')
     AND NEW.finished_at IS NULL
  THEN
    NEW.finished_at := NOW();
  END IF;

  RETURN NEW;
END;
$$;

-- Step 3: Attach trigger
DROP TRIGGER IF EXISTS trg_generation_task_finished_at ON public.generation_tasks;
CREATE TRIGGER trg_generation_task_finished_at
  BEFORE UPDATE ON public.generation_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.set_generation_task_finished_at();

-- Step 4: Atomic reservation RPC
-- Uses pg_try_advisory_xact_lock (transaction-scoped) keyed on user_id hash
-- to serialize concurrent requests for the same user within a transaction.
-- The partial unique index (generation_tasks_one_active_per_user_idx) remains
-- as a final defence against races outside this function.
--
-- Returns a single row with:
--   task_id             uuid    — set on success, NULL on rejection
--   rejection_reason    text    — 'active_generation' | 'cooldown_active' | NULL
--   retry_after_seconds integer — seconds remaining in cooldown (0 if not applicable)
CREATE OR REPLACE FUNCTION public.reserve_generation_task(
  p_user_id        uuid,
  p_mode           text,
  p_model          text,
  p_prompt         text,
  p_resolution     text,
  p_duration_secs  integer,
  p_aspect_ratio   text,
  p_credit_cost    integer
)
RETURNS TABLE (
  task_id             uuid,
  rejection_reason    text,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key      bigint;
  v_active_count  integer;
  v_finished_at   timestamptz;
  v_cooldown_secs integer;
  v_new_task_id   uuid;
BEGIN
  -- Derive a stable per-user lock key from the user_id UUID.
  -- hashtext() returns int4; cast to bigint for xact lock.
  v_lock_key := hashtext(p_user_id::text)::bigint;

  -- Acquire transaction-scoped advisory lock for this user.
  -- pg_try_advisory_xact_lock returns false if lock is already held by another
  -- transaction, meaning a concurrent request for the same user is in progress.
  IF NOT pg_try_advisory_xact_lock(v_lock_key) THEN
    RETURN QUERY SELECT NULL::uuid, 'active_generation'::text, 0::integer;
    RETURN;
  END IF;

  -- Check for existing active (queued/processing) tasks
  SELECT COUNT(*) INTO v_active_count
  FROM generation_tasks
  WHERE user_id = p_user_id
    AND status IN ('queued', 'processing');

  IF v_active_count > 0 THEN
    RETURN QUERY SELECT NULL::uuid, 'active_generation'::text, 0::integer;
    RETURN;
  END IF;

  -- Check cooldown: most recent finished_at within the last 60 seconds
  SELECT MAX(finished_at) INTO v_finished_at
  FROM generation_tasks
  WHERE user_id = p_user_id
    AND finished_at IS NOT NULL;

  IF v_finished_at IS NOT NULL AND v_finished_at + INTERVAL '60 seconds' > NOW() THEN
    -- Ceiling integer seconds remaining (minimum 1, maximum 60)
    v_cooldown_secs := GREATEST(1, LEAST(60,
      CEIL(EXTRACT(EPOCH FROM (v_finished_at + INTERVAL '60 seconds' - NOW())))::integer
    ));
    RETURN QUERY SELECT NULL::uuid, 'cooldown_active'::text, v_cooldown_secs;
    RETURN;
  END IF;

  -- All checks passed: insert the task with status 'queued'
  INSERT INTO generation_tasks (
    user_id,
    mode,
    model,
    prompt,
    resolution,
    duration_seconds,
    aspect_ratio,
    credit_cost,
    status
  ) VALUES (
    p_user_id,
    p_mode,
    p_model,
    p_prompt,
    p_resolution,
    p_duration_secs,
    p_aspect_ratio,
    p_credit_cost,
    'queued'
  )
  RETURNING id INTO v_new_task_id;

  RETURN QUERY SELECT v_new_task_id, NULL::text, 0::integer;
END;
$$;

-- Step 5: Lock down execution permissions
-- REVOKE from PUBLIC first, then grant only service_role
REVOKE ALL ON FUNCTION public.reserve_generation_task(uuid, text, text, text, text, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_generation_task(uuid, text, text, text, text, integer, text, integer) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_generation_task(uuid, text, text, text, text, integer, text, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_generation_task(uuid, text, text, text, text, integer, text, integer) TO service_role;

-- Trigger function permissions (SECURITY DEFINER, no direct user grant needed)
REVOKE ALL ON FUNCTION public.set_generation_task_finished_at() FROM PUBLIC;
