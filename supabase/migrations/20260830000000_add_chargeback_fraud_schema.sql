-- Chargeback / fraud countermeasure — Step 1: schema only.
--
-- This migration adds the data model needed for a future chargeback /
-- fraud-hold feature. It does NOT add any webhook or generation-blocking
-- logic — that is intentionally deferred to a later step. Nothing here
-- changes existing behavior: account_status defaults to 'active' and is not
-- read anywhere yet, and the two new tables are not referenced by any
-- existing code path.
--
-- 1. profiles.account_status — lets a later step mark a user as under
--    review (risk_hold) or frozen (frozen) without deleting/altering any
--    existing profiles column.
-- 2. public.stripe_payment_ledger — one ledger row per logical Stripe payment / credit grant,
--    linking checkout/payment/invoice/charge/customer/subscription IDs back
--    to a user, so a later step can look up "which user does this Stripe
--    event belong to" and "was this credit grant already processed". The
--    per-object-id columns carry a UNIQUE partial index (NULLs allowed) so
--    a later webhook handler can safely no-op on Stripe's at-least-once
--    redelivery instead of inserting duplicate ledger rows.
-- 3. public.payment_risk_events — records disputes / early fraud warnings /
--    reviews from Stripe. Service-role only (no anon/authenticated access
--    at all, enforced by both RLS policies and REVOKE/GRANT), since this is
--    internal fraud-signal data. stripe_event_id is UNIQUE so a later
--    webhook handler can safely upsert/ignore on Stripe's at-least-once
--    redelivery.
--
-- Statements are guarded (IF NOT EXISTS / DROP POLICY IF EXISTS) so this
-- migration is safe to re-run.

begin;

-- ────────────────────────────────────────────────────────────────
-- 1. profiles.account_status
-- ────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists account_status text not null default 'active'
    constraint profiles_account_status_check
      check (account_status in ('active', 'risk_hold', 'frozen'));

comment on column public.profiles.account_status is
  'Chargeback/fraud countermeasure status. active = normal, risk_hold = under review, frozen = generation/credit use blocked. Not yet enforced by any application code (schema-only step).';

-- ────────────────────────────────────────────────────────────────
-- 2. public.stripe_payment_ledger
-- ────────────────────────────────────────────────────────────────
create table if not exists public.stripe_payment_ledger (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  user_id uuid references public.profiles(id) on delete set null,

  checkout_session_id text,
  payment_intent_id text,
  invoice_id text,
  charge_id text,
  customer_id text,
  subscription_id text,

  purchase_type text not null
    constraint stripe_payment_ledger_purchase_type_check
      check (purchase_type in ('subscription', 'credit_pack', 'other')),

  amount bigint
    constraint stripe_payment_ledger_amount_check
      check (amount >= 0),
  currency text
    constraint stripe_payment_ledger_currency_check
      check (currency ~ '^[a-zA-Z]{3}$'),

  credits_granted integer
    constraint stripe_payment_ledger_credits_granted_check
      check (credits_granted >= 0),

  grant_status text not null default 'pending'
    constraint stripe_payment_ledger_grant_status_check
      check (grant_status in ('pending', 'granted', 'held', 'reversed')),

  stripe_event_id text
);

create index if not exists stripe_payment_ledger_user_id_idx
  on public.stripe_payment_ledger (user_id);
create index if not exists stripe_payment_ledger_customer_id_idx
  on public.stripe_payment_ledger (customer_id);
create index if not exists stripe_payment_ledger_subscription_id_idx
  on public.stripe_payment_ledger (subscription_id);

-- Unique partial indexes (NULLs allowed) double as both the lookup index
-- and the webhook-redelivery dedup guard, so no separate plain index is
-- needed for these columns (invoice_id included).
create unique index if not exists stripe_payment_ledger_checkout_session_id_uidx
  on public.stripe_payment_ledger (checkout_session_id)
  where checkout_session_id is not null;
create unique index if not exists stripe_payment_ledger_payment_intent_id_uidx
  on public.stripe_payment_ledger (payment_intent_id)
  where payment_intent_id is not null;
