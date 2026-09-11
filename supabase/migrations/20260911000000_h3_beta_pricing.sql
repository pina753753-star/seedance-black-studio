-- H3 Max / H3 Max Live BETA pricing.
--
-- Sale window ends at 2026-09-15 00:00 JST
--                         = 2026-09-14 15:00:00+00.
--
-- H3 Max (queued, 15s):       60 credits before cutoff, 130 after.
-- H3 Max Live (WebRTC, 60s): 110 credits before cutoff, 440 after.
--
-- Important billing invariant:
-- Every job/session stores the price selected at reservation time in
-- credit_cost. Deduct/refund logic ALWAYS uses that stored value, never the
-- current wall-clock price. This makes idempotent replays and refunds safe even
-- if they happen across the cutoff.

begin;

create or replace function public.h3_max_credit_cost()
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when now() < timestamptz '2026-09-14 15:00:00+00' then 60
    else 130
  end;
$$;

create or replace function public.h3_max_live_credit_cost()
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when now() < timestamptz '2026-09-14 15:00:00+00' then 110
    else 440
  end;
$$;

revoke all on function public.h3_max_credit_cost() from public, anon, authenticated;
revoke all on function public.h3_max_live_credit_cost() from public, anon, authenticated;
grant execute on function public.h3_max_credit_cost() to service_role;
grant execute on function public.h3_max_live_credit_cost() to service_role;

-- Keep historical rows valid while allowing both BETA prices.
alter table public.h3_live_jobs
  drop constraint if exists h3_live_jobs_credit_cost_check;
alter table public.h3_live_jobs
  add constraint h3_live_jobs_credit_cost_check
  check (credit_cost in (60, 130));
alter table public.h3_live_jobs
  alter column credit_cost set default public.h3_max_credit_cost();

alter table public.h3_director_sessions
  drop constraint if exists h3_director_sessions_credit_cost_check;
alter table public.h3_director_sessions
  add constraint h3_director_sessions_credit_cost_check
  check (credit_cost in (110, 440));
alter table public.h3_director_sessions
  alter column credit_cost set default public.h3_max_live_credit_cost();

