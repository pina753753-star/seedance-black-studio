-- Serialize Stripe risk-event handling with credit-grant ledger transitions.
--
-- The original Step 2 RPC inserted payment_risk_events before attempting to
-- update/lock the matching stripe_payment_ledger row. Under READ COMMITTED,
-- a concurrent credit-grant transaction that already held the ledger lock
-- could not see that uncommitted risk row and could grant before the risk
-- transaction resumed.
--
-- Lock every matching ledger row first, in deterministic id order, then
-- record the risk event and move matching pending/granted ledgers to held.
-- This gives risk handling and credit granting the same serialization point.

begin;

create or replace function public.record_payment_risk_event_atomic(
  p_stripe_event_id text,
  p_stripe_event_type text,
  p_stripe_object_id text,
  p_event_type text,
  p_charge_id text default null,
  p_payment_intent_id text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_other_user_exists boolean := false;
  v_inserted integer := 0;
  v_held integer := 0;
begin
  if p_stripe_event_id is null or p_stripe_object_id is null then
    raise exception 'Stripe event id and object id are required';
  end if;

  if p_event_type not in ('dispute', 'early_fraud_warning', 'review') then
    raise exception 'Invalid risk event type';
  end if;

  -- IMPORTANT:
  -- Lock all matching ledger rows BEFORE inserting the risk event.
  --
  -- grant_stripe_credits_with_ledger_atomic() also serializes on the ledger
  -- row with FOR UPDATE. Whichever transaction obtains that ledger lock first
  -- completes first; the other then observes the committed result.
  --
  -- ORDER BY id gives a deterministic lock order when more than one ledger
  -- row matches the same Stripe identifier.
  perform 1
  from public.stripe_payment_ledger l
  where (
    (p_charge_id is not null and l.charge_id = p_charge_id)
    or
    (p_payment_intent_id is not null
      and l.payment_intent_id = p_payment_intent_id)
  )
  order by l.id
  for update;

  insert into public.payment_risk_events (
    stripe_event_id,
    stripe_event_type,
    stripe_object_id,
    event_type,
    charge_id,
    payment_intent_id,
    reason
  )
  values (
    p_stripe_event_id,
    p_stripe_event_type,
    p_stripe_object_id,
    p_event_type,
    p_charge_id,
    p_payment_intent_id,
    p_reason
  )
  on conflict (stripe_event_id) do nothing;

  get diagnostics v_inserted = row_count;

  select l.user_id
  into v_user_id
  from public.stripe_payment_ledger l
  where (
    (p_charge_id is not null and l.charge_id = p_charge_id)
    or
    (p_payment_intent_id is not null
      and l.payment_intent_id = p_payment_intent_id)
  )
  and l.user_id is not null
  order by l.id
  limit 1;

  if v_user_id is not null then
    select exists (
      select 1
      from public.stripe_payment_ledger l
      where (
        (p_charge_id is not null and l.charge_id = p_charge_id)
        or
        (p_payment_intent_id is not null
          and l.payment_intent_id = p_payment_intent_id)
      )
      and l.user_id is not null
      and l.user_id <> v_user_id
    )
    into v_other_user_exists;

    if v_other_user_exists then
      raise exception 'Risk event matched payment ledgers belonging to different users';
    end if;
  end if;

  update public.stripe_payment_ledger
  set
    grant_status = 'held',
    updated_at = now()
  where (
    (p_charge_id is not null and charge_id = p_charge_id)
    or
    (p_payment_intent_id is not null
      and payment_intent_id = p_payment_intent_id)
  )
  and grant_status in ('pending', 'granted');

  get diagnostics v_held = row_count;

  update public.payment_risk_events
  set
    user_id = coalesce(user_id, v_user_id),
    updated_at = now()
  where stripe_event_id = p_stripe_event_id;

  return jsonb_build_object(
    'ok', true,
    'code', case when v_inserted = 1 then 'recorded' else 'duplicate' end,
    'userId', v_user_id,
    'held', v_held
  );
end;
$$;

revoke all on function public.record_payment_risk_event_atomic(
  text, text, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.record_payment_risk_event_atomic(
  text, text, text, text, text, text, text
) to service_role;

commit;
