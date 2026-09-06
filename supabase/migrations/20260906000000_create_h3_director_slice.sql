-- H3 Max Director — standalone WebRTC slice.
--
-- This migration does not replace or alter Seedance, the queued H3 Live
-- implementation, Stripe, watermarking, or their RPCs. It creates a separate
-- kill switch, session ledger, and Director-only credit RPCs. The shared Pina
-- credit balance is the sole intentional integration point.
--
-- Director is OFF after migration. Do not enable it or run a paid fal session
-- without explicit production-test approval.

begin;

create table if not exists public.h3_director_controls (
  control_key text primary key check (control_key = 'h3_director'),
  enabled boolean not null default false,
  note text,
  updated_at timestamptz not null default now()
);

insert into public.h3_director_controls (control_key, enabled, note)
values ('h3_director', false, 'H3 Max Director disabled until operator enables it.')
on conflict (control_key) do nothing;

alter table public.h3_director_controls enable row level security;
revoke all on table public.h3_director_controls from public, anon, authenticated;
grant select, update on table public.h3_director_controls to service_role;

create table if not exists public.h3_director_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key uuid not null,
  initial_prompt text not null,
  prompt_version integer not null default 1 check (prompt_version >= 1),

  status text not null default 'reserved'
    check (status in ('reserved', 'connecting', 'live', 'completed', 'failed', 'needs_review')),
  provider text not null default 'fal' check (provider = 'fal'),
  provider_app_id text not null default 'minimax/h3-max/director'
    check (provider_app_id = 'minimax/h3-max/director'),
  provider_session_id text,
  offer_fingerprint text not null check (offer_fingerprint ~ '^[0-9a-f]{64}$'),
  provider_answer_sdp text,

  duration_limit_seconds smallint not null default 60 check (duration_limit_seconds = 60),
  resolution text not null default '768p' check (resolution = '768p'),
  aspect_ratio text not null default '16:9' check (aspect_ratio in ('16:9', '9:16')),
  credit_cost integer not null default 440 check (credit_cost = 440),

  deducted_subscription integer not null default 0 check (deducted_subscription >= 0),
  deducted_free integer not null default 0 check (deducted_free >= 0),
  deducted_purchased integer not null default 0 check (deducted_purchased >= 0),

  charged_at timestamptz,
  connected_at timestamptz,
  expires_at timestamptz,
  last_heartbeat_at timestamptz,
  heartbeat_count integer not null default 0 check (heartbeat_count >= 0),
  ended_at timestamptz,
  failed_at timestamptz,
  refunded_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,

  recording_status text not null default 'pending'
    check (recording_status in ('pending', 'uploading', 'ready', 'failed')),
  recording_object_path text,
  recording_mime_type text check (recording_mime_type in ('video/webm', 'video/mp4')),
  recording_size_bytes bigint check (recording_size_bytes between 1 and 157286400),
  recorded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint h3_director_prompt_length_check
    check (char_length(btrim(initial_prompt)) between 1 and 2000),
  constraint h3_director_charge_state_check check (
    (charged_at is null and deducted_subscription = 0 and deducted_free = 0 and deducted_purchased = 0)
    or
    (charged_at is not null and deducted_subscription + deducted_free + deducted_purchased = credit_cost)
  ),
  constraint h3_director_provider_state_check
    check (
      (provider_session_id is null and provider_answer_sdp is null)
      or
      (provider_session_id is not null and provider_answer_sdp is not null
       and status in ('connecting', 'live', 'completed', 'failed', 'needs_review'))
    ),
  constraint h3_director_finished_state_check
    check ((status in ('completed', 'failed', 'needs_review')) = (finished_at is not null)),
  constraint h3_director_failed_state_check
    check ((status = 'failed') = (failed_at is not null)),
  constraint h3_director_refund_state_check
    check (refunded_at is null or (charged_at is not null and status = 'failed')),
  constraint h3_director_recording_state_check check (
    (recording_status in ('pending','failed') and recorded_at is null)
    or
    (recording_status='uploading' and recording_object_path is not null
      and recording_mime_type is not null and recording_size_bytes is not null and recorded_at is null)
    or
    (recording_status='ready' and recording_object_path is not null
      and recording_mime_type is not null and recording_size_bytes is not null and recorded_at is not null)
  )
);

