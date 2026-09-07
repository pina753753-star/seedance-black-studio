-- Chargeback / fraud countermeasure — atomic ledger transitions.
--
-- Step 2 (webhook code) wrote stripe_payment_ledger / payment_risk_events
-- updates as separate JS-side read/update calls. This migration moves the
-- credit-grant-and-ledger-confirm sequence, and the risk-event-record-and-
-- ledger-hold sequence, into single Postgres functions so they run as one
-- transaction each (no window where credits are granted but the ledger
-- still says 'pending', and no window where a risk event is recorded but
-- a concurrent grant slips past the hold).
--
-- This migration does NOT change public.grant_stripe_credits_atomic itself
-- (the existing, already-hardened credit-grant RPC) — it is called from
-- inside the new grant_stripe_credits_with_ledger_atomic function.

begin;

-- payment_intent-only review events (no charge_id yet) also need to be
-- matched back to a payment ledger row.
alter table public.payment_risk_events
  add column if not exists payment_intent_id text;

create index if not exists payment_risk_events_payment_intent_id_idx
  on public.payment_risk_events (payment_intent_id)
  where payment_intent_id is not null;

-- Track whether a ledger row's payment_intent_id/charge_id back-fill
-- (from the Stripe invoice/payment_intent lookup) succeeded, so a failure
-- is not silently lost in a console.error only.
alter table public.stripe_payment_ledger
  add column if not exists id_enrichment_status text not null default 'pending',
  add column if not exists id_enrichment_error text;

alter table public.stripe_payment_ledger
  drop constraint if exists stripe_payment_ledger_id_enrichment_status_check;

alter table public.stripe_payment_ledger
  add constraint stripe_payment_ledger_id_enrichment_status_check
  check (id_enrichment_status in ('pending', 'complete', 'needs_review'));

create index if not exists stripe_payment_ledger_enrichment_pending_idx
  on public.stripe_payment_ledger (updated_at)
  where id_enrichment_status in ('pending', 'needs_review');

-- ────────────────────────────────────────────────────────────────
-- record_payment_risk_event_atomic: insert the risk event and hold any
-- matching ledger row(s) in the same transaction. Moves both 'pending'
-- and 'granted' ledger rows to 'held' (a dispute/fraud signal on a payment
-- whose credits have not been granted yet must still block the grant).
-- ────────────────────────────────────────────────────────────────
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
  where
    (p_charge_id is not null and l.charge_id = p_charge_id)
    or
    (p_payment_intent_id is not null
      and l.payment_intent_id = p_payment_intent_id)
  and l.user_id is not null
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

-- ────────────────────────────────────────────────────────────────
-- grant_stripe_credits_with_ledger_atomic: lock the ledger row, re-check
-- for an open/reviewing risk event (in case one raced ahead of the grant
-- between the webhook reading the ledger and this call), grant credits via
-- the existing grant_stripe_credits_atomic RPC, and flip the ledger row to
-- 'granted' — all inside one transaction.
-- ────────────────────────────────────────────────────────────────
create or replace function public.grant_stripe_credits_with_ledger_atomic(
  p_ledger_id uuid,
  p_user_id uuid,
  p_credits integer,
  p_pool text,
  p_reason text,
  p_expires_at timestamptz,
  p_plan text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ledger public.stripe_payment_ledger%rowtype;
  v_has_risk boolean := false;
  v_grant_result jsonb;
  v_updated integer := 0;
begin
  select *
  into v_ledger
  from public.stripe_payment_ledger
  where id = p_ledger_id
  for update;

  if not found then
    raise exception 'Payment ledger row not found';
  end if;

  if v_ledger.user_id is distinct from p_user_id then
    raise exception 'Payment ledger user mismatch';
  end if;

  if v_ledger.grant_status in ('held', 'reversed') then
    return jsonb_build_object(
      'ok', true,
      'skipped', 'payment-risk-held',
      'ledgerStatus', v_ledger.grant_status
    );
  end if;

  select exists (
    select 1
    from public.payment_risk_events r
    where r.status in ('open', 'reviewing')
      and (
        (v_ledger.charge_id is not null
          and r.charge_id = v_ledger.charge_id)
        or
        (v_ledger.payment_intent_id is not null
          and r.payment_intent_id = v_ledger.payment_intent_id)
      )
  )
  into v_has_risk;

  if v_has_risk then
    update public.stripe_payment_ledger
    set
      grant_status = 'held',
      updated_at = now()
    where id = p_ledger_id
      and grant_status in ('pending', 'granted');

    return jsonb_build_object(
      'ok', true,
      'skipped', 'payment-risk-held',
      'ledgerStatus', 'held'
    );
  end if;

  v_grant_result := public.grant_stripe_credits_atomic(
    p_user_id,
    p_credits,
    p_pool,
    p_reason,
    p_expires_at,
    p_plan
  );

  update public.stripe_payment_ledger
  set
    grant_status = 'granted',
    credits_granted = p_credits,
    updated_at = now()
  where id = p_ledger_id
    and grant_status = 'pending';

  get diagnostics v_updated = row_count;

  if v_updated = 0 and v_ledger.grant_status <> 'granted' then
    raise exception 'Payment ledger state transition failed';
  end if;

  return v_grant_result || jsonb_build_object(
    'ledgerId', p_ledger_id,
    'ledgerStatus', 'granted'
  );
end;
$$;

revoke all on function public.grant_stripe_credits_with_ledger_atomic(
  uuid, uuid, integer, text, text, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.grant_stripe_credits_with_ledger_atomic(
  uuid, uuid, integer, text, text, timestamptz, text
) to service_role;

commit;
