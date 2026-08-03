create or replace function public.grant_stripe_credits_atomic(
  p_user_id uuid,
  p_credits integer,
  p_pool text,
  p_reason text,
  p_expires_at timestamptz,
  p_plan text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_rows integer := 0;
  resolved_credit_type text;
begin
  if p_user_id is null then
    raise exception 'user_id is required';
  end if;

  if p_credits is null or p_credits <= 0 or p_credits > 100000 then
    raise exception 'credits must be between 1 and 100000';
  end if;

  if p_pool = 'subscription_credits' then
    resolved_credit_type := 'subscription';
  elsif p_pool = 'purchased_credits' then
    resolved_credit_type := 'purchased';
  else
    raise exception 'invalid credit pool';
  end if;

  if p_reason is null or p_reason not like 'stripe:%' or length(p_reason) > 500 then
    raise exception 'invalid Stripe reason';
  end if;

  if p_plan is not null and p_plan not in ('standard', 'premium', 'ultimate', 'team') then
    raise exception 'invalid plan';
  end if;

  insert into public.credit_transactions (
    user_id,
    amount,
    credit_type,
    reason,
    related_task_id
  )
  values (
    p_user_id,
    p_credits,
    resolved_credit_type,
    p_reason,
    null
  )
  on conflict do nothing;

  get diagnostics inserted_rows = row_count;

  if inserted_rows = 0 then
    return jsonb_build_object(
      'ok', true,
      'skipped', 'duplicate',
      'reason', p_reason
    );
  end if;

  if p_pool = 'subscription_credits' then
    insert into public.credit_balances (
      user_id,
      free_credits,
      subscription_credits,
      purchased_credits,
      subscription_expires_at,
      updated_at
    )
    values (
      p_user_id,
      0,
      p_credits,
      0,
      p_expires_at,
      now()
    )
    on conflict (user_id) do update
    set
      subscription_credits = public.credit_balances.subscription_credits + excluded.subscription_credits,
      subscription_expires_at = case
        when excluded.subscription_expires_at is null then public.credit_balances.subscription_expires_at
        when public.credit_balances.subscription_expires_at is null then excluded.subscription_expires_at
        else greatest(public.credit_balances.subscription_expires_at, excluded.subscription_expires_at)
      end,
      updated_at = now();
  else
    insert into public.credit_balances (
      user_id,
      free_credits,
      subscription_credits,
      purchased_credits,
      purchased_expires_at,
      updated_at
    )
    values (
      p_user_id,
      0,
      0,
      p_credits,
      p_expires_at,
      now()
    )
    on conflict (user_id) do update
    set
      purchased_credits = public.credit_balances.purchased_credits + excluded.purchased_credits,
      purchased_expires_at = case
        when excluded.purchased_expires_at is null then public.credit_balances.purchased_expires_at
        when public.credit_balances.purchased_expires_at is null then excluded.purchased_expires_at
        else greatest(public.credit_balances.purchased_expires_at, excluded.purchased_expires_at)
      end,
      updated_at = now();
  end if;

  if p_plan is not null then
    update public.profiles
    set plan = p_plan
    where id = p_user_id;

    if not found then
      raise exception 'profile not found';
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'granted', p_credits,
    'pool', p_pool,
    'reason', p_reason
  );
end;
$$;

revoke execute on function public.grant_stripe_credits_atomic(
  uuid,
  integer,
  text,
  text,
  timestamptz,
  text
) from public, anon, authenticated;

grant execute on function public.grant_stripe_credits_atomic(
  uuid,
  integer,
  text,
  text,
  timestamptz,
  text
) to service_role;
