-- FlowVid Studio migration: fix annual credit grant date handling
--
-- Context: 20260701_add_annual_subscriptions.sql (already applied to the
-- pr37-annual-preview Supabase branch) defined grant_annual_subscription_credits
-- with 3 arguments and computed credit expiry as a fixed "end of the month
-- after grant_period" (up to ~2 months of validity depending on when in the
-- month the grant fires). That file must not be edited after being applied
-- (it would desync Supabase's migration history from the already-applied
-- Preview DB state). This migration instead replaces the RPC in place with
-- a 4-argument version that:
--   - accepts p_expires_at from the caller (api/cron-annual-credit-grant.js
--     now computes "grant due date + 1 calendar month, clamped to month-end"
--     instead of a fixed end-of-month), matching the product spec: credits
--     expire exactly 1 month after being granted.
--   - drops the old 3-argument overload so no stale function remains callable.
--
-- DO NOT apply to production without explicit human approval.

-- Drop the old 3-argument overload from 20260701_add_annual_subscriptions.sql.
-- Safe to run even if it was already replaced/removed.
DROP FUNCTION IF EXISTS public.grant_annual_subscription_credits(text, date, timestamptz);

-- Recreate with the 4th parameter (p_expires_at). Body is identical to the
-- original except: no internal expires_at calculation, uses p_expires_at
-- directly (passed in by the caller).
CREATE OR REPLACE FUNCTION public.grant_annual_subscription_credits(
  p_subscription_id text,
  p_grant_period     date,        -- YYYY-MM-01 of the month to grant
  p_next_grant_at    timestamptz, -- next_credit_grant_at after this grant
  p_expires_at       timestamptz  -- when these credits expire (caller computes:
                                  -- the actual grant due date + 1 month, clamped)
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sub    public.user_subscriptions%ROWTYPE;
  v_exists boolean;
  v_credits integer;
  v_reason text;
BEGIN
  -- Argument validation
  IF p_subscription_id IS NULL OR p_subscription_id = '' THEN
    RETURN 'invalid';
  END IF;
  IF p_grant_period IS NULL THEN
    RETURN 'invalid';
  END IF;
  IF p_expires_at IS NULL THEN
    RETURN 'invalid';
  END IF;

  -- Lock the subscription row
  SELECT * INTO v_sub
  FROM public.user_subscriptions
  WHERE stripe_subscription_id = p_subscription_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'invalid';
  END IF;

  -- Only grant for active annual subscriptions
  IF v_sub.billing_interval <> 'year' THEN
    RETURN 'invalid';
  END IF;
  IF v_sub.status NOT IN ('active','past_due') THEN
    RETURN 'invalid';
  END IF;
  -- cancel_at_period_end: still grant until period ends
  IF v_sub.cancel_at_period_end AND v_sub.current_period_end IS NOT NULL
     AND now() >= v_sub.current_period_end THEN
    RETURN 'invalid';
  END IF;

  v_credits := v_sub.monthly_credits;
  IF v_credits <= 0 THEN
    RETURN 'invalid';
  END IF;

  -- Idempotency: check grant_log
  SELECT EXISTS (
    SELECT 1 FROM public.annual_credit_grant_log
    WHERE stripe_subscription_id = p_subscription_id
      AND grant_period = p_grant_period
  ) INTO v_exists;

  IF v_exists THEN
    RETURN 'duplicate';
  END IF;

  -- Expiry is passed in by the caller: the actual grant due date + 1 month,
  -- clamped to month-end when the day doesn't exist there. Not a fixed
  -- "end of month after grant_period" — that would give up to ~2 months
  -- of validity depending on where in the month the grant fires.

  -- Lock and update credit_balances (atomic add, no read-modify-write in JS)
  INSERT INTO public.credit_balances (user_id, free_credits, subscription_credits, purchased_credits, subscription_expires_at)
  VALUES (v_sub.user_id, 0, v_credits, 0, p_expires_at)
  ON CONFLICT (user_id) DO UPDATE
    SET subscription_credits   = public.credit_balances.subscription_credits + v_credits,
        subscription_expires_at = GREATEST(public.credit_balances.subscription_expires_at, p_expires_at),
        updated_at             = now();

  -- Record credit transaction
  v_reason := 'annual_grant:' || p_subscription_id || ':' || p_grant_period::text;
  INSERT INTO public.credit_transactions (user_id, amount, credit_type, reason)
  VALUES (v_sub.user_id, v_credits, 'subscription', v_reason);

  -- Record grant log (unique constraint prevents duplicate)
  INSERT INTO public.annual_credit_grant_log
    (stripe_subscription_id, user_id, grant_period, credits, expires_at)
  VALUES
    (p_subscription_id, v_sub.user_id, p_grant_period, v_credits, p_expires_at);

  -- Advance next_credit_grant_at
  UPDATE public.user_subscriptions
  SET next_credit_grant_at = p_next_grant_at,
      updated_at           = now()
  WHERE stripe_subscription_id = p_subscription_id;

  RETURN 'granted';
END;
$$;

-- Revoke public execute; only service_role may call
REVOKE ALL ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_annual_subscription_credits(text, date, timestamptz, timestamptz) TO service_role;
