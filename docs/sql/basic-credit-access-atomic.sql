-- LOCAL DRAFT ONLY: basic Seedance model purchase access; NOT APPLIED.
-- No new columns, buckets, or worker changes. Existing generation_tasks.settings
-- carries server-owned purchase_access_required. Only generation debit changed.
-- Keep ledger -> risk -> balance lock order and all prior accounting behavior.

begin;

create or replace function public.check_purchase_credit_access_locked(p_user_id uuid)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_balance public.credit_balances%rowtype;
begin
  -- Match record_payment_risk_event_atomic and credit granting lock order:
  -- payment ledger (deterministic id order) BEFORE credit_balances.
  -- Locks are retained until the enclosing debit RPC transaction commits.
  perform 1 from public.stripe_payment_ledger l
   where l.user_id = p_user_id
   order by l.id
   for update;

  if exists (
    select 1 from public.stripe_payment_ledger l
     where l.user_id = p_user_id and l.grant_status in ('held', 'reversed')
  ) or exists (
    select 1 from public.payment_risk_events r
     where r.status in ('open', 'reviewing')
       and (r.user_id = p_user_id or exists (
         select 1 from public.stripe_payment_ledger l
          where l.user_id = p_user_id
            and ((l.charge_id is not null and l.charge_id = r.charge_id)
              or (l.payment_intent_id is not null and l.payment_intent_id = r.payment_intent_id))
       ))
  ) then
    return 'payment_risk_hold';
  end if;

  if not exists (
    select 1 from public.stripe_payment_ledger l
     where l.user_id = p_user_id and l.purchase_type = 'credit_pack'
       and l.grant_status = 'granted'
  ) then
    return 'purchase_access_revoked';
  end if;

  select * into v_balance from public.credit_balances
   where user_id = p_user_id for update;
  if not found or coalesce(v_balance.purchased_credits, 0) <= 0
     or v_balance.purchased_expires_at is null
     or v_balance.purchased_expires_at <= now()
  then
    return 'purchase_access_revoked';
  end if;

  if not exists (
    select 1 from public.profiles p
     where p.id = p_user_id and coalesce(p.account_status, 'active') = 'active'
  ) then
    return 'account_restricted';
  end if;
  return null;
end;
$$;

revoke all on function public.check_purchase_credit_access_locked(uuid) from public, anon, authenticated;
grant execute on function public.check_purchase_credit_access_locked(uuid) to service_role;

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
  v_purchase_access_error text; -- standalone access gate declaration
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

  -- BEGIN standalone access gate
  if exists (select 1 from public.generation_tasks where id = p_task_id
      and settings->>'purchase_access_required' = 'true') then
    v_purchase_access_error := public.check_purchase_credit_access_locked(p_user_id);
    if v_purchase_access_error is not null then
      return jsonb_build_object('ok', false, 'code', v_purchase_access_error);
    end if;
  end if;
  -- END standalone access gate

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

revoke all on function public.deduct_generation_credits_atomic(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.deduct_generation_credits_atomic(uuid, uuid, integer) to service_role;

commit;
