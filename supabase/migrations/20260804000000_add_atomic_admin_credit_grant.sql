begin;

create schema if not exists private;

create table if not exists private.admin_credit_grants (
  request_id uuid primary key,
  admin_user_id uuid not null references public.profiles(id),
  target_user_id uuid not null references public.profiles(id),
  amount integer not null check (amount between 1 and 10000),
  reason text not null check (char_length(btrim(reason)) between 2 and 200),
  balance_before integer not null check (balance_before >= 0),
  balance_after integer not null check (balance_after >= balance_before),
  created_at timestamptz not null default now()
);

alter table private.admin_credit_grants enable row level security;
revoke all on table private.admin_credit_grants from public, anon, authenticated, service_role;

create index if not exists admin_credit_grants_admin_user_id_idx
  on private.admin_credit_grants (admin_user_id);

create index if not exists admin_credit_grants_target_user_id_idx
  on private.admin_credit_grants (target_user_id);

create or replace function public.grant_admin_free_credits_atomic(
  p_request_id uuid,
  p_admin_user_id uuid,
  p_target_user_id uuid,
  p_amount integer,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_role text;
  v_target_email text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_balance_before integer;
  v_balance_after integer;
  v_inserted integer := 0;
  v_existing private.admin_credit_grants%rowtype;
begin
  if p_request_id is null or p_admin_user_id is null or p_target_user_id is null then
    raise exception 'required identifier is missing';
  end if;

  if p_amount is null or p_amount < 1 or p_amount > 10000 then
    raise exception 'amount must be between 1 and 10000';
  end if;

  if char_length(v_reason) < 2 or char_length(v_reason) > 200 then
    raise exception 'reason must be between 2 and 200 characters';
  end if;

  select role
    into v_admin_role
    from public.profiles
   where id = p_admin_user_id;

  if v_admin_role is distinct from 'admin' then
    raise exception 'admin authorization failed';
  end if;

  select email
    into v_target_email
    from public.profiles
   where id = p_target_user_id;

  if v_target_email is null then
    raise exception 'target profile not found';
  end if;

  select free_credits
    into v_balance_before
    from public.credit_balances
   where user_id = p_target_user_id
   for update;

  if not found then
    raise exception 'target credit balance not found';
  end if;

  insert into private.admin_credit_grants (
    request_id,
    admin_user_id,
    target_user_id,
    amount,
    reason,
    balance_before,
    balance_after
  )
  values (
    p_request_id,
    p_admin_user_id,
    p_target_user_id,
    p_amount,
    v_reason,
    v_balance_before,
    v_balance_before + p_amount
  )
  on conflict (request_id) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select *
      into v_existing
      from private.admin_credit_grants
     where request_id = p_request_id;

    if v_existing.admin_user_id <> p_admin_user_id
       or v_existing.target_user_id <> p_target_user_id
       or v_existing.amount <> p_amount
       or v_existing.reason <> v_reason then
      raise exception 'request id was already used with different details';
    end if;

    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'requestId', v_existing.request_id,
      'targetUserId', v_existing.target_user_id,
      'amount', v_existing.amount,
      'balanceBefore', v_existing.balance_before,
      'balanceAfter', v_existing.balance_after,
      'createdAt', v_existing.created_at
    );
  end if;

  v_balance_after := v_balance_before + p_amount;

  update public.credit_balances
     set free_credits = v_balance_after,
         updated_at = now()
   where user_id = p_target_user_id;

  insert into public.credit_transactions (
    user_id,
    amount,
    credit_type,
    reason,
    related_task_id
  )
  values (
    p_target_user_id,
    p_amount,
    'free',
    'admin_manual_grant:' || p_request_id::text,
    null
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'requestId', p_request_id,
    'targetUserId', p_target_user_id,
    'targetEmail', v_target_email,
    'amount', p_amount,
    'balanceBefore', v_balance_before,
    'balanceAfter', v_balance_after,
    'createdAt', now()
  );
end;
$$;

revoke all on function public.grant_admin_free_credits_atomic(
  uuid,
  uuid,
  uuid,
  integer,
  text
) from public, anon, authenticated, service_role;

grant execute on function public.grant_admin_free_credits_atomic(
  uuid,
  uuid,
  uuid,
  integer,
  text
) to service_role;

commit;
