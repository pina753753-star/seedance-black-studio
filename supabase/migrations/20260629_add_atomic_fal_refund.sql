-- Make fal generation refunds atomic.
--
-- Problem: the JS-side refund in api/fal-webhook.js performs three independent
-- DB requests (balance UPDATE → ledger INSERT → task UPDATE). If any step fails
-- after the balance has already been incremented, a webhook retry causes a
-- second balance increment (double refund). Concurrent webhook deliveries race
-- on the balance read-modify-write window and can also double-refund.
--
-- Solution: move the entire refund into a single PostgreSQL transaction via
-- the RPC public.refund_generation_task_atomic. The function:
--   1. Locks generation_tasks row (FOR UPDATE) — serialises concurrent calls
--   2. Locks credit_balances row (FOR UPDATE) — serialises balance updates
--   3. Inserts refund ledger rows
--   4. Updates credit balance
--   5. Marks task failed (finished_at is set by the existing trigger)
--
-- If any step raises an exception the whole transaction rolls back automatically.
-- A unique partial index on credit_transactions prevents duplicate refund ledger
-- rows as a belt-and-suspenders guard.
--
-- DO NOT run against production without explicit approval.
--
-- ============================================================
-- PRE-CHECK QUERIES (run read-only before executing this file)
-- ============================================================
--
-- 1. Duplicate refund ledger rows (must return 0 rows before adding unique index):
--    SELECT related_task_id, credit_type, COUNT(*)
--    FROM public.credit_transactions
--    WHERE reason = 'generation_refund'
--    GROUP BY related_task_id, credit_type
--    HAVING COUNT(*) > 1;
--    → Must return 0 rows. If any rows exist, investigate and resolve manually
--      before running this migration. Do NOT auto-delete or auto-merge them.
--
-- 2. Existing index name conflict:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'credit_transactions'
--      AND indexname = 'credit_transactions_generation_refund_unique';
--    → Must return 0 rows. Stop if a row is returned.
--
-- 3. Existing function name conflict:
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public'
--      AND routine_name = 'refund_generation_task_atomic';
--    → Must return 0 rows. Stop if a row is returned.
--
-- 4. credit_transactions schema confirmation:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'credit_transactions'
--    ORDER BY ordinal_position;
--    → Confirm: id, user_id, amount (integer), credit_type, reason,
--      related_task_id (uuid, nullable), created_at.
--
-- 5. generation_tasks schema confirmation:
--    SELECT column_name, data_type, is_nullable
--    FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'generation_tasks'
--    ORDER BY ordinal_position;
--    → Confirm: id, user_id, status, api_provider, error_message,
--      finished_at (nullable timestamptz), updated_at all exist.
--
-- 6. Trigger existence (finished_at is managed by this trigger):
--    SELECT trigger_name FROM information_schema.triggers
--    WHERE event_object_schema = 'public'
--      AND event_object_table = 'generation_tasks'
--      AND trigger_name = 'trg_generation_task_finished_at';
--    → Must return 1 row. If missing, finished_at will not be set automatically.
--
-- 7. Partial refund state check (must return 0 rows before applying idempotency fix):
--    WITH charges AS (
--      SELECT related_task_id,
--        SUM(CASE WHEN credit_type='subscription' THEN ABS(amount) ELSE 0 END) AS exp_sub,
--        SUM(CASE WHEN credit_type='free'         THEN ABS(amount) ELSE 0 END) AS exp_free,
--        SUM(CASE WHEN credit_type='purchased'    THEN ABS(amount) ELSE 0 END) AS exp_purch
--      FROM public.credit_transactions
--      WHERE reason='video_generation' AND amount < 0
--      GROUP BY related_task_id
--    ),
--    refunds AS (
--      SELECT related_task_id,
--        SUM(CASE WHEN credit_type='subscription' THEN amount ELSE 0 END) AS act_sub,
--        SUM(CASE WHEN credit_type='free'         THEN amount ELSE 0 END) AS act_free,
--        SUM(CASE WHEN credit_type='purchased'    THEN amount ELSE 0 END) AS act_purch
--      FROM public.credit_transactions
--      WHERE reason='generation_refund' AND amount > 0
--      GROUP BY related_task_id
--    )
--    SELECT c.related_task_id
--    FROM charges c
--    JOIN refunds r ON r.related_task_id = c.related_task_id
--    WHERE c.exp_sub <> r.act_sub
--       OR c.exp_free <> r.act_free
--       OR c.exp_purch <> r.act_purch;
--    → Must return 0 rows. If any rows exist, investigate partial refund state
--      before running this migration.
-- ============================================================

