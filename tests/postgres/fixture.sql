\set ON_ERROR_STOP on
-- ISOLATED, DISPOSABLE POSTGRES TEST FIXTURE ONLY.
-- This file is not a product migration and must never target a live database.
-- Run with psql -f so \ir resolves relative to this file. No real identities,
-- credentials, Stripe objects, network calls or application secrets are used.
-- Business functions below are loaded verbatim from this repository.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

-- Minimal local substitute for Supabase Auth's schema, used only by FK/RLS DDL.
-- No signup/auth business logic is mocked or called in these accounting tests.
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Exact repository base table DDL (also creates two unused assets/gallery tables).
-- Preserves nonnegative balance checks, pool/status checks, UUID defaults and FKs.
\ir ../../supabase/setup-01-tables.sql

-- Only evolved columns consumed by the accounting functions under test.
-- Expiry columns mirror 20260701_add_annual_subscriptions.sql without bringing
-- unrelated subscription/Cron schemas into this minimal test database.
alter table public.credit_balances
  add column subscription_expires_at timestamptz,
  add column purchased_expires_at timestamptz;
alter table public.generation_tasks
  add column settings jsonb not null default '{}'::jsonb,
  add column watermarked_url text;

-- Real active-task constraint and real terminal timestamp trigger/cooldown RPC.
\ir ../../supabase/migrations/20260626_add_single_active_generation_guard.sql
\ir ../../supabase/migrations/20260626050315_add_generation_cooldown.sql

-- Real refund unique index, original function permissions, then current provider
-- support. The newest migration replaces the function, not its privileges.
\ir ../../supabase/migrations/20260629_add_atomic_fal_refund.sql
\ir ../../supabase/migrations/20260821000000_allow_wavespeed_atomic_refund.sql

-- Real Stripe duplicate-grant index and current atomic grant implementation.
\ir ../../supabase/migrations/20260711_add_stripe_reason_unique_constraint.sql
\ir ../../supabase/migrations/20260803070000_allow_scale_in_atomic_stripe_credit_grant.sql

-- Real reservation/debit functions (same task/owner/price/replay checks).
\ir ../../supabase/migrations/20260803081000_add_atomic_generation_credit_deduction.sql

-- Real ledger/risk schema, constraints, indexes, RLS and server-only access.
\ir ../../supabase/migrations/20260830000000_add_chargeback_fraud_schema.sql
\ir ../../supabase/migrations/20260908064319_stripe_payment_ledger_atomic_transitions.sql
\ir ../../supabase/migrations/20260908070000_fix_payment_risk_ledger_lock_order.sql

-- Server role's base-table access is needed by SECURITY INVOKER risk/ledger RPCs.
-- Do not grant accounting table writes to anon/authenticated in this fixture.
grant select, insert, update, delete on public.profiles, public.credit_balances,
  public.credit_transactions, public.generation_tasks to service_role;
alter table public.profiles enable row level security;
alter table public.credit_balances enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.generation_tasks enable row level security;

-- Stop at the repository baseline. The runtime runner first records baseline
-- behavior, then applies docs/sql/basic-credit-access-atomic.sql explicitly
-- and compares candidate results. Do not include the candidate here.
