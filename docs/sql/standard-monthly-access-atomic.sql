-- LOCAL REVIEW DRAFT ONLY; NOT APPLIED.
-- Prerequisite: basic-credit-access-atomic.sql's purchase-risk helper and debit.
-- Install this RPC before deploying the Standard entitlement change. The new
-- application fails closed if it is missing; never fall back to the old debit.
-- No schema, price, balance, refund or existing debit implementation changes.
begin;

create or replace function public.deduct_standard_generation_credits_atomic(
  p_task_id uuid,
  p_user_id uuid,
  p_credit_cost integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task public.generation_tasks%rowtype;
  v_balance public.credit_balances%rowtype;
  v_purchase_error text;
  v_nonpurchase integer;
begin
  -- Same order as existing debit: task -> ordered payment ledger -> balance.
  select * into v_task from public.generation_tasks
   where id = p_task_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'task_not_found');
  end if;
  if v_task.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'task_owner_mismatch');
  end if;
  if v_task.status <> 'queued' or v_task.api_task_id is not null then
    return jsonb_build_object('ok', false, 'code', 'task_not_chargeable');
  end if;
  if v_task.settings->>'standard_subscription_access' is distinct from 'true'
     or v_task.settings->>'purchase_access_required' is distinct from 'false' then
    return jsonb_build_object('ok', false, 'code', 'subscription_access_required');
  end if;

  -- Preserve the original idempotent replay, ownership, cost/provider checks
  -- and per-pool accounting. Already charged work must not be charged again
  -- or lose its recovery path when entitlement/risk changes afterwards.
  if exists (select 1 from public.credit_transactions
      where related_task_id = p_task_id and reason = 'video_generation' and amount < 0) then
    return public.deduct_generation_credits_atomic(p_task_id, p_user_id, p_credit_cost);
  end if;

  -- Retains ledger locks until the enclosing transaction completes, even when
  -- a hold is found. A hold excludes purchased spending, not valid monthly funds.
  v_purchase_error := public.check_purchase_credit_access_locked(p_user_id);
  select * into v_balance from public.credit_balances
   where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'balance_not_found');
  end if;
  if not exists (select 1 from public.profiles
      where id = p_user_id and coalesce(account_status, 'active') = 'active') then
    return jsonb_build_object('ok', false, 'code', 'account_restricted');
  end if;
  if v_balance.subscription_expires_at is null
     or v_balance.subscription_expires_at <= now()
     or not exists (select 1 from public.profiles where id = p_user_id and lower(btrim(coalesce(plan, ''))) = 'standard') then
    return jsonb_build_object('ok', false, 'code', 'subscription_access_revoked');
  end if;

  v_nonpurchase := coalesce(v_balance.subscription_credits, 0) + coalesce(v_balance.free_credits, 0);
  if v_purchase_error is not null and p_credit_cost > v_nonpurchase then
    return jsonb_build_object('ok', false, 'code', v_purchase_error,
      'balance', v_nonpurchase, 'required', p_credit_cost);
  end if;
  -- With the balance locked, the unchanged subscription -> free -> purchased
  -- debit cannot spill into held/reversed/unproven purchased funds. It writes
  -- the same ledger rows consumed by existing failure/refund/reversal handlers.
  return public.deduct_generation_credits_atomic(p_task_id, p_user_id, p_credit_cost);
end;
$$;

revoke all on function public.deduct_standard_generation_credits_atomic(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.deduct_standard_generation_credits_atomic(uuid, uuid, integer) to service_role;
commit;
