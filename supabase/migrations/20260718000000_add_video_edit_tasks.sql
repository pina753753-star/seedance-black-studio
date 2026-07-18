-- Video editing feature, stage 1 (trim + cut concatenation).
--
-- Adds:
--   1. public.video_edit_tasks — one row per edit request, async task/status
--      pattern mirroring public.generation_tasks (reserve -> queued ->
--      processing -> completed/failed).
--   2. public.reserve_video_edit_task(...) — atomic reservation + credit
--      deduction RPC, service_role only. Mirrors
--      public.reserve_generation_task's advisory-lock + INSERT pattern
--      (see 20260626050315_add_generation_cooldown.sql) but additionally
--      performs the credit-balance read/deduct step (checkAndDeduct in
--      api/_lib/seedance-start.js) inside the same transaction, and is
--      idempotent on (user_id, client_request_id).
--   3. public.refund_video_edit_task(...) — atomic refund RPC, service_role
--      only. Restores exactly the pools credits were deducted from and
--      guards against double refund via refunded_at.
--
-- CONFIRMED (production Supabase, via dashboard, 2026-07-18): the only
-- foreign key constraint on public.credit_transactions is
-- credit_transactions_user_id_fkey (user_id -> profiles(id) ON DELETE
-- CASCADE). related_task_id carries no foreign key in production, matching
-- its declaration in 20260624000000_initial_flowvid_schema.sql
-- ("related_task_id uuid," with no REFERENCES clause) — the same column
-- already holds ids from generation_tasks for the existing video-generation
-- flow with no constraint tying it to that table. Inserting
-- video_edit_tasks ids into related_task_id (below, in
-- reserve_video_edit_task / refund_video_edit_task) is therefore not a
-- foreign key violation, and no constraint change is required.
--
-- DO NOT run against production without explicit approval.
--
-- ============================================================
-- PRE-CHECK QUERIES (run read-only before executing this file)
-- ============================================================
--
-- 1. Table existence:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_name = 'video_edit_tasks';
--    -> If returns a row, STOP and investigate before running.
--
-- 2. Function existence:
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('reserve_video_edit_task', 'refund_video_edit_task');
--    -> If either returns a row, STOP and investigate before running.
--
-- 3. Function execution permission (verify AFTER migration):
--    SELECT grantee, privilege_type
--    FROM information_schema.role_routine_grants
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('reserve_video_edit_task', 'refund_video_edit_task');
--    -> Only service_role should have EXECUTE.
--
-- 4. RLS/table privilege verification (verify AFTER migration):
--    SELECT has_table_privilege('anon', 'public.video_edit_tasks', 'SELECT') AS anon_select,
--           has_table_privilege('authenticated', 'public.video_edit_tasks', 'SELECT') AS auth_select,
--           has_table_privilege('service_role', 'public.video_edit_tasks', 'SELECT') AS service_select;
--    -> anon_select and auth_select must both be false; service_select true.
--    (No RLS policies are created for this table — matches the current
--    direction taken for other internal tables, see
--    20260715_revoke_internal_table_access.sql / 20260715_revoke_legacy_video_history_access.sql.
--    All access to video_edit_tasks goes through api/video-edit.js and
--    api/video-edit-status.js, both of which use the service-role client.)
-- ============================================================

begin;

-- ────────────────────────────────────────────────────────────────
-- 1. Table
-- ────────────────────────────────────────────────────────────────
create table if not exists public.video_edit_tasks (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references public.profiles(id) on delete cascade,
  client_request_id           text not null,
  status                      text not null default 'queued'
                                check (status in ('queued', 'processing', 'completed', 'failed')),
  input_manifest              jsonb not null,
  transition                  text not null default 'cut' check (transition in ('cut')),
  clip_count                  integer not null check (clip_count between 1 and 6),
  requested_output_duration   numeric not null check (requested_output_duration > 0),
  actual_output_duration      numeric,
  credit_cost                 integer not null check (credit_cost > 0),
  deducted_subscription       integer not null default 0 check (deducted_subscription >= 0),
  deducted_free               integer not null default 0 check (deducted_free >= 0),
  deducted_purchased          integer not null default 0 check (deducted_purchased >= 0),
  edited_url                  text,
  storage_path                text,
  railway_error_code          text,
  failure_code                text,
  created_at                  timestamptz not null default now(),
  started_at                  timestamptz,
  completed_at                timestamptz,
  failed_at                   timestamptz,
  refunded_at                 timestamptz,
  updated_at                  timestamptz not null default now()
);

-- One active (queued/processing) edit task per user at a time.
create unique index if not exists video_edit_tasks_one_active_per_user_idx
  on public.video_edit_tasks (user_id)
  where status in ('queued', 'processing');

