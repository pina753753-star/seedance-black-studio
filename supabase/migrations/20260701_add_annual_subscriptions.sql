-- FlowVid Studio migration: annual subscription support
--
-- Adds:
--   1. subscription_expires_at / purchased_expires_at columns to credit_balances
--      (safe no-op if already present; these columns are referenced in existing
--       stripe-webhook.js but were not captured in the initial schema.sql)
--   2. user_subscriptions table — tracks Stripe subscription lifecycle and
--      monthly credit grant schedule for annual billing
--   3. annual_credit_grant_log table — idempotent per-month grant ledger
--   4. RPC grant_annual_subscription_credits — atomic monthly credit grant
--
-- DO NOT apply to production without explicit human approval.
--
-- Pre-checks (run read-only before applying):
--   -- 1. Confirm credit_balances columns (may already exist)
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'credit_balances'
--   ORDER BY ordinal_position;
--
--   -- 2. Confirm no conflicting tables
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('user_subscriptions','annual_credit_grant_log');
--   -> Must return 0 rows.
--
--   -- 3. Confirm no conflicting function
--   SELECT routine_name FROM information_schema.routines
--   WHERE routine_schema = 'public'
--     AND routine_name = 'grant_annual_subscription_credits';
--   -> Must return 0 rows.

-- ────────────────────────────────────────────────────────────────
-- 1. Add expires columns to credit_balances (idempotent)
-- ────────────────────────────────────────────────────────────────
ALTER TABLE public.credit_balances
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS purchased_expires_at    timestamptz;

-- ────────────────────────────────────────────────────────────────
-- 2. user_subscriptions — Stripe subscription state cache
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_subscriptions (
  stripe_subscription_id text PRIMARY KEY,
  user_id                uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  stripe_customer_id     text,
  plan                   text NOT NULL CHECK (plan IN ('standard','premium','ultimate','team')),
  billing_interval       text NOT NULL CHECK (billing_interval IN ('month','year')),
  monthly_credits        integer NOT NULL CHECK (monthly_credits > 0),
  status                 text NOT NULL DEFAULT 'active',
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  billing_cycle_anchor   timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  next_credit_grant_at   timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;

-- Service role only: no user-facing RLS policy needed
-- (all access via service role in API / Cron)

-- ────────────────────────────────────────────────────────────────
-- 3. annual_credit_grant_log — one row per subscription per month
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.annual_credit_grant_log (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_subscription_id text NOT NULL REFERENCES public.user_subscriptions(stripe_subscription_id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  grant_period           date NOT NULL,   -- first day of the calendar month granted (YYYY-MM-01)
  credits                integer NOT NULL CHECK (credits > 0),
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_id, grant_period)
);

ALTER TABLE public.annual_credit_grant_log ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX IF NOT EXISTS user_subscriptions_user_id_idx
  ON public.user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS user_subscriptions_next_grant_idx
  ON public.user_subscriptions(next_credit_grant_at)
  WHERE billing_interval = 'year' AND status = 'active';

-- ────────────────────────────────────────────────────────────────
-- 4. RPC: grant_annual_subscription_credits
--
-- Atomically grants one month of credits to an annual subscriber.
-- Called by the Cron API. All DB writes happen in a single transaction.
-- Returns: 'granted' | 'duplicate' | 'invalid'
-- ────────────────────────────────────────────────────────────────
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