create unique index if not exists h3_director_sessions_user_idempotency_idx
  on public.h3_director_sessions (user_id, idempotency_key);
create unique index if not exists h3_director_sessions_provider_session_idx
  on public.h3_director_sessions (provider, provider_session_id)
  where provider_session_id is not null;
create unique index if not exists h3_director_sessions_one_active_user_idx
  on public.h3_director_sessions (user_id)
  where status in ('reserved', 'connecting', 'live');
create index if not exists h3_director_sessions_user_created_idx
  on public.h3_director_sessions (user_id, created_at desc, id desc);
create index if not exists h3_director_sessions_expiry_idx
  on public.h3_director_sessions (expires_at)
  where status in ('connecting', 'live');

create unique index if not exists credit_transactions_h3_director_charge_unique
  on public.credit_transactions (related_task_id, reason, credit_type)
  where reason = 'h3_director_session';
create unique index if not exists credit_transactions_h3_director_refund_unique
  on public.credit_transactions (related_task_id, reason, credit_type)
  where reason = 'h3_director_refund';

alter table public.h3_director_sessions enable row level security;
revoke all on table public.h3_director_sessions from public, anon, authenticated;
grant select, insert, update, delete on table public.h3_director_sessions to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'h3-director-recordings', 'h3-director-recordings', false, 157286400,
  array['video/webm','video/mp4']::text[]
)
on conflict (id) do update set
  public=false,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- No storage.objects policies: recording upload uses a one-shot signed URL,
-- while playback URLs are signed by the authenticated API after ownership
-- checks. The bucket itself remains private.

