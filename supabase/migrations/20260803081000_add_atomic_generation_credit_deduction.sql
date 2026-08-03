begin;

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

  select user_id, status, credit_cost, api_task_id
    into v_task_user_id, v_task_status, v_task_credit_cost, v_api_task_id
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