-- ---------------------------------------------------------------------------
-- H3 Max queued reservation: persist the authoritative price on the row.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_h3_live_job_atomic(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_instruction text,
  p_input_mode text default 'text'::text,
  p_image_upload_id uuid default null::uuid
)
returns table(job_id uuid, code text, retry_after_seconds integer, existing boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_lock_key                  bigint;
  v_enabled                   boolean;
  v_existing_id               uuid;
  v_existing_instruction      text;
  v_existing_image_upload_id  uuid;
  v_active_count              integer;
  v_finished_at               timestamptz;
  v_retry_after               integer;
  v_job_id                    uuid;
  v_upload                    public.h3_live_image_uploads%rowtype;
  v_credit_cost               integer;
begin
  if p_user_id is null
     or p_idempotency_key is null
     or char_length(btrim(coalesce(p_instruction, ''))) < 1
     or char_length(btrim(coalesce(p_instruction, ''))) > 2000
     or coalesce(p_input_mode, 'text') not in ('text', 'image')
     or (coalesce(p_input_mode, 'text') = 'image' and p_image_upload_id is null)
     or (coalesce(p_input_mode, 'text') = 'text' and p_image_upload_id is not null)
  then
    raise exception 'invalid_h3_live_reservation'
      using errcode = 'check_violation';
  end if;

  v_lock_key := hashtext('h3_live:' || p_user_id::text)::bigint;

  if not pg_try_advisory_xact_lock(v_lock_key) then
    return query select null::uuid, 'active_job'::text, 0, false;
    return;
  end if;

  select enabled
    into v_enabled
    from public.h3_live_controls
   where control_key = 'h3_live';

  if coalesce(v_enabled, false) is not true then
    return query select null::uuid, 'service_disabled'::text, 0, false;
    return;
  end if;

  select id, instruction, image_upload_id
    into v_existing_id, v_existing_instruction, v_existing_image_upload_id
    from public.h3_live_jobs
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_instruction is distinct from btrim(p_instruction)
       or v_existing_image_upload_id is distinct from p_image_upload_id
    then
      return query select v_existing_id, 'idempotency_conflict'::text, 0, true;
    else
      return query select v_existing_id, 'existing'::text, 0, true;
    end if;
    return;
  end if;

  select count(*)
    into v_active_count
    from public.h3_live_jobs
   where user_id = p_user_id
     and status in ('queued', 'submitting', 'processing');

  if v_active_count > 0 then
    return query select null::uuid, 'active_job'::text, 0, false;
    return;
  end if;

  select max(finished_at)
    into v_finished_at
    from public.h3_live_jobs
   where user_id = p_user_id
     and finished_at is not null;

  if v_finished_at is not null
     and v_finished_at + interval '10 seconds' > now()
  then
    v_retry_after := greatest(
      1,
      least(
        10,
        ceil(extract(epoch from (v_finished_at + interval '10 seconds' - now())))::integer
      )
    );
    return query select null::uuid, 'cooldown_active'::text, v_retry_after, false;
    return;
  end if;

  if p_input_mode = 'image' then
    select *
      into v_upload
      from public.h3_live_image_uploads
     where id = p_image_upload_id
     for update;

    if not found
       or v_upload.user_id <> p_user_id
       or v_upload.moderation_status <> 'passed'
       or v_upload.deleted_at is not null
       or v_upload.job_id is not null
       or v_upload.superseded_at is not null
    then
      return query select null::uuid, 'image_not_usable'::text, 0, false;
      return;
    end if;
  end if;

  v_credit_cost := public.h3_max_credit_cost();
  if v_credit_cost not in (60, 130) then
    raise exception 'h3_live_credit_cost_invalid' using errcode = 'check_violation';
  end if;

  insert into public.h3_live_jobs (
    user_id, idempotency_key, instruction, status,
    provider, duration_seconds, resolution, credit_cost,
    input_mode, image_upload_id
  )
  values (
    p_user_id, p_idempotency_key, btrim(p_instruction), 'queued',
    'fal', 15, '768p', v_credit_cost,
    coalesce(p_input_mode, 'text'), p_image_upload_id
  )
  returning id into v_job_id;

  if p_input_mode = 'image' then
    update public.h3_live_image_uploads
       set job_id = v_job_id,
           updated_at = now()
     where id = p_image_upload_id;
  end if;

  return query select v_job_id, null::text, 0, false;
end;
$function$;

-- ---------------------------------------------------------------------------
-- H3 Max queued deduction: use the job's stored price.
-- ---------------------------------------------------------------------------
create or replace function public.deduct_h3_live_credits_atomic(p_job_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job                     public.h3_live_jobs%rowtype;
  v_enabled                 boolean;
  v_free                    integer;
  v_subscription            integer;
  v_purchased               integer;
  v_subscription_expires_at timestamptz;
  v_purchased_expires_at    timestamptz;
  v_total                   integer;
  v_remaining               integer;
  v_from_subscription       integer := 0;
  v_from_free               integer := 0;
  v_from_purchased          integer := 0;
  v_has_charge              boolean;
  v_charge_subscription     integer;
  v_charge_free             integer;
  v_charge_purchased        integer;
begin
  select * into v_job from public.h3_live_jobs where id = p_job_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'job_owner_mismatch');
  end if;
  if v_job.credit_cost not in (60, 130) then
    raise exception 'h3_live_credit_cost_mismatch' using errcode = 'check_violation';
  end if;

  select count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'free'         then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased'    then abs(amount) else 0 end), 0)
    into v_has_charge, v_charge_subscription, v_charge_free, v_charge_purchased
    from public.credit_transactions
   where related_task_id = p_job_id and reason = 'h3_live_generation' and amount < 0;

  if v_job.charged_at is not null or v_has_charge then
    if v_job.charged_at is null
       or not v_has_charge
       or v_charge_subscription <> v_job.deducted_subscription
       or v_charge_free <> v_job.deducted_free
       or v_charge_purchased <> v_job.deducted_purchased
       or v_charge_subscription + v_charge_free + v_charge_purchased <> v_job.credit_cost
    then
      raise exception 'h3_live_charge_state_inconsistent' using errcode = 'data_exception';
    end if;

    select free_credits, subscription_credits, purchased_credits
      into v_free, v_subscription, v_purchased
      from public.credit_balances where user_id = p_user_id;

    return jsonb_build_object(
      'ok', true, 'code', 'already_deducted', 'deducted', v_job.credit_cost,
      'new_balance', coalesce(v_free, 0) + coalesce(v_subscription, 0) + coalesce(v_purchased, 0),
      'from_subscription', v_charge_subscription,
      'from_free', v_charge_free,
      'from_purchased', v_charge_purchased
    );
  end if;

  if v_job.status <> 'queued' or v_job.provider_request_id is not null then
    return jsonb_build_object('ok', false, 'code', 'job_not_chargeable');
  end if;

  select enabled into v_enabled from public.h3_live_controls where control_key = 'h3_live';

  if coalesce(v_enabled, false) is not true then
    update public.h3_live_jobs
       set status = 'failed', error_code = 'service_disabled',
           error_message = 'H3 Live is disabled',
           failed_at = now(), finished_at = now(), updated_at = now()
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'service_disabled');
  end if;

  select free_credits, subscription_credits, purchased_credits,
         subscription_expires_at, purchased_expires_at
    into v_free, v_subscription, v_purchased,
         v_subscription_expires_at, v_purchased_expires_at
    from public.credit_balances where user_id = p_user_id for update;

  if not found then
    update public.h3_live_jobs
       set status = 'failed', error_code = 'balance_not_found',
           error_message = 'Credit balance was not found',
           failed_at = now(), finished_at = now(), updated_at = now()
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'balance_not_found');
  end if;

  if v_subscription_expires_at is not null and v_subscription_expires_at < now() then
    v_subscription := 0;
  end if;
  if v_purchased_expires_at is not null and v_purchased_expires_at < now() then
    v_purchased := 0;
  end if;

  v_total := coalesce(v_free, 0) + coalesce(v_subscription, 0) + coalesce(v_purchased, 0);

  if v_total < v_job.credit_cost then
    update public.credit_balances
       set subscription_credits = v_subscription, purchased_credits = v_purchased, updated_at = now()
     where user_id = p_user_id;
    update public.h3_live_jobs
       set status = 'failed', error_code = 'insufficient_credits',
           error_message = 'Insufficient credits',
           failed_at = now(), finished_at = now(), updated_at = now()
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'insufficient_credits',
                              'balance', v_total, 'required', v_job.credit_cost);
  end if;

  v_remaining := v_job.credit_cost;
  v_from_subscription := least(v_remaining, coalesce(v_subscription, 0));
  v_remaining := v_remaining - v_from_subscription;
  v_from_free := least(v_remaining, coalesce(v_free, 0));
  v_remaining := v_remaining - v_from_free;
  v_from_purchased := least(v_remaining, coalesce(v_purchased, 0));

  update public.credit_balances
     set subscription_credits = coalesce(v_subscription, 0) - v_from_subscription,
         free_credits         = coalesce(v_free, 0) - v_from_free,
         purchased_credits    = coalesce(v_purchased, 0) - v_from_purchased,
         updated_at = now()
   where user_id = p_user_id;

  if v_from_subscription > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_subscription, 'subscription', 'h3_live_generation', p_job_id);
  end if;
  if v_from_free > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_free, 'free', 'h3_live_generation', p_job_id);
  end if;
  if v_from_purchased > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_purchased, 'purchased', 'h3_live_generation', p_job_id);
  end if;

  update public.h3_live_jobs
     set deducted_subscription = v_from_subscription,
         deducted_free = v_from_free,
         deducted_purchased = v_from_purchased,
         charged_at = now(), updated_at = now()
   where id = p_job_id;

  return jsonb_build_object(
    'ok', true, 'code', 'deducted', 'deducted', v_job.credit_cost,
    'new_balance', v_total - v_job.credit_cost,
    'from_subscription', v_from_subscription, 'from_free', v_from_free,
    'from_purchased', v_from_purchased
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- H3 Max queued refund: validate and return the stored price.
-- ---------------------------------------------------------------------------
create or replace function public.refund_h3_live_job_atomic(
  p_job_id uuid,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_job                 public.h3_live_jobs%rowtype;
  v_balance_user_id     uuid;
  v_has_charge          boolean;
  v_charge_subscription integer;
  v_charge_free         integer;
  v_charge_purchased    integer;
  v_has_refund          boolean;
  v_refund_subscription integer;
  v_refund_free         integer;
  v_refund_purchased    integer;
begin
  select * into v_job from public.h3_live_jobs where id = p_job_id for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  if v_job.credit_cost not in (60, 130) then
    raise exception 'h3_live_credit_cost_mismatch' using errcode = 'check_violation';
  end if;
  if v_job.status = 'completed' then
    return jsonb_build_object('ok', true, 'code', 'already_completed', 'refunded', false);
  end if;

  select count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'free'         then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased'    then abs(amount) else 0 end), 0)
    into v_has_charge, v_charge_subscription, v_charge_free, v_charge_purchased
    from public.credit_transactions
   where related_task_id = p_job_id and reason = 'h3_live_generation' and amount < 0;

  if not v_has_charge then
    if v_job.charged_at is not null
       or v_job.deducted_subscription + v_job.deducted_free + v_job.deducted_purchased <> 0
    then
      raise exception 'h3_live_charge_state_inconsistent' using errcode = 'data_exception';
    end if;

    update public.h3_live_jobs
       set status = 'failed',
           error_code = coalesce(error_code, left(nullif(btrim(p_error_code), ''), 100)),
           error_message = coalesce(error_message, left(nullif(btrim(p_error_message), ''), 1000)),
           failed_at = coalesce(failed_at, now()),
           finished_at = coalesce(finished_at, now()),
           updated_at = now()
     where id = p_job_id;

    return jsonb_build_object('ok', true, 'code', 'no_charge_found', 'refunded', false);
  end if;

  if v_job.charged_at is null
     or v_charge_subscription <> v_job.deducted_subscription
     or v_charge_free <> v_job.deducted_free
     or v_charge_purchased <> v_job.deducted_purchased
     or v_charge_subscription + v_charge_free + v_charge_purchased <> v_job.credit_cost
  then
    raise exception 'h3_live_charge_state_inconsistent' using errcode = 'data_exception';
  end if;

  select count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then amount else 0 end), 0),
    coalesce(sum(case when credit_type = 'free'         then amount else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased'    then amount else 0 end), 0)
    into v_has_refund, v_refund_subscription, v_refund_free, v_refund_purchased
    from public.credit_transactions
   where related_task_id = p_job_id and reason = 'h3_live_refund' and amount > 0;

  if v_job.refunded_at is not null or v_has_refund then
    if v_job.refunded_at is null or not v_has_refund
       or v_refund_subscription <> v_charge_subscription
       or v_refund_free <> v_charge_free
       or v_refund_purchased <> v_charge_purchased
    then
      raise exception 'h3_live_refund_state_inconsistent' using errcode = 'data_exception';
    end if;
    return jsonb_build_object('ok', true, 'code', 'already_refunded', 'refunded', true,
                              'refunded_amount', v_job.credit_cost);
  end if;

  select user_id into v_balance_user_id
    from public.credit_balances where user_id = v_job.user_id for update;

  if not found then
    raise exception 'h3_live_balance_not_found' using errcode = 'no_data_found';
  end if;

  if v_charge_subscription > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_job.user_id, v_charge_subscription, 'subscription', 'h3_live_refund', p_job_id);
  end if;
  if v_charge_free > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_job.user_id, v_charge_free, 'free', 'h3_live_refund', p_job_id);
  end if;
  if v_charge_purchased > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_job.user_id, v_charge_purchased, 'purchased', 'h3_live_refund', p_job_id);
  end if;

  update public.credit_balances
     set subscription_credits = subscription_credits + v_charge_subscription,
         free_credits         = free_credits + v_charge_free,
         purchased_credits    = purchased_credits + v_charge_purchased,
         updated_at = now()
   where user_id = v_job.user_id;

  update public.h3_live_jobs
     set status = 'failed',
         error_code = coalesce(error_code, left(nullif(btrim(p_error_code), ''), 100)),
         error_message = coalesce(error_message, left(nullif(btrim(p_error_message), ''), 1000)),
         failed_at = coalesce(failed_at, now()),
         refunded_at = now(),
         finished_at = coalesce(finished_at, now()),
         updated_at = now()
   where id = p_job_id;

  return jsonb_build_object('ok', true, 'code', 'refunded', 'refunded', true,
                            'refunded_amount', v_job.credit_cost);