create or replace function public.reserve_h3_director_session_atomic(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_initial_prompt text,
  p_offer_fingerprint text,
  p_aspect_ratio text
)
returns table (session_id uuid, code text, existing boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_lock_key bigint;
  v_enabled boolean;
  v_account_status text;
  v_existing public.h3_director_sessions%rowtype;
  v_session_id uuid;
begin
  if p_user_id is null or p_idempotency_key is null
     or char_length(btrim(coalesce(p_initial_prompt, ''))) not between 1 and 2000
     or coalesce(p_offer_fingerprint, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_aspect_ratio, '') not in ('16:9', '9:16')
  then
    raise exception 'invalid_h3_director_reservation' using errcode = 'check_violation';
  end if;

  -- Uses the same user lock namespace as the chargeback account-status RPC.
  v_user_lock_key := hashtext(p_user_id::text)::bigint;
  if not pg_try_advisory_xact_lock(v_user_lock_key) then
    return query select null::uuid, 'user_busy'::text, false;
    return;
  end if;

  select enabled into v_enabled
    from public.h3_director_controls where control_key = 'h3_director';
  if coalesce(v_enabled, false) is not true then
    return query select null::uuid, 'service_disabled'::text, false;
    return;
  end if;

  select account_status into v_account_status
    from public.profiles where id = p_user_id for share;
  if not found or v_account_status <> 'active' then
    return query select null::uuid, 'account_restricted'::text, false;
    return;
  end if;

  -- A browser may disappear without reaching /end-session. Expired provider
  -- sessions are not resumable, so close them before enforcing one-active.
  update public.h3_director_sessions
     set status='completed', ended_at=coalesce(ended_at,now()),
         finished_at=coalesce(finished_at,now()), updated_at=now()
   where user_id=p_user_id and status in ('connecting','live')
     and expires_at is not null and expires_at <= now();

  -- An uncharged reservation abandoned before the provider call is safe to
  -- close. Charged/connecting unknown states deliberately require review.
  update public.h3_director_sessions
     set status='failed', error_code='reservation_abandoned',
         error_message='Uncharged reservation expired before provider start',
         failed_at=now(), finished_at=now(), updated_at=now()
   where user_id=p_user_id and status='reserved' and charged_at is null
     and created_at < now() - interval '2 minutes';

  select * into v_existing
    from public.h3_director_sessions
   where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.initial_prompt is distinct from btrim(p_initial_prompt)
       or v_existing.offer_fingerprint is distinct from p_offer_fingerprint
       or v_existing.aspect_ratio is distinct from p_aspect_ratio then
      return query select v_existing.id, 'idempotency_conflict'::text, true;
    else
      return query select v_existing.id, 'existing'::text, true;
    end if;
    return;
  end if;

  if exists (
    select 1 from public.h3_director_sessions
     where user_id = p_user_id and status in ('reserved', 'connecting', 'live')
  ) then
    return query select null::uuid, 'active_session'::text, false;
    return;
  end if;

  insert into public.h3_director_sessions (
    user_id, idempotency_key, initial_prompt, offer_fingerprint, aspect_ratio
  )
  values (
    p_user_id, p_idempotency_key, btrim(p_initial_prompt), p_offer_fingerprint, p_aspect_ratio
  )
  returning id into v_session_id;

  return query select v_session_id, 'reserved'::text, false;
end;
$$;

revoke all on function public.reserve_h3_director_session_atomic(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_h3_director_session_atomic(uuid, uuid, text, text, text)
  to service_role;

create or replace function public.deduct_h3_director_credits_atomic(
  p_session_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.h3_director_sessions%rowtype;
  v_user_lock_key bigint;
  v_enabled boolean;
  v_account_status text;
  v_free integer;
  v_subscription integer;
  v_purchased integer;
  v_subscription_expires_at timestamptz;
  v_purchased_expires_at timestamptz;
  v_total integer;
  v_remaining integer;
  v_from_subscription integer := 0;
  v_from_free integer := 0;
  v_from_purchased integer := 0;
  v_has_charge boolean;
  v_charge_subscription integer;
  v_charge_free integer;
  v_charge_purchased integer;
begin
  select * into v_session from public.h3_director_sessions
   where id = p_session_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'session_not_found'); end if;
  if v_session.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'session_owner_mismatch');
  end if;
  if v_session.credit_cost <> 440 then
    raise exception 'h3_director_credit_cost_mismatch' using errcode = 'check_violation';
  end if;

  select count(*) > 0,
         coalesce(sum(case when credit_type = 'subscription' then abs(amount) else 0 end), 0),
         coalesce(sum(case when credit_type = 'free' then abs(amount) else 0 end), 0),
         coalesce(sum(case when credit_type = 'purchased' then abs(amount) else 0 end), 0)
    into v_has_charge, v_charge_subscription, v_charge_free, v_charge_purchased
    from public.credit_transactions
   where related_task_id = p_session_id and reason = 'h3_director_session' and amount < 0;

  if v_session.charged_at is not null or v_has_charge then
    if v_session.charged_at is null or not v_has_charge
       or v_charge_subscription <> v_session.deducted_subscription
       or v_charge_free <> v_session.deducted_free
       or v_charge_purchased <> v_session.deducted_purchased
       or v_charge_subscription + v_charge_free + v_charge_purchased <> 440
    then
      raise exception 'h3_director_charge_state_inconsistent' using errcode = 'data_exception';
    end if;
    select free_credits, subscription_credits, purchased_credits
      into v_free, v_subscription, v_purchased
      from public.credit_balances where user_id = p_user_id;
    return jsonb_build_object(
      'ok', true, 'code', 'already_deducted', 'deducted', 440,
      'new_balance', coalesce(v_free,0)+coalesce(v_subscription,0)+coalesce(v_purchased,0)
    );
  end if;

  if v_session.status <> 'connecting' or v_session.provider_session_id is not null then
    return jsonb_build_object('ok', false, 'code', 'session_not_chargeable');
  end if;

  v_user_lock_key := hashtext(p_user_id::text)::bigint;
  perform pg_advisory_xact_lock(v_user_lock_key);

  select account_status into v_account_status
    from public.profiles where id = p_user_id for share;
  if not found or v_account_status <> 'active' then
    update public.h3_director_sessions
       set status='failed', error_code='account_restricted', error_message='Account is restricted',
           failed_at=now(), finished_at=now(), updated_at=now()
     where id=p_session_id;
    return jsonb_build_object('ok', false, 'code', 'account_restricted');
  end if;

  select enabled into v_enabled
    from public.h3_director_controls where control_key = 'h3_director';
  if coalesce(v_enabled, false) is not true then
    update public.h3_director_sessions
       set status='failed', error_code='service_disabled', error_message='H3 Director is disabled',
           failed_at=now(), finished_at=now(), updated_at=now()
     where id=p_session_id;
    return jsonb_build_object('ok', false, 'code', 'service_disabled');
  end if;

  select free_credits, subscription_credits, purchased_credits,
         subscription_expires_at, purchased_expires_at
    into v_free, v_subscription, v_purchased,
         v_subscription_expires_at, v_purchased_expires_at
    from public.credit_balances where user_id = p_user_id for update;
  if not found then
    update public.h3_director_sessions
       set status='failed', error_code='balance_not_found', error_message='Credit balance was not found',
           failed_at=now(), finished_at=now(), updated_at=now()
     where id=p_session_id;
    return jsonb_build_object('ok', false, 'code', 'balance_not_found');
  end if;

  if v_subscription_expires_at is not null and v_subscription_expires_at < now() then v_subscription := 0; end if;
  if v_purchased_expires_at is not null and v_purchased_expires_at < now() then v_purchased := 0; end if;
  v_total := coalesce(v_free,0)+coalesce(v_subscription,0)+coalesce(v_purchased,0);

  if v_total < 440 then
    update public.credit_balances
       set subscription_credits = coalesce(v_subscription,0),
           purchased_credits = coalesce(v_purchased,0), updated_at = now()
     where user_id = p_user_id;
    update public.h3_director_sessions
       set status='failed', error_code='insufficient_credits', error_message='Insufficient credits',
           failed_at=now(), finished_at=now(), updated_at=now()
     where id=p_session_id;
    return jsonb_build_object('ok', false, 'code', 'insufficient_credits', 'balance', v_total, 'required', 440);
  end if;

  v_remaining := 440;
  v_from_subscription := least(v_remaining, coalesce(v_subscription,0));
  v_remaining := v_remaining - v_from_subscription;
  v_from_free := least(v_remaining, coalesce(v_free,0));
  v_remaining := v_remaining - v_from_free;
  v_from_purchased := least(v_remaining, coalesce(v_purchased,0));

  update public.credit_balances
     set subscription_credits = coalesce(v_subscription,0)-v_from_subscription,
         free_credits = coalesce(v_free,0)-v_from_free,
         purchased_credits = coalesce(v_purchased,0)-v_from_purchased,
         updated_at = now()
   where user_id = p_user_id;

  if v_from_subscription > 0 then
    insert into public.credit_transactions (user_id,amount,credit_type,reason,related_task_id)
    values (p_user_id,-v_from_subscription,'subscription','h3_director_session',p_session_id);
  end if;
  if v_from_free > 0 then
    insert into public.credit_transactions (user_id,amount,credit_type,reason,related_task_id)
    values (p_user_id,-v_from_free,'free','h3_director_session',p_session_id);
  end if;
  if v_from_purchased > 0 then
    insert into public.credit_transactions (user_id,amount,credit_type,reason,related_task_id)
    values (p_user_id,-v_from_purchased,'purchased','h3_director_session',p_session_id);
  end if;

  update public.h3_director_sessions
     set deducted_subscription=v_from_subscription, deducted_free=v_from_free,
         deducted_purchased=v_from_purchased, charged_at=now(), updated_at=now()
   where id=p_session_id;

  return jsonb_build_object('ok',true,'code','deducted','deducted',440,'new_balance',v_total-440);
end;
$$;

revoke all on function public.deduct_h3_director_credits_atomic(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.deduct_h3_director_credits_atomic(uuid, uuid)
  to service_role;

create or replace function public.refund_h3_director_session_atomic(
  p_session_id uuid,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.h3_director_sessions%rowtype;
  v_has_charge boolean;
  v_charge_subscription integer;
  v_charge_free integer;
  v_charge_purchased integer;
  v_has_refund boolean;
  v_refund_subscription integer;
  v_refund_free integer;
  v_refund_purchased integer;
begin
  select * into v_session from public.h3_director_sessions
   where id=p_session_id for update;
  if not found then return jsonb_build_object('ok',false,'code','session_not_found'); end if;
  if v_session.status in ('live','completed') or v_session.provider_session_id is not null then
    return jsonb_build_object('ok',true,'code','provider_session_exists','refunded',false);
  end if;
  if v_session.charged_at is null then
    update public.h3_director_sessions
       set status='failed', error_code=left(coalesce(nullif(btrim(p_error_code),''),'start_failed'),100),
           error_message=left(coalesce(p_error_message,''),1000), failed_at=now(), finished_at=now(), updated_at=now()
     where id=p_session_id;
    return jsonb_build_object('ok',true,'code','no_charge_found','refunded',false);
  end if;

  select count(*) > 0,
         coalesce(sum(case when credit_type='subscription' then abs(amount) else 0 end),0),
         coalesce(sum(case when credit_type='free' then abs(amount) else 0 end),0),
         coalesce(sum(case when credit_type='purchased' then abs(amount) else 0 end),0)
    into v_has_charge, v_charge_subscription, v_charge_free, v_charge_purchased
    from public.credit_transactions
   where related_task_id=p_session_id and reason='h3_director_session' and amount<0;
  if not v_has_charge
     or v_charge_subscription<>v_session.deducted_subscription
     or v_charge_free<>v_session.deducted_free
     or v_charge_purchased<>v_session.deducted_purchased
     or v_charge_subscription+v_charge_free+v_charge_purchased<>440
  then
    raise exception 'h3_director_charge_state_inconsistent' using errcode='data_exception';
  end if;

  select count(*) > 0,
         coalesce(sum(case when credit_type='subscription' then amount else 0 end),0),
         coalesce(sum(case when credit_type='free' then amount else 0 end),0),
         coalesce(sum(case when credit_type='purchased' then amount else 0 end),0)
    into v_has_refund, v_refund_subscription, v_refund_free, v_refund_purchased
    from public.credit_transactions
   where related_task_id=p_session_id and reason='h3_director_refund' and amount>0;
  if v_session.refunded_at is not null or v_has_refund then
    if v_session.refunded_at is null or not v_has_refund
       or v_refund_subscription<>v_charge_subscription
       or v_refund_free<>v_charge_free
       or v_refund_purchased<>v_charge_purchased
    then
      raise exception 'h3_director_refund_state_inconsistent' using errcode='data_exception';
    end if;
    return jsonb_build_object('ok',true,'code','already_refunded','refunded',true);
  end if;

  perform 1 from public.credit_balances where user_id=v_session.user_id for update;
  if not found then raise exception 'h3_director_balance_not_found' using errcode='no_data_found'; end if;

  if v_session.deducted_subscription > 0 then
    insert into public.credit_transactions (user_id,amount,credit_type,reason,related_task_id)
    values (v_session.user_id,v_session.deducted_subscription,'subscription','h3_director_refund',p_session_id);
  end if;
  if v_session.deducted_free > 0 then
    insert into public.credit_transactions (user_id,amount,credit_type,reason,related_task_id)
    values (v_session.user_id,v_session.deducted_free,'free','h3_director_refund',p_session_id);
  end if;
  if v_session.deducted_purchased > 0 then
    insert into public.credit_transactions (user_id,amount,credit_type,reason,related_task_id)
    values (v_session.user_id,v_session.deducted_purchased,'purchased','h3_director_refund',p_session_id);
  end if;

  update public.credit_balances
     set subscription_credits=subscription_credits+v_session.deducted_subscription,
         free_credits=free_credits+v_session.deducted_free,
         purchased_credits=purchased_credits+v_session.deducted_purchased,
         updated_at=now()
   where user_id=v_session.user_id;

  update public.h3_director_sessions
     set status='failed', refunded_at=now(), error_code=left(coalesce(nullif(btrim(p_error_code),''),'start_failed'),100),
         error_message=left(coalesce(p_error_message,''),1000), failed_at=now(), finished_at=now(), updated_at=now()
   where id=p_session_id;

  return jsonb_build_object('ok',true,'code','refunded','refunded',true,'refunded_amount',440);
end;
$$;

revoke all on function public.refund_h3_director_session_atomic(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.refund_h3_director_session_atomic(uuid, text, text)
  to service_role;

commit;
