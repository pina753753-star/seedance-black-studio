begin;

-- Persist the provider in the same transaction that reserves the task. This
-- keeps even a pre-deduction orphan discoverable by openrouter-reconcile.
create or replace function public.reserve_generation_task(
  p_user_id uuid,
  p_mode text,
  p_model text,
  p_prompt text,
  p_resolution text,
  p_duration_secs integer,
  p_aspect_ratio text,
  p_credit_cost integer
)
returns table (
  task_id uuid,
  rejection_reason text,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_key bigint;
  v_active_count integer;
  v_finished_at timestamptz;
  v_cooldown_secs integer;
  v_new_task_id uuid;
begin
  v_lock_key := hashtext(p_user_id::text)::bigint;

  if not pg_try_advisory_xact_lock(v_lock_key) then
    return query select null::uuid, 'active_generation'::text, 0::integer;
    return;
  end if;

  select count(*)
    into v_active_count
    from public.generation_tasks
   where user_id = p_user_id
     and status in ('queued', 'processing');

  if v_active_count > 0 then
    return query select null::uuid, 'active_generation'::text, 0::integer;
    return;
  end if;

  select max(finished_at)
    into v_finished_at
    from public.generation_tasks
   where user_id = p_user_id
     and finished_at is not null;

  if v_finished_at is not null and v_finished_at + interval '60 seconds' > now() then
    v_cooldown_secs := greatest(
      1,
      least(
        60,
        ceil(extract(epoch from (v_finished_at + interval '60 seconds' - now())))::integer
      )
    );
    return query select null::uuid, 'cooldown_active'::text, v_cooldown_secs;
    return;
  end if;

  insert into public.generation_tasks (
    user_id,
    mode,
    model,
    prompt,
    resolution,
    duration_seconds,
    aspect_ratio,
    credit_cost,
    status,
    api_provider
  ) values (
    p_user_id,
    p_mode,
    p_model,
    p_prompt,
    p_resolution,
    p_duration_secs,
    p_aspect_ratio,
    p_credit_cost,
    'queued',
    'openrouter'
  )
  returning id into v_new_task_id;

  return query select v_new_task_id, null::text, 0::integer;
end;
$$;

revoke all on function public.reserve_generation_task(
  uuid, text, text, text, text, integer, text, integer
) from public, anon, authenticated, service_role;

grant execute on function public.reserve_generation_task(
  uuid, text, text, text, text, integer, text, integer
) to service_role;

create or replace function public.deduct_generation_credits_atomic(
  p_task_id uuid,
  p_user_id uuid,
  p_credit_cost integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_user_id uuid;
  v_task_status text;
  v_task_credit_cost integer;
  v_api_provider text;
  v_api_task_id text;
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
  v_existing_subscription integer := 0;
  v_existing_free integer := 0;
  v_existing_purchased integer := 0;
  v_has_existing_charge boolean := false;
begin
  if p_credit_cost is null or p_credit_cost <= 0 then
    raise exception 'invalid_credit_cost'
      using errcode = 'check_violation';
  end if;

  select user_id, status, credit_cost, api_provider, api_task_id
    into v_task_user_id, v_task_status, v_task_credit_cost, v_api_provider, v_api_task_id
    from public.generation_tasks
   where id = p_task_id
   for update;

  if v_task_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'task_not_found');
  end if;

  if v_task_user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'task_owner_mismatch');
  end if;

  if v_task_status <> 'queued' or v_api_task_id is not null then
    return jsonb_build_object('ok', false, 'code', 'task_not_chargeable');
  end if;

  if v_api_provider is not null and v_api_provider <> 'openrouter' then
    return jsonb_build_object('ok', false, 'code', 'wrong_provider');
  end if;

  if v_task_credit_cost <> p_credit_cost then
    raise exception 'credit_cost_mismatch'
      using errcode = 'check_violation';
  end if;

  select
    count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'free' then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased' then abs(amount) else 0 end), 0)
    into v_has_existing_charge, v_existing_subscription, v_existing_free, v_existing_purchased
    from public.credit_transactions
   where related_task_id = p_task_id
     and reason = 'video_generation'
     and amount < 0;

  if v_has_existing_charge then
    if v_existing_subscription + v_existing_free + v_existing_purchased <> p_credit_cost then
      raise exception 'charge_state_inconsistent'
        using errcode = 'data_exception';
    end if;

    select free_credits, subscription_credits, purchased_credits
      into v_free, v_subscription, v_purchased
      from public.credit_balances
     where user_id = p_user_id;

    update public.generation_tasks
       set api_provider = 'openrouter',
           updated_at = now()
     where id = p_task_id
       and api_provider is null;

    return jsonb_build_object(
      'ok', true,
      'code', 'already_deducted',
      'deducted', p_credit_cost,
      'new_balance', coalesce(v_free, 0) + coalesce(v_subscription, 0) + coalesce(v_purchased, 0),
      'from_subscription', v_existing_subscription,
      'from_free', v_existing_free,
      'from_purchased', v_existing_purchased
    );
  end if;

  select
    free_credits,
    subscription_credits,
    purchased_credits,
    subscription_expires_at,
    purchased_expires_at
    into
      v_free,
      v_subscription,
      v_purchased,
      v_subscription_expires_at,
      v_purchased_expires_at
    from public.credit_balances
   where user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'balance_not_found');
  end if;

  if v_subscription_expires_at is not null and v_subscription_expires_at < now() then
    v_subscription := 0;
  end if;

  if v_purchased_expires_at is not null and v_purchased_expires_at < now() then
    v_purchased := 0;
  end if;

  v_total := v_free + v_subscription + v_purchased;

  if v_total < p_credit_cost then
    update public.credit_balances
       set subscription_credits = v_subscription,
           purchased_credits = v_purchased,
           updated_at = now()
     where user_id = p_user_id;

    return jsonb_build_object(
      'ok', false,
      'code', 'insufficient_credits',
      'balance', v_total,
      'required', p_credit_cost
    );
  end if;

  v_remaining := p_credit_cost;
  v_from_subscription := least(v_remaining, v_subscription);
  v_remaining := v_remaining - v_from_subscription;
  v_from_free := least(v_remaining, v_free);
  v_remaining := v_remaining - v_from_free;
  v_from_purchased := least(v_remaining, v_purchased);

  update public.credit_balances
     set subscription_credits = v_subscription - v_from_subscription,
         free_credits = v_free - v_from_free,
         purchased_credits = v_purchased - v_from_purchased,
         updated_at = now()
   where user_id = p_user_id;

  if v_from_subscription > 0 then
    insert into public.credit_transactions
      (user_id, amount, credit_type, reason, related_task_id)
    values
      (p_user_id, -v_from_subscription, 'subscription', 'video_generation', p_task_id);
  end if;

  if v_from_free > 0 then
    insert into public.credit_transactions
      (user_id, amount, credit_type, reason, related_task_id)
    values
      (p_user_id, -v_from_free, 'free', 'video_generation', p_task_id);
  end if;

  if v_from_purchased > 0 then
    insert into public.credit_transactions
      (user_id, amount, credit_type, reason, related_task_id)
    values
      (p_user_id, -v_from_purchased, 'purchased', 'video_generation', p_task_id);
  end if;

  update public.generation_tasks
     set api_provider = 'openrouter',
         updated_at = now()
   where id = p_task_id
     and status = 'queued';

  return jsonb_build_object(
    'ok', true,
    'code', 'deducted',
    'deducted', p_credit_cost,
    'new_balance', v_total - p_credit_cost,
    'from_subscription', v_from_subscription,
    'from_free', v_from_free,
    'from_purchased', v_from_purchased
  );
end;
$$;

revoke all on function public.deduct_generation_credits_atomic(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;

grant execute on function public.deduct_generation_credits_atomic(
  uuid, uuid, integer
) to service_role;

commit;