-- Idempotency: retried requests with the same clientRequestId must map to
-- the same row instead of creating a duplicate / double-charging.
create unique index if not exists video_edit_tasks_user_client_request_idx
  on public.video_edit_tasks (user_id, client_request_id);

create index if not exists video_edit_tasks_user_created_idx
  on public.video_edit_tasks (user_id, created_at desc);

-- RLS enabled, no policies: table is service_role-only, same posture as
-- flowvid_video_history / annual_credit_grant_log / user_subscriptions
-- after 20260715_revoke_internal_table_access.sql and
-- 20260715_revoke_legacy_video_history_access.sql. Users never query this
-- table directly; api/video-edit.js and api/video-edit-status.js (service
-- role) are the only access paths.
alter table public.video_edit_tasks enable row level security;

revoke all on public.video_edit_tasks from anon;
revoke all on public.video_edit_tasks from authenticated;
grant all on public.video_edit_tasks to service_role;

-- ────────────────────────────────────────────────────────────────
-- 2. reserve_video_edit_task — atomic reserve + deduct + record RPC
-- ────────────────────────────────────────────────────────────────
-- Returns a single row with:
--   task_id          uuid    — set on success (including idempotent replay)
--   rejection_reason text    — 'active_edit' | 'insufficient_credits' | NULL
--   existing          boolean — true if this call matched a prior
--                               (user_id, client_request_id) row instead of
--                               creating + charging a new one
create or replace function public.reserve_video_edit_task(
  p_user_id                   uuid,
  p_client_request_id         text,
  p_credit_cost               integer,
  p_input_manifest            jsonb,
  p_transition                text,
  p_clip_count                integer,
  p_requested_output_duration numeric
)
returns table (
  task_id          uuid,
  rejection_reason text,
  existing         boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock_key       bigint;
  v_existing_id    uuid;
  v_active_count   integer;
  v_bal            record;
  v_sub_avail      integer;
  v_free_avail     integer;
  v_purch_avail    integer;
  v_total_avail    integer;
  v_remaining      integer;
  v_from_sub       integer;
  v_from_free      integer;
  v_from_purch     integer;
  v_new_task_id    uuid;
begin
  -- Derive a per-user lock key distinct from reserve_generation_task's
  -- lock key namespace, so the video-edit and generation flows never
  -- unintentionally serialize against each other.
  v_lock_key := hashtext('video_edit:' || p_user_id::text)::bigint;

  if not pg_try_advisory_xact_lock(v_lock_key) then
    return query select null::uuid, 'active_edit'::text, false;
    return;
  end if;

  -- Idempotency: a prior call with the same client_request_id already
  -- created (and, if applicable, charged for) a task. Return it as-is
  -- without charging again or touching Railway a second time.
  select id into v_existing_id
  from video_edit_tasks
  where user_id = p_user_id
    and client_request_id = p_client_request_id;

  if v_existing_id is not null then
    return query select v_existing_id, null::text, true;
    return;
  end if;

  -- Only one active (queued/processing) edit task per user at a time.
  select count(*) into v_active_count
  from video_edit_tasks
  where user_id = p_user_id
    and status in ('queued', 'processing');

  if v_active_count > 0 then
    return query select null::uuid, 'active_edit'::text, false;
    return;
  end if;

  -- Read current balance, applying the same expiry treatment as
  -- checkAndDeduct() in api/_lib/seedance-start.js: expired pools count as
  -- 0 available for this deduction (the stored column value itself is left
  -- untouched here; periodic zeroing happens elsewhere).
  select subscription_credits, free_credits, purchased_credits,
         subscription_expires_at, purchased_expires_at
    into v_bal
  from credit_balances
  where user_id = p_user_id
  for update;

  if not found then
    return query select null::uuid, 'insufficient_credits'::text, false;
    return;
  end if;

  v_sub_avail := case
    when v_bal.subscription_expires_at is not null and v_bal.subscription_expires_at < now() then 0
    else coalesce(v_bal.subscription_credits, 0)
  end;
  v_free_avail := coalesce(v_bal.free_credits, 0);
  v_purch_avail := case
    when v_bal.purchased_expires_at is not null and v_bal.purchased_expires_at < now() then 0
    else coalesce(v_bal.purchased_credits, 0)
  end;
  v_total_avail := v_sub_avail + v_free_avail + v_purch_avail;

  if v_total_avail < p_credit_cost then
    return query select null::uuid, 'insufficient_credits'::text, false;
    return;
  end if;

  -- Deduct priority: subscription -> free -> purchased (matches
  -- checkAndDeduct() in api/_lib/seedance-start.js).
  v_remaining := p_credit_cost;
  v_from_sub := least(v_remaining, v_sub_avail); v_remaining := v_remaining - v_from_sub;
  v_from_free := least(v_remaining, v_free_avail); v_remaining := v_remaining - v_from_free;
  v_from_purch := least(v_remaining, v_purch_avail); v_remaining := v_remaining - v_from_purch;

  update credit_balances
  set subscription_credits = subscription_credits - v_from_sub,
      free_credits         = free_credits - v_from_free,
      purchased_credits    = purchased_credits - v_from_purch,
      updated_at            = now()
  where user_id = p_user_id;

  insert into video_edit_tasks (
    user_id, client_request_id, status, input_manifest, transition,
    clip_count, requested_output_duration, credit_cost,
    deducted_subscription, deducted_free, deducted_purchased
  ) values (
    p_user_id, p_client_request_id, 'queued', p_input_manifest, p_transition,
    p_clip_count, p_requested_output_duration, p_credit_cost,
    v_from_sub, v_from_free, v_from_purch
  )
  returning id into v_new_task_id;

  if v_from_sub > 0 then
    insert into credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_sub, 'subscription', 'video_edit', v_new_task_id);
  end if;
  if v_from_free > 0 then
    insert into credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_free, 'free', 'video_edit', v_new_task_id);
  end if;
  if v_from_purch > 0 then
    insert into credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_purch, 'purchased', 'video_edit', v_new_task_id);
  end if;

  return query select v_new_task_id, null::text, false;