end;
$function$;

-- ---------------------------------------------------------------------------
-- H3 Max Live reservation: persist the authoritative price on the session.
-- ---------------------------------------------------------------------------
create or replace function public.reserve_h3_director_session_atomic(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_initial_prompt text,
  p_offer_fingerprint text,
  p_aspect_ratio text,
  p_preview_test boolean default false
)
returns table(session_id uuid, code text, existing boolean)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_lock_key bigint;
  v_enabled boolean;
  v_account_status text;
  v_existing public.h3_director_sessions%rowtype;
  v_session_id uuid;
  v_credit_cost integer;
begin
  if p_user_id is null or p_idempotency_key is null
     or char_length(btrim(coalesce(p_initial_prompt, ''))) not between 1 and 2000
     or coalesce(p_offer_fingerprint, '') !~ '^[0-9a-f]{64}$'
     or coalesce(p_aspect_ratio, '') not in ('16:9', '9:16')
  then
    raise exception 'invalid_h3_director_reservation' using errcode = 'check_violation';
  end if;

  v_user_lock_key := hashtext(p_user_id::text)::bigint;
  if not pg_try_advisory_xact_lock(v_user_lock_key) then
    return query select null::uuid, 'user_busy'::text, false;
    return;
  end if;

  select enabled into v_enabled
    from public.h3_director_controls where control_key = 'h3_director';
  if coalesce(v_enabled, false) is not true
     and coalesce(p_preview_test, false) is not true then
    return query select null::uuid, 'service_disabled'::text, false;
    return;
  end if;

  select account_status into v_account_status
    from public.profiles where id = p_user_id for share;
  if not found or v_account_status <> 'active' then
    return query select null::uuid, 'account_restricted'::text, false;
    return;
  end if;

  update public.h3_director_sessions
     set status='completed', ended_at=coalesce(ended_at,now()),
         finished_at=coalesce(finished_at,now()), updated_at=now()
   where user_id=p_user_id and status in ('connecting','live')
     and expires_at is not null and expires_at <= now();

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

  v_credit_cost := public.h3_max_live_credit_cost();
  if v_credit_cost not in (110, 440) then
    raise exception 'h3_director_credit_cost_invalid' using errcode = 'check_violation';
  end if;

  insert into public.h3_director_sessions (
    user_id, idempotency_key, initial_prompt, offer_fingerprint, aspect_ratio, credit_cost
  )
  values (
    p_user_id, p_idempotency_key, btrim(p_initial_prompt), p_offer_fingerprint, p_aspect_ratio, v_credit_cost
  )
  returning id into v_session_id;

  return query select v_session_id, 'reserved'::text, false;