-- Step 1: Partial unique index — one refund ledger row per task per credit pool.
-- Uses (related_task_id, reason, credit_type) not (related_task_id, reason)
-- because a single task refund can produce up to 3 rows (subscription/free/purchased).
CREATE UNIQUE INDEX credit_transactions_generation_refund_unique
  ON public.credit_transactions (related_task_id, reason, credit_type)
  WHERE reason = 'generation_refund';

-- Step 2: Atomic refund RPC.
CREATE OR REPLACE FUNCTION public.refund_generation_task_atomic(
  p_task_id        uuid,
  p_error_message  text DEFAULT 'fal generation failed'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_task_id      uuid;
  v_user_id      uuid;
  v_task_status  text;
  v_api_provider text;
  v_from_sub     integer := 0;
  v_from_free    integer := 0;
  v_from_purch   integer := 0;
  v_ref_sub      integer := 0;
  v_ref_free     integer := 0;
  v_ref_purch    integer := 0;
  v_has_refunds  boolean := false;
  v_bal_user_id  uuid;
  v_tx           record;
BEGIN
  -- 1. Lock task row to serialise concurrent refund attempts for this task.
  SELECT id, user_id, status, api_provider
    INTO v_task_id, v_user_id, v_task_status, v_api_provider
    FROM public.generation_tasks
   WHERE id = p_task_id
     FOR UPDATE;

  -- 2. Task must exist.
  IF v_task_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'task_not_found');
  END IF;

  -- 3. Provider guard (defence in depth — caller already filters api_provider='fal').
  IF v_api_provider IS DISTINCT FROM 'fal' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'wrong_provider');
  END IF;

  -- 4a. Do not refund already-completed tasks.
  IF v_task_status = 'completed' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'refunded', false,
      'already_refunded', false,
      'task_status', 'completed',
      'code', 'already_completed'
    );
  END IF;

  -- 4b. Cancelled tasks were already refunded by fal-start.js before fal was
  --     invoked (releaseTask → status='cancelled', then refundCredits with
  --     reason='generation_refund'). If fal was already running, cancellation
  --     is not allowed, so a fal ERROR webhook for a cancelled task means the
  --     fal-start.js refund has already been applied.
  IF v_task_status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'ok', true,
      'refunded', false,
      'already_refunded', false,
      'task_status', 'cancelled',
      'code', 'already_cancelled'
    );
  END IF;

  -- 5. Pool-level idempotency: compare expected refunds (from charge ledger) with
  --    actual refunds already recorded. A non-zero refund ledger count that does
  --    NOT match the charge amounts exactly indicates partial/corrupt state —
  --    raise an exception rather than silently returning already_refunded.

  -- Collect expected amounts from original charge ledger.
  FOR v_tx IN
    SELECT credit_type, ABS(amount) AS abs_amount
      FROM public.credit_transactions
     WHERE related_task_id = p_task_id
       AND reason          = 'video_generation'
       AND amount          < 0
  LOOP
    IF v_tx.credit_type = 'subscription' THEN
      v_from_sub   := v_from_sub   + v_tx.abs_amount;
    ELSIF v_tx.credit_type = 'free' THEN
      v_from_free  := v_from_free  + v_tx.abs_amount;
    ELSIF v_tx.credit_type = 'purchased' THEN
      v_from_purch := v_from_purch + v_tx.abs_amount;
    ELSE
      -- Unexpected credit_type in charge ledger — reject to prevent silent data loss.
      RAISE EXCEPTION 'invalid_credit_type in video_generation ledger: %', v_tx.credit_type
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- Collect amounts already refunded.
  SELECT
    COUNT(*) > 0,
    COALESCE(SUM(CASE WHEN credit_type = 'subscription' THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN credit_type = 'free'         THEN amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN credit_type = 'purchased'    THEN amount ELSE 0 END), 0)
  INTO v_has_refunds, v_ref_sub, v_ref_free, v_ref_purch
  FROM public.credit_transactions
  WHERE related_task_id = p_task_id
    AND reason          = 'generation_refund'
    AND amount          > 0;

  IF v_has_refunds THEN
    -- Verify pool-level completeness. Mismatch = partial/corrupt state; raise
    -- rather than silently accept — lets the caller retry and surface the issue.
    IF v_ref_sub <> v_from_sub OR v_ref_free <> v_from_free OR v_ref_purch <> v_from_purch THEN
      RAISE EXCEPTION
        'refund_state_inconsistent: task=% exp(sub=%,free=%,purch=%) act(sub=%,free=%,purch=%)',
        p_task_id, v_from_sub, v_from_free, v_from_purch,
        v_ref_sub, v_ref_free, v_ref_purch
        USING ERRCODE = 'data_exception';
    END IF;

    -- Refund ledger matches charges exactly: idempotent already_refunded.
    -- Ensure task reaches failed status (guards against partial prior failure).
    UPDATE public.generation_tasks
       SET status        = 'failed',
           error_message = COALESCE(error_message, p_error_message),
           updated_at    = now()
     WHERE id     = p_task_id
       AND status NOT IN ('completed', 'failed', 'cancelled');
    RETURN jsonb_build_object(
      'ok', true,
      'refunded', false,
      'already_refunded', true,
      'task_status', 'failed',
      'code', 'already_refunded'
    );
  END IF;

  -- 6. No charge found: fal ERROR is real, so still mark task failed; skip balance change.
  IF v_from_sub = 0 AND v_from_free = 0 AND v_from_purch = 0 THEN
    UPDATE public.generation_tasks
       SET status        = 'failed',
           error_message = p_error_message,
           updated_at    = now()
     WHERE id     = p_task_id
       AND status NOT IN ('completed', 'failed', 'cancelled');
    RETURN jsonb_build_object(
      'ok', true,
      'refunded', false,
      'already_refunded', false,
      'task_status', 'failed',
      'code', 'no_charge_found'
    );
  END IF;

  -- 7. Lock balance row to serialise balance updates for this user.
  SELECT user_id INTO v_bal_user_id
    FROM public.credit_balances
   WHERE user_id = v_user_id
     FOR UPDATE;

  IF v_bal_user_id IS NULL THEN
    -- No balance row — cannot safely refund; roll back.
    RAISE EXCEPTION 'balance_not_found for user_id %', v_user_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- 8. Insert pool-specific refund ledger rows.
  --    Partial unique index (credit_transactions_generation_refund_unique) on
  --    (related_task_id, reason, credit_type) prevents duplicate rows under concurrency.
  --    NOTE: unique_violation from this index is NOT caught here — it propagates to
  --    the caller as an error (HTTP 500), which triggers fal webhook retry. This is
  --    correct: a concurrent insertion that races past step 5 means we should retry
  --    rather than silently report success on a potentially rolled-back refund.
  IF v_from_sub > 0 THEN
    INSERT INTO public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    VALUES (v_user_id, v_from_sub, 'subscription', 'generation_refund', p_task_id);
  END IF;
  IF v_from_free > 0 THEN
    INSERT INTO public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    VALUES (v_user_id, v_from_free, 'free', 'generation_refund', p_task_id);
  END IF;
  IF v_from_purch > 0 THEN
    INSERT INTO public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    VALUES (v_user_id, v_from_purch, 'purchased', 'generation_refund', p_task_id);
  END IF;

  -- 9. Update balance (balance row lock from step 7 is still held).
  UPDATE public.credit_balances
     SET subscription_credits = subscription_credits + v_from_sub,
         free_credits          = free_credits          + v_from_free,
         purchased_credits     = purchased_credits     + v_from_purch,
         updated_at            = now()
   WHERE user_id = v_user_id;

  -- 10. Mark task failed.
  --     The existing trigger trg_generation_task_finished_at sets finished_at
  --     automatically on the first status transition to a terminal state.
  UPDATE public.generation_tasks
     SET status        = 'failed',
         error_message = p_error_message,
         updated_at    = now()
   WHERE id     = p_task_id
     AND status NOT IN ('completed', 'failed', 'cancelled');

  RETURN jsonb_build_object(
    'ok', true,
    'refunded', true,
    'already_refunded', false,
    'task_status', 'failed',
    'code', 'refunded'
  );

EXCEPTION
  WHEN OTHERS THEN
    -- Re-raise any exception to trigger full transaction rollback.
    -- This includes unique_violation from the refund ledger inserts (step 8):
    -- a race that slips past the idempotency check (step 5) will surface as
    -- an error (HTTP 500) rather than a silent success, allowing fal to retry.
    RAISE;
END;
$$;

-- Step 3: Lock down execution permissions.
REVOKE ALL ON FUNCTION public.refund_generation_task_atomic(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refund_generation_task_atomic(uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.refund_generation_task_atomic(uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refund_generation_task_atomic(uuid, text) TO service_role;