end;
$$;

revoke all on function public.reserve_video_edit_task(uuid, text, integer, jsonb, text, integer, numeric) from public;
revoke all on function public.reserve_video_edit_task(uuid, text, integer, jsonb, text, integer, numeric) from anon;
revoke all on function public.reserve_video_edit_task(uuid, text, integer, jsonb, text, integer, numeric) from authenticated;
grant execute on function public.reserve_video_edit_task(uuid, text, integer, jsonb, text, integer, numeric) to service_role;

-- ────────────────────────────────────────────────────────────────
-- 3. refund_video_edit_task — atomic refund RPC
-- ────────────────────────────────────────────────────────────────
-- Returns a single row with:
--   ok      boolean
--   reason  text — 'not_found' | 'not_refundable' | 'already_refunded' | NULL
create or replace function public.refund_video_edit_task(
  p_task_id      uuid,
  p_failure_code text
)
returns table (
  ok     boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task record;
begin
  select id, user_id, status, refunded_at,
         deducted_subscription, deducted_free, deducted_purchased
    into v_task
  from video_edit_tasks
  where id = p_task_id
  for update;

  if not found then
    return query select false, 'not_found'::text;
    return;
  end if;

  -- Double-refund guard: both the status check and the refunded_at check
  -- must pass. The row lock above (FOR UPDATE) serializes concurrent
  -- refund attempts for the same task.
  if v_task.status not in ('queued', 'processing') then
    return query select false, 'not_refundable'::text;
    return;
  end if;

  if v_task.refunded_at is not null then
    return query select false, 'already_refunded'::text;
    return;
  end if;

  update credit_balances
  set subscription_credits = subscription_credits + v_task.deducted_subscription,
      free_credits         = free_credits + v_task.deducted_free,
      purchased_credits    = purchased_credits + v_task.deducted_purchased,
      updated_at            = now()
  where user_id = v_task.user_id;

  if v_task.deducted_subscription > 0 then
    insert into credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_task.user_id, v_task.deducted_subscription, 'subscription', 'video_edit_refund', v_task.id);
  end if;
  if v_task.deducted_free > 0 then
    insert into credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_task.user_id, v_task.deducted_free, 'free', 'video_edit_refund', v_task.id);
  end if;
  if v_task.deducted_purchased > 0 then
    insert into credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_task.user_id, v_task.deducted_purchased, 'purchased', 'video_edit_refund', v_task.id);
  end if;

  update video_edit_tasks
  set status       = 'failed',
      failure_code = p_failure_code,
      failed_at    = now(),
      refunded_at  = now(),
      updated_at   = now()
  where id = v_task.id;

  return query select true, null::text;
end;
$$;

revoke all on function public.refund_video_edit_task(uuid, text) from public;
revoke all on function public.refund_video_edit_task(uuid, text) from anon;
revoke all on function public.refund_video_edit_task(uuid, text) from authenticated;
grant execute on function public.refund_video_edit_task(uuid, text) to service_role;

commit;

-- Rollback (if unexpected breakage is observed after applying):
--   begin;
--   drop function if exists public.refund_video_edit_task(uuid, text);
--   drop function if exists public.reserve_video_edit_task(uuid, text, integer, jsonb, text, integer, numeric);
--   drop table if exists public.video_edit_tasks;
--   commit;
