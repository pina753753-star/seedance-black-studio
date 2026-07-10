-- Allow refund_generation_task_atomic to service OpenRouter tasks, not just fal.
--
-- Context: fal.ai has been discontinued. The atomic refund RPC added in
-- 20260629_add_atomic_fal_refund.sql hard-guards api_provider = 'fal' (step 3,
-- "defence in depth"). api/openrouter-reconcile.js needs to call this same RPC
-- to auto-refund stale/orphaned OpenRouter tasks, so the guard is relaxed to
-- accept both providers. No other logic in the function changes: the same
-- idempotent refund-ledger checks (unique index on
-- credit_transactions(related_task_id, reason, credit_type) WHERE
-- reason = 'generation_refund') continue to prevent double refunds regardless
-- of provider.
--
-- Rollback: re-apply 20260629_add_atomic_fal_refund.sql's CREATE OR REPLACE
-- FUNCTION body (restores the 'fal'-only guard).

CREATE OR REPLACE FUNCTION public.refund_generation_task_atomic(
  p_task_id        uuid,
  p_error_message  text DEFAULT 'generation failed'
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

  -- 3. Provider guard (defence in depth — caller already filters api_provider).
  --    fal.ai has been discontinued; OpenRouter is now also accepted so that
  --    api/openrouter-reconcile.js can use this same atomic RPC.
  IF v_api_provider NOT IN ('fal', 'openrouter') THEN
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

  -- 4b. Cancelled tasks: refund state is unknown and cannot be determined safely.
  --     A task is set to cancelled only when credit deduction fails
  --     (checkAndDeduct returns ok=false), at which point no credits were ever
  --     deducted and no refund is performed, and the provider is never called
  --     for a cancelled task. A refund attempt arriving for a cancelled task is
  --     therefore unexpected — it may indicate a data inconsistency, manual DB
  --     change, or other unknown state. Treating this as success (ok=true)
  --     could permanently skip a refund that was needed. Raise an exception so
  --     the transaction rolls back and the caller can retry, allowing a human
  --     to investigate.
  IF v_task_status = 'cancelled' THEN
    RAISE EXCEPTION 'cancelled_task_refund_state_unknown'
      USING ERRCODE = 'data_exception';
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
      RAISE EXCEPTION 'refund_state_inconsistent'
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

  -- 6. No charge found: still mark task failed; skip balance change.
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
  --    the caller as an error (HTTP 500), which triggers a caller-side retry. This is
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
    RAISE;
END;
$$;

-- Permissions unchanged (already granted to service_role only in the prior migration).
