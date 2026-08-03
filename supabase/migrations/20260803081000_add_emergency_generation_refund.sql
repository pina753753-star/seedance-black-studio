begin;

create or replace function public.refund_unsent_generation_task_atomic(
  p_task_id uuid,
  p_user_id uuid,
  p_from_subscription integer,
  p_from_free integer,
  p_from_purchased integer,
  p_error_message text default 'Generation stopped before provider submission'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task_user_id uuid;
  v_task_status text;
  v_credit_cost integer;
  v_api_task_id text;
  v_balance_user_id uuid;
  v_existing_sub integer := 0;
  v_existing_free integer := 0;
  v_existing_purchased integer := 0;
  v_has_existing_refund boolean := false;
begin
  if p_from_subscription is null or p_from_free is null or p_from_purchased is null then
    raise exception 'missing_refund_amount'
      using errcode = 'null_value_not_allowed';
  end if;

  if p_from_subscription < 0 or p_from_free < 0 or p_from_purchased < 0 then
    raise exception 'negative_refund_amount'
      using errcode = 'check_violation';
  end if;

  if p_from_subscription + p_from_free + p_from_purchased <= 0 then
    raise exception 'empty_refund_amount'
      using errcode = 'check_violation';
  end if;

  select user_id, status, credit_cost, api_task_id
    into v_task_user_id, v_task_status, v_credit_cost, v_api_task_id
    from public.generation_tasks
   where id = p_task_id
   for update;

  if v_task_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'task_not_found');
  end if;

  if v_task_user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'task_owner_mismatch');
  end if;

  if v_task_status = 'completed' then
    return jsonb_build_object('ok', false, 'code', 'completed_task');
  end if;

  if v_api_task_id is not null then
    return jsonb_build_object('ok', false, 'code', 'provider_submission_recorded');
  end if;

  if p_from_subscription + p_from_free + p_from_purchased <> v_credit_cost then
    raise exception 'refund_amount_mismatch'
      using errcode = 'check_violation';
  end if;

  select
    count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then amount else 0 end), 0),
    coalesce(sum(case when credit_type = 'free' then amount else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased' then amount else 0 end), 0)
    into v_has_existing_refund, v_existing_sub, v_existing_free, v_existing_purchased
    from public.credit_transactions
   where related_task_id = p_task_id
     and reason = 'generation_refund'
     and amount > 0;

  if v_has_existing_refund then
    if v_existing_sub <> p_from_subscription
       or v_existing_free <> p_from_free
       or v_existing_purchased <> p_from_purchased then
      raise exception 'refund_state_inconsistent'
        using errcode = 'data_exception';
    end if;

    update public.generation_tasks
       set status = 'failed',
           error_message = coalesce(error_message, p_error_message),
           updated_at = now()
     where id = p_task_id
       and status not in ('completed', 'failed', 'cancelled');

    return jsonb_build_object(
      'ok', true,
      'refunded', false,
      'already_refunded', true,
      'code', 'already_refunded'
    );
  end if;

  if v_task_status <> 'queued' then
    return jsonb_build_object('ok', false, 'code', 'task_not_refundable');
  end if;

  select user_id
    into v_balance_user_id
    from public.credit_balances
   where user_id = p_user_id
   for update;

  if v_balance_user_id is null then
    raise exception 'balance_not_found'
      using errcode = 'no_data_found';
  end if;

  if p_from_subscription > 0 then
    insert into public.credit_transactions
      (user_id, amount, credit_type, reason, related_task_id)
    values
      (p_user_id, p_from_subscription, 'subscription', 'generation_refund', p_task_id);
  end if;

  if p_from_free > 0 then
    insert into public.credit_transactions
      (user_id, amount, credit_type, reason, related_task_id)
    values
      (p_user_id, p_from_free, 'free', 'generation_refund', p_task_id);
  end if;

  if p_from_purchased > 0 then
    insert into public.credit_transactions
      (user_id, amount, credit_type, reason, related_task_id)
    values
      (p_user_id, p_from_purchased, 'purchased', 'generation_refund', p_task_id);
  end if;

  update public.credit_balances
     set subscription_credits = subscription_credits + p_from_subscription,
         free_credits = free_credits + p_from_free,
         purchased_credits = purchased_credits + p_from_purchased,
         updated_at = now()
   where user_id = p_user_id;

  update public.generation_tasks
     set status = 'failed',
         error_message = p_error_message,
         updated_at = now()
   where id = p_task_id
     and status = 'queued';

  return jsonb_build_object(
    'ok', true,
    'refunded', true,
    'already_refunded', false,
    'code', 'refunded'
  );
end;
$$;

revoke all on function public.refund_unsent_generation_task_atomic(
  uuid, uuid, integer, integer, integer, text
) from public, anon, authenticated, service_role;

grant execute on function public.refund_unsent_generation_task_atomic(
  uuid, uuid, integer, integer, integer, text
) to service_role;

commit;