create unique index if not exists stripe_payment_ledger_invoice_id_uidx
  on public.stripe_payment_ledger (invoice_id)
  where invoice_id is not null;
create unique index if not exists stripe_payment_ledger_charge_id_uidx
  on public.stripe_payment_ledger (charge_id)
  where charge_id is not null;
create unique index if not exists stripe_payment_ledger_stripe_event_id_uidx
  on public.stripe_payment_ledger (stripe_event_id)
  where stripe_event_id is not null;

comment on table public.stripe_payment_ledger is
  'Ledger linking Stripe payment objects (checkout session / payment intent / invoice / charge / customer / subscription) to a user. Populated by a future webhook step; schema-only for now.';

comment on column public.stripe_payment_ledger.stripe_event_id is
  'Canonical Stripe event that created this payment/grant ledger row. Must not be overwritten by later events for the same logical payment.';

alter table public.stripe_payment_ledger enable row level security;

-- Table-level privileges: revoke everything first, then grant back only
-- what each role should have. authenticated gets SELECT only (row access
-- is further restricted by the RLS policy below); anon gets nothing;
-- service_role (used by trusted server-side webhook code, which also
-- bypasses RLS) gets full read/write.
revoke all on public.stripe_payment_ledger from public, anon, authenticated, service_role;
grant select on public.stripe_payment_ledger to authenticated;
grant select, insert, update, delete on public.stripe_payment_ledger to service_role;

-- Users may read only their own ledger rows. All writes are performed by
-- trusted server-side code using the service role key, which bypasses RLS,
-- so no INSERT/UPDATE/DELETE policy is defined for authenticated/anon.
drop policy if exists "Users can read own payment ledger rows" on public.stripe_payment_ledger;
create policy "Users can read own payment ledger rows"
  on public.stripe_payment_ledger
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ────────────────────────────────────────────────────────────────
-- 3. public.payment_risk_events
-- ────────────────────────────────────────────────────────────────
create table if not exists public.payment_risk_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  stripe_event_id text not null,

  -- Stripe event type (e.g. 'charge.dispute.created') and the Stripe object
  -- ID the event is about (e.g. dispute 'dp_xxx', review 'prv_xxx', early
  -- fraud warning 'issfr_xxx'), distinct from stripe_event_id (the
  -- Event object's own ID, used for redelivery dedup).
  stripe_event_type text not null,
  stripe_object_id text not null,

  user_id uuid references public.profiles(id) on delete set null,

  event_type text not null
    constraint payment_risk_events_event_type_check
      check (event_type in ('dispute', 'early_fraud_warning', 'review')),

  status text not null default 'open'
    constraint payment_risk_events_status_check
      check (status in ('open', 'reviewing', 'resolved', 'ignored')),

  frozen_at timestamptz,
  resolved_at timestamptz,

  -- Minimal identifying info only (e.g. charge_id, reason) — no card data.
  charge_id text,
  reason text,

  constraint payment_risk_events_stripe_event_id_key unique (stripe_event_id)
);

create index if not exists payment_risk_events_user_id_idx
  on public.payment_risk_events (user_id);
create index if not exists payment_risk_events_status_idx
  on public.payment_risk_events (status);
create index if not exists payment_risk_events_stripe_object_id_idx
  on public.payment_risk_events (stripe_object_id);
create index if not exists payment_risk_events_charge_id_idx
  on public.payment_risk_events (charge_id);

comment on table public.payment_risk_events is
  'Internal, service-role-only record of Stripe dispute/early_fraud_warning/review events. stripe_event_id is UNIQUE so a future webhook handler can safely no-op on Stripe redelivery. No application logic reads/writes this table yet (schema-only step).';

alter table public.payment_risk_events enable row level security;

-- Table-level privileges: revoke everything first, then grant full access
-- to service_role only. public/anon/authenticated get nothing at the grant
-- level, in addition to RLS being enabled with zero anon/authenticated
-- policies below (belt and suspenders).
revoke all on public.payment_risk_events from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.payment_risk_events to service_role;

-- No policies are created for anon/authenticated: RLS is enabled with zero
-- policies, so all access from those roles is denied by default. Only the
-- service role (which bypasses RLS entirely) can read or write this table.

commit;