end;
$function$;

-- ---------------------------------------------------------------------------
-- H3 Max Live deduction: use the session's stored price.
-- ---------------------------------------------------------------------------
create or replace function public.deduct_h3_director_credits_atomic(
  p_session_id uuid,
  p_user_id uuid,
  p_preview_test boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  if v_session.credit_cost not in (110, 440) then
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
       or v_charge_subscription + v_charge_free + v_charge_purchased <> v_session.credit_cost
    then
      raise exception 'h3_director_charge_state_inconsistent' using errcode = 'data_exception';
    end if;
    select free_credits, subscription_credits, purchased_credits
      into v_free, v_subscription, v_purchased
      from public.credit_balances where user_id = p_user_id;
    return jsonb_build_object(
      'ok', true, 'code', 'already_deducted', 'deducted', v_session.credit_cost,
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
  if coalesce(v_enabled, false) is not true
     and coalesce(p_preview_test, false) is not true then
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

  if v_total < v_session.credit_cost then
    update public.credit_balances
       set subscription_credits = coalesce(v_subscription,0),
           purchased_credits = coalesce(v_purchased,0), updated_at = now()
     where user_id = p_user_id;
    update public.h3_director_sessions
       set status='failed', error_code='insufficient_credits', error_message='Insufficient credits',
           failed_at=now(), finished_at=now(), updated_at=now()
     where id=p_session_id;
    return jsonb_build_object('ok', false, 'code', 'insufficient_credits',
                              'balance', v_total, 'required', v_session.credit_cost);
  end if;

  v_remaining := v_session.credit_cost;
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

  return jsonb_build_object('ok',true,'code','deducted','deducted',v_session.credit_cost,
                            'new_balance',v_total-v_session.credit_cost);
end;
$function$;

-- ---------------------------------------------------------------------------
-- H3 Max Live refund: validate and return the stored price.
-- ---------------------------------------------------------------------------
create or replace function public.refund_h3_director_session_atomic(
  p_session_id uuid,
  p_error_code text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  if v_session.credit_cost not in (110, 440) then
    raise exception 'h3_director_credit_cost_mismatch' using errcode='check_violation';
  end if;

  if v_session.status in ('live','completed')
     or (
       v_session.provider_session_id is not null
       and not (
         v_session.status = 'failed'
         and v_session.error_code = 'operator_reconcile_release'
       )
     )
  then
    return jsonb_build_object('ok',true,'code','provider_session_exists','refunded',false);
  end if;

  select count(*) > 0,
         coalesce(sum(case when credit_type='subscription' then abs(amount) else 0 end),0),
         coalesce(sum(case when credit_type='free' then abs(amount) else 0 end),0),
         coalesce(sum(case when credit_type='purchased' then abs(amount) else 0 end),0)
    into v_has_charge, v_charge_subscription, v_charge_free, v_charge_purchased
    from public.credit_transactions
   where related_task_id=p_session_id and reason='h3_director_session' and amount<0;

  if not v_has_charge then
    if v_session.charged_at is not null
       or v_session.deducted_subscription + v_session.deducted_free + v_session.deducted_purchased <> 0
    then
      raise exception 'h3_director_charge_state_inconsistent' using errcode='data_exception';
    end if;
    update public.h3_director_sessions
       set status='failed', error_code=left(coalesce(nullif(btrim(p_error_code),''),'start_failed'),100),
           error_message=left(coalesce(p_error_message,''),1000), failed_at=now(), finished_at=now(), updated_at=now()
     where id=p_session_id;
    return jsonb_build_object('ok',true,'code','no_charge_found','refunded',false);
  end if;

  if v_session.charged_at is null
     or v_charge_subscription<>v_session.deducted_subscription
     or v_charge_free<>v_session.deducted_free
     or v_charge_purchased<>v_session.deducted_purchased
     or v_charge_subscription+v_charge_free+v_charge_purchased<>v_session.credit_cost
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
    return jsonb_build_object('ok',true,'code','already_refunded','refunded',true,
                              'refunded_amount',v_session.credit_cost);
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

  return jsonb_build_object('ok',true,'code','refunded','refunded',true,
                            'refunded_amount',v_session.credit_cost);
end;
$function$;

-- Preserve the same execution boundary as the original H3 migrations.
revoke all on function public.reserve_h3_live_job_atomic(uuid, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.deduct_h3_live_credits_atomic(uuid, uuid) from public, anon, authenticated;
revoke all on function public.refund_h3_live_job_atomic(uuid, text, text) from public, anon, authenticated;
revoke all on function public.reserve_h3_director_session_atomic(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.deduct_h3_director_credits_atomic(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.refund_h3_director_session_atomic(uuid, text, text) from public, anon, authenticated;

grant execute on function public.reserve_h3_live_job_atomic(uuid, uuid, text, text, uuid) to service_role;
grant execute on function public.deduct_h3_live_credits_atomic(uuid, uuid) to service_role;
grant execute on function public.refund_h3_live_job_atomic(uuid, text, text) to service_role;
grant execute on function public.reserve_h3_director_session_atomic(uuid, uuid, text, text, text, boolean) to service_role;
grant execute on function public.deduct_h3_director_credits_atomic(uuid, uuid, boolean) to service_role;
grant execute on function public.refund_h3_director_session_atomic(uuid, text, text) to service_role;

commit;
