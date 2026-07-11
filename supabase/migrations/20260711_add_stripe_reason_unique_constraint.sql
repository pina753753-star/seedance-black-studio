-- Enforce idempotency of Stripe-sourced credit grants at the DB level.
--
-- Context: api/stripe-webhook.js's grantCredits() previously relied only on a
-- SELECT-then-act check (alreadyProcessed()) to avoid granting credits twice
-- for the same Stripe event (session/invoice id embedded in
-- credit_transactions.reason as 'stripe:<kind>:<stripeId>'). That check is not
-- atomic: two near-simultaneous deliveries of the same webhook event could
-- both pass the SELECT before either INSERT commits, resulting in a double
-- grant. This migration adds a DB-level guard so a second concurrent INSERT
-- with the same reason is rejected outright.
--
-- Scope: only rows whose reason starts with 'stripe:' are covered. Other
-- reasons (video_generation, generation_refund) are charge/refund per-task
-- rows that are expected to repeat across different tasks and are already
-- covered by their own idempotency mechanisms
-- (credit_transactions_generation_refund_unique from
-- 20260629_add_atomic_fal_refund.sql).
--
-- Paired code change: api/stripe-webhook.js's grantCredits() now inserts the
-- credit_transactions row BEFORE updating credit_balances, and treats a
-- unique_violation (Postgres error code 23505) on this index as an idempotent
-- "already granted" outcome rather than an error.

CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_stripe_reason_unique
  ON public.credit_transactions (reason)
  WHERE reason LIKE 'stripe:%';
