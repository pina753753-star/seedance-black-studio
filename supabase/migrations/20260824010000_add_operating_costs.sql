-- Pina Studio
-- Operating costs (Phase 2 of admin finance): planned vs. actual expense tracking.
--
-- Safety:
-- - Independent from Stripe revenue aggregation (api/admin-finance.js is not touched).
-- - Stripe fees are intentionally NOT recorded here: Phase 1's "net" already
--   subtracts Stripe fees, so adding them here would double-count them.
-- - private.operating_costs / private.operating_cost_payments are never
--   readable/writable directly by anon or authenticated (or even service_role
--   at the table level) - all access goes through SECURITY DEFINER RPCs.
-- - operating_costs is never physically deleted; a stopped contract is
--   recorded via is_active = false.
-- - operating_cost_payments is never physically deleted; a mistaken entry is
--   recorded via is_voided = true with a void_reason (history is kept).
-- - No real amounts are seeded by this migration. Service candidates are not
--   hardcoded/auto-inserted; admins enter them later through the UI.

begin;

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- =========================================================
-- Operating cost contracts (the "planned" side)
-- =========================================================

create table if not exists private.operating_costs (
  id uuid primary key default extensions.gen_random_uuid(),

  service_name text not null,
  category text not null,

  amount_minor bigint not null,
  currency text not null,
  billing_cycle text not null,
  amount_is_estimate boolean not null default false,

  next_billing_date date null,

  is_active boolean not null default true,
  notes text not null default '',

  created_by uuid not null
    references public.profiles(id)
    on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint operating_costs_service_name_length_check
    check (char_length(btrim(service_name)) between 1 and 120),

  constraint operating_costs_category_length_check
    check (char_length(btrim(category)) between 1 and 60),

  constraint operating_costs_amount_minor_check
    check (amount_minor >= 0),

  constraint operating_costs_currency_check
    check (currency in ('USD', 'JPY')),

  constraint operating_costs_billing_cycle_check
    check (billing_cycle in ('monthly', 'yearly', 'usage', 'one_time')),

  constraint operating_costs_notes_length_check
    check (char_length(notes) <= 2000)
);

create index if not exists operating_costs_active_service_idx
  on private.operating_costs (is_active, service_name);

-- =========================================================
-- Operating cost payments (the "actual" side)
-- =========================================================

create table if not exists private.operating_cost_payments (
  id uuid primary key default extensions.gen_random_uuid(),

  operating_cost_id uuid not null
    references private.operating_costs(id)
    on delete restrict,

  paid_at date not null,

  amount_minor bigint not null,
  currency text not null,

  -- JPY-normalized amount used for cross-currency reporting.
  amount_jpy bigint not null,
  fx_rate numeric(18, 8) not null,
  fx_rate_date date null,
  fx_rate_source text null,

  -- 'auto' = server-fetched Frankfurter rate at entry time.
  -- 'manual_actual' = admin typed the real JPY-billed amount (e.g. card
  -- statement), which is trusted over any automatic conversion.
  conversion_method text not null,

  reference text null,
  notes text not null default '',

  created_by uuid not null
    references public.profiles(id)
    on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  is_voided boolean not null default false,
  void_reason text null,

  constraint operating_cost_payments_amount_minor_check
    check (amount_minor > 0),

  constraint operating_cost_payments_currency_check
    check (currency in ('USD', 'JPY')),

  constraint operating_cost_payments_amount_jpy_check
    check (amount_jpy > 0),

  constraint operating_cost_payments_fx_rate_check
    check (fx_rate > 0),

  constraint operating_cost_payments_conversion_method_check
    check (conversion_method in ('auto', 'manual_actual')),

  -- currency/conversion_method/FX項目間の整合性を、アプリ層のバグにも
  -- 耐えるようDB制約としても強制する(レビュー指摘: 修正3・修正5)。
  -- JPY: 常にauto・fx_rate=1・amount_jpy=amount_minor・
  --      fx_rate_date/fx_rate_sourceはNULL(manual_actualは許可しない)。
  -- USD+auto: Frankfurterのhistorical rateを使うため、
  --      fx_rate_date/fx_rate_sourceは必須('frankfurter')。
  -- USD+manual_actual: 管理者が入力した実額を正本とするため、
  --      fx_rate_date/fx_rate_sourceはNULL(自動取得はしていない)。
  constraint operating_cost_payments_fx_consistency_check
    check (
      (
        currency = 'JPY'
        and conversion_method = 'auto'
        and amount_jpy = amount_minor
        and fx_rate = 1
        and fx_rate_date is null
        and fx_rate_source is null
      )
      or (
        currency = 'USD'
        and conversion_method = 'auto'
        and fx_rate_date is not null
        and fx_rate_source = 'frankfurter'
      )
      or (
        currency = 'USD'
        and conversion_method = 'manual_actual'
        and fx_rate_date is null
        and fx_rate_source is null
      )
    ),

  constraint operating_cost_payments_reference_length_check
    check (reference is null or char_length(reference) <= 200),

  constraint operating_cost_payments_notes_length_check
    check (char_length(notes) <= 2000),

  constraint operating_cost_payments_void_reason_check
    check (
      (is_voided is false and void_reason is null)
      or (is_voided is true and char_length(btrim(coalesce(void_reason, ''))) between 2 and 200)
    )
);

create index if not exists operating_cost_payments_cost_paid_idx
  on private.operating_cost_payments (operating_cost_id, paid_at desc);

create index if not exists operating_cost_payments_paid_at_idx
  on private.operating_cost_payments (paid_at desc)
  where is_voided is false;

-- =========================================================
-- Lock down internal tables
-- =========================================================

alter table private.operating_costs enable row level security;
alter table private.operating_cost_payments enable row level security;

revoke all
  on table private.operating_costs
  from public, anon, authenticated, service_role;

revoke all
  on table private.operating_cost_payments
  from public, anon, authenticated, service_role;

-- =========================================================
-- Shared admin-authorization helper
--
-- All operating-cost RPCs receive p_admin_user_id from the Vercel API,
-- which has already authenticated the caller (requireConfirmedAuth) and
-- checked ADMIN_EMAIL before invoking this RPC. This helper re-checks
-- profiles.role = 'admin' for that id inside the DB as a second,
-- independent layer (defense in depth against an API-layer bug).
--
-- auth.uid() is also checked when it is available. In production, calls
-- arrive through the service_role key (see api/_lib/confirmed-auth.js),
-- under which PostgREST/Postgres has no end-user JWT context and
-- auth.uid() is NULL - so this half of the check is a no-op today, but it
-- fails closed (rather than silently trusting a mismatched caller) should
-- this RPC ever be invoked in a context where auth.uid() is populated.
-- =========================================================

create or replace function private.assert_operating_cost_admin(
  p_admin_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_admin_user_id is null then
    raise exception 'admin authorization failed';
  end if;

  if auth.uid() is not null and auth.uid() <> p_admin_user_id then
    raise exception 'admin authorization failed';
  end if;

  if not exists (
    select 1
      from public.profiles
     where id = p_admin_user_id
       and role = 'admin'
  ) then
    raise exception 'admin authorization failed';
  end if;
end;
$function$;

revoke all
  on function private.assert_operating_cost_admin(uuid)
  from public, anon, authenticated, service_role;

-- =========================================================
-- RPC: create operating cost
-- =========================================================

create or replace function public.admin_create_operating_cost(
  p_admin_user_id uuid,
  p_service_name text,
  p_category text,
  p_amount_minor bigint,
  p_currency text,
  p_billing_cycle text,
  p_amount_is_estimate boolean,
  p_next_billing_date date,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_name text := btrim(coalesce(p_service_name, ''));
  v_category text := btrim(coalesce(p_category, ''));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_billing_cycle text := lower(btrim(coalesce(p_billing_cycle, '')));
  v_notes text := coalesce(p_notes, '');
  v_row private.operating_costs%rowtype;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  if char_length(v_service_name) < 1 or char_length(v_service_name) > 120 then
    raise exception 'invalid service name';
  end if;

  if char_length(v_category) < 1 or char_length(v_category) > 60 then
    raise exception 'invalid category';
  end if;

  if p_amount_minor is null or p_amount_minor < 0 then
    raise exception 'invalid amount';
  end if;

  if v_currency not in ('USD', 'JPY') then
    raise exception 'invalid currency';
  end if;

  if v_billing_cycle not in ('monthly', 'yearly', 'usage', 'one_time') then
    raise exception 'invalid billing cycle';
  end if;

  insert into private.operating_costs (
    service_name,
    category,
    amount_minor,
    currency,
    billing_cycle,
    amount_is_estimate,
    next_billing_date,
    is_active,
    notes,
    created_by
  )
  values (
    v_service_name,
    v_category,
    p_amount_minor,
    v_currency,
    v_billing_cycle,
    coalesce(p_amount_is_estimate, false),
    p_next_billing_date,
    true,
    v_notes,
    p_admin_user_id
  )
  returning *
    into v_row;

  return jsonb_build_object('ok', true, 'cost', to_jsonb(v_row));
end;
$function$;

revoke all on function public.admin_create_operating_cost(
  uuid, text, text, bigint, text, text, boolean, date, text
) from public, anon, authenticated, service_role;

grant execute on function public.admin_create_operating_cost(
  uuid, text, text, bigint, text, text, boolean, date, text
) to service_role;

-- =========================================================
-- RPC: update operating cost
-- =========================================================

create or replace function public.admin_update_operating_cost(
  p_admin_user_id uuid,
  p_operating_cost_id uuid,
  p_service_name text,
  p_category text,
  p_amount_minor bigint,
  p_currency text,
  p_billing_cycle text,
  p_amount_is_estimate boolean,
  p_next_billing_date date,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_service_name text := btrim(coalesce(p_service_name, ''));
  v_category text := btrim(coalesce(p_category, ''));
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_billing_cycle text := lower(btrim(coalesce(p_billing_cycle, '')));
  v_notes text := coalesce(p_notes, '');
  v_row private.operating_costs%rowtype;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  if p_operating_cost_id is null then
    raise exception 'operating cost id is required';
  end if;

  if char_length(v_service_name) < 1 or char_length(v_service_name) > 120 then
    raise exception 'invalid service name';
  end if;

  if char_length(v_category) < 1 or char_length(v_category) > 60 then
    raise exception 'invalid category';
  end if;

  if p_amount_minor is null or p_amount_minor < 0 then
    raise exception 'invalid amount';
  end if;

  if v_currency not in ('USD', 'JPY') then
    raise exception 'invalid currency';
  end if;

  if v_billing_cycle not in ('monthly', 'yearly', 'usage', 'one_time') then
    raise exception 'invalid billing cycle';
  end if;

  update private.operating_costs
     set service_name = v_service_name,
         category = v_category,
         amount_minor = p_amount_minor,
         currency = v_currency,
         billing_cycle = v_billing_cycle,
         amount_is_estimate = coalesce(p_amount_is_estimate, false),
         next_billing_date = p_next_billing_date,
         notes = v_notes,
         updated_at = now()
   where id = p_operating_cost_id
   returning *
    into v_row;

  if not found then
    raise exception 'operating cost not found';
  end if;

  return jsonb_build_object('ok', true, 'cost', to_jsonb(v_row));
end;
$function$;

revoke all on function public.admin_update_operating_cost(
  uuid, uuid, text, text, bigint, text, text, boolean, date, text
) from public, anon, authenticated, service_role;

grant execute on function public.admin_update_operating_cost(
  uuid, uuid, text, text, bigint, text, text, boolean, date, text
) to service_role;

-- =========================================================
-- RPC: activate/deactivate operating cost (no physical delete)
-- =========================================================

create or replace function public.admin_set_operating_cost_active(
  p_admin_user_id uuid,
  p_operating_cost_id uuid,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_row private.operating_costs%rowtype;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  if p_operating_cost_id is null or p_is_active is null then
    raise exception 'invalid payload';
  end if;

  update private.operating_costs
     set is_active = p_is_active,
         updated_at = now()
   where id = p_operating_cost_id
   returning *
    into v_row;

  if not found then
    raise exception 'operating cost not found';
  end if;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'isActive', v_row.is_active);
end;
$function$;

revoke all on function public.admin_set_operating_cost_active(
  uuid, uuid, boolean
) from public, anon, authenticated, service_role;

grant execute on function public.admin_set_operating_cost_active(
  uuid, uuid, boolean
) to service_role;

-- =========================================================
-- RPC: list operating costs
-- =========================================================

create or replace function public.admin_list_operating_costs(
  p_admin_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_costs jsonb;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  select coalesce(
    jsonb_agg(to_jsonb(c) order by c.is_active desc, c.service_name asc),
    '[]'::jsonb
  )
  into v_costs
  from private.operating_costs c;

  return jsonb_build_object('ok', true, 'costs', v_costs);
end;
$function$;

revoke all on function public.admin_list_operating_costs(
  uuid
) from public, anon, authenticated, service_role;

grant execute on function public.admin_list_operating_costs(
  uuid
) to service_role;

-- =========================================================
-- RPC: create operating cost payment
-- =========================================================

create or replace function public.admin_create_operating_cost_payment(
  p_admin_user_id uuid,
  p_operating_cost_id uuid,
  p_paid_at date,
  p_amount_minor bigint,
  p_currency text,
  p_amount_jpy bigint,
  p_fx_rate numeric,
  p_fx_rate_date date,
  p_fx_rate_source text,
  p_conversion_method text,
  p_reference text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_conversion_method text := lower(btrim(coalesce(p_conversion_method, '')));
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_notes text := coalesce(p_notes, '');
  v_row private.operating_cost_payments%rowtype;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  if p_operating_cost_id is null then
    raise exception 'operating cost id is required';
  end if;

  if not exists (
    select 1 from private.operating_costs where id = p_operating_cost_id
  ) then
    raise exception 'operating cost not found';
  end if;

  if p_paid_at is null then
    raise exception 'paid_at is required';
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'invalid amount';
  end if;

  if v_currency not in ('USD', 'JPY') then
    raise exception 'invalid currency';
  end if;

  if p_amount_jpy is null or p_amount_jpy <= 0 then
    raise exception 'invalid jpy amount';
  end if;

  if p_fx_rate is null or p_fx_rate <= 0 then
    raise exception 'invalid fx rate';
  end if;

  if v_conversion_method not in ('auto', 'manual_actual') then
    raise exception 'invalid conversion method';
  end if;

  -- レビュー指摘(修正3): JPYはmanual_actualを許可しない。常にauto・
  -- fx_rate=1・amount_jpy=amount_minor・fx_rate_date/sourceはNULLを強制する。
  if v_currency = 'JPY' then
    if v_conversion_method <> 'auto' then
      raise exception 'JPY does not support manual_actual conversion';
    end if;
    if p_amount_jpy <> p_amount_minor then
      raise exception 'JPY amount_jpy must equal amount_minor';
    end if;
    if p_fx_rate <> 1 then
      raise exception 'JPY fx_rate must be 1';
    end if;
    if p_fx_rate_date is not null or nullif(btrim(coalesce(p_fx_rate_source, '')), '') is not null then
      raise exception 'JPY must not have fx_rate_date or fx_rate_source';
    end if;
  elsif v_conversion_method = 'auto' then
    -- USD/auto: Frankfurterのhistorical rateを使うため、取得できた実際の
    -- レート日付とsource='frankfurter'が必須。
    if p_fx_rate_date is null then
      raise exception 'auto conversion requires fx_rate_date';
    end if;
    if coalesce(nullif(btrim(coalesce(p_fx_rate_source, '')), ''), '') <> 'frankfurter' then
      raise exception 'auto conversion requires fx_rate_source = frankfurter';
    end if;
  elsif v_conversion_method = 'manual_actual' then
    -- USD/manual_actual: 自動取得はしていないため、fx_rate_date/sourceは
    -- 必ずNULLにする(ブラウザ側の自動計算レートを正本として保存しない)。
    if p_fx_rate_date is not null or nullif(btrim(coalesce(p_fx_rate_source, '')), '') is not null then
      raise exception 'manual_actual must not have fx_rate_date or fx_rate_source';
    end if;
  end if;

  insert into private.operating_cost_payments (
    operating_cost_id,
    paid_at,
    amount_minor,
    currency,
    amount_jpy,
    fx_rate,
    fx_rate_date,
    fx_rate_source,
    conversion_method,
    reference,
    notes,
    created_by,
    is_voided
  )
  values (
    p_operating_cost_id,
    p_paid_at,
    p_amount_minor,
    v_currency,
    p_amount_jpy,
    p_fx_rate,
    p_fx_rate_date,
    nullif(btrim(coalesce(p_fx_rate_source, '')), ''),
    v_conversion_method,
    v_reference,
    v_notes,
    p_admin_user_id,
    false
  )
  returning *
    into v_row;

  return jsonb_build_object('ok', true, 'payment', to_jsonb(v_row));
end;
$function$;

revoke all on function public.admin_create_operating_cost_payment(
  uuid, uuid, date, bigint, text, bigint, numeric, date, text, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.admin_create_operating_cost_payment(
  uuid, uuid, date, bigint, text, bigint, numeric, date, text, text, text, text
) to service_role;

-- =========================================================
-- RPC: update operating cost payment (voided payments are frozen)
-- =========================================================

create or replace function public.admin_update_operating_cost_payment(
  p_admin_user_id uuid,
  p_payment_id uuid,
  p_operating_cost_id uuid,
  p_paid_at date,
  p_amount_minor bigint,
  p_currency text,
  p_amount_jpy bigint,
  p_fx_rate numeric,
  p_fx_rate_date date,
  p_fx_rate_source text,
  p_conversion_method text,
  p_reference text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_currency text := upper(btrim(coalesce(p_currency, '')));
  v_conversion_method text := lower(btrim(coalesce(p_conversion_method, '')));
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_notes text := coalesce(p_notes, '');
  v_existing private.operating_cost_payments%rowtype;
  v_row private.operating_cost_payments%rowtype;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  if p_payment_id is null then
    raise exception 'payment id is required';
  end if;

  select *
    into v_existing
    from private.operating_cost_payments
   where id = p_payment_id;

  if not found then
    raise exception 'payment not found';
  end if;

  if v_existing.is_voided then
    raise exception 'voided payment cannot be edited';
  end if;

  -- レビュー指摘(修正4): 対象サービスの変更を許可する。無効化済み
  -- (is_active=false)のサービスでも、既存paymentの所属先としては
  -- 引き続き有効(is_activeでの絞り込みはしない)。
  if p_operating_cost_id is null then
    raise exception 'operating cost id is required';
  end if;

  if not exists (
    select 1 from private.operating_costs where id = p_operating_cost_id
  ) then
    raise exception 'operating cost not found';
  end if;

  if p_paid_at is null then
    raise exception 'paid_at is required';
  end if;

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'invalid amount';
  end if;

  if v_currency not in ('USD', 'JPY') then
    raise exception 'invalid currency';
  end if;

  if p_amount_jpy is null or p_amount_jpy <= 0 then
    raise exception 'invalid jpy amount';
  end if;

  if p_fx_rate is null or p_fx_rate <= 0 then
    raise exception 'invalid fx rate';
  end if;

  if v_conversion_method not in ('auto', 'manual_actual') then
    raise exception 'invalid conversion method';
  end if;

  -- レビュー指摘(修正3): JPYはmanual_actualを許可しない(create RPCと同じ
  -- 整合性チェックを更新時にも強制する)。
  if v_currency = 'JPY' then
    if v_conversion_method <> 'auto' then
      raise exception 'JPY does not support manual_actual conversion';
    end if;
    if p_amount_jpy <> p_amount_minor then
      raise exception 'JPY amount_jpy must equal amount_minor';
    end if;
    if p_fx_rate <> 1 then
      raise exception 'JPY fx_rate must be 1';
    end if;
    if p_fx_rate_date is not null or nullif(btrim(coalesce(p_fx_rate_source, '')), '') is not null then
      raise exception 'JPY must not have fx_rate_date or fx_rate_source';
    end if;
  elsif v_conversion_method = 'auto' then
    if p_fx_rate_date is null then
      raise exception 'auto conversion requires fx_rate_date';
    end if;
    if coalesce(nullif(btrim(coalesce(p_fx_rate_source, '')), ''), '') <> 'frankfurter' then
      raise exception 'auto conversion requires fx_rate_source = frankfurter';
    end if;
  elsif v_conversion_method = 'manual_actual' then
    if p_fx_rate_date is not null or nullif(btrim(coalesce(p_fx_rate_source, '')), '') is not null then
      raise exception 'manual_actual must not have fx_rate_date or fx_rate_source';
    end if;
  end if;

  update private.operating_cost_payments
     set operating_cost_id = p_operating_cost_id,
         paid_at = p_paid_at,
         amount_minor = p_amount_minor,
         currency = v_currency,
         amount_jpy = p_amount_jpy,
         fx_rate = p_fx_rate,
         fx_rate_date = p_fx_rate_date,
         fx_rate_source = nullif(btrim(coalesce(p_fx_rate_source, '')), ''),
         conversion_method = v_conversion_method,
         reference = v_reference,
         notes = v_notes,
         updated_at = now()
   where id = p_payment_id
   returning *
    into v_row;

  return jsonb_build_object('ok', true, 'payment', to_jsonb(v_row));
end;
$function$;

revoke all on function public.admin_update_operating_cost_payment(
  uuid, uuid, uuid, date, bigint, text, bigint, numeric, date, text, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.admin_update_operating_cost_payment(
  uuid, uuid, uuid, date, bigint, text, bigint, numeric, date, text, text, text, text
) to service_role;

-- =========================================================
-- RPC: void operating cost payment (never a physical delete)
-- =========================================================

create or replace function public.admin_void_operating_cost_payment(
  p_admin_user_id uuid,
  p_payment_id uuid,
  p_void_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reason text := btrim(coalesce(p_void_reason, ''));
  v_row private.operating_cost_payments%rowtype;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  if p_payment_id is null then
    raise exception 'payment id is required';
  end if;

  if char_length(v_reason) < 2 or char_length(v_reason) > 200 then
    raise exception 'invalid void reason';
  end if;

  update private.operating_cost_payments
     set is_voided = true,
         void_reason = v_reason,
         updated_at = now()
   where id = p_payment_id
   returning *
    into v_row;

  if not found then
    raise exception 'payment not found';
  end if;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'isVoided', v_row.is_voided);
end;
$function$;

revoke all on function public.admin_void_operating_cost_payment(
  uuid, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.admin_void_operating_cost_payment(
  uuid, uuid, text
) to service_role;

-- =========================================================
-- RPC: list operating cost payments
-- p_operating_cost_id = null lists payments across all costs (most recent
-- first), otherwise scoped to one cost. Voided payments are included
-- (flagged via isVoided) so history is never hidden, only marked.
-- =========================================================

create or replace function public.admin_list_operating_cost_payments(
  p_admin_user_id uuid,
  p_operating_cost_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_payments jsonb;
begin
  perform private.assert_operating_cost_admin(p_admin_user_id);

  select coalesce(jsonb_agg(row_data order by paid_at desc, created_at desc), '[]'::jsonb)
    into v_payments
    from (
      select to_jsonb(p) as row_data, p.paid_at, p.created_at
        from private.operating_cost_payments p
       where p_operating_cost_id is null
          or p.operating_cost_id = p_operating_cost_id
       order by p.paid_at desc, p.created_at desc
       limit v_limit
    ) ranked;

  return jsonb_build_object('ok', true, 'payments', v_payments);
end;
$function$;

revoke all on function public.admin_list_operating_cost_payments(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;

grant execute on function public.admin_list_operating_cost_payments(
  uuid, uuid, integer
) to service_role;

commit;

-- =========================================================
-- ROLLBACK (do NOT run automatically; not executed by this migration)
--
-- If this needs to be reverted after production apply, run the following
-- in a NEW migration file (never edit an already-applied migration) and
-- in this order, so dependencies drop cleanly:
--   1. RPCs (functions), because they reference the tables/helper below.
--   2. The shared private.assert_operating_cost_admin() helper.
--   3. private.operating_cost_payments (has an FK to operating_costs).
--   4. private.operating_costs.
--
-- begin;
--
-- drop function if exists public.admin_list_operating_cost_payments(uuid, uuid, integer);
-- drop function if exists public.admin_void_operating_cost_payment(uuid, uuid, text);
-- drop function if exists public.admin_update_operating_cost_payment(uuid, uuid, uuid, date, bigint, text, bigint, numeric, date, text, text, text, text);
-- drop function if exists public.admin_create_operating_cost_payment(uuid, uuid, date, bigint, text, bigint, numeric, date, text, text, text, text);
-- drop function if exists public.admin_list_operating_costs(uuid);
-- drop function if exists public.admin_set_operating_cost_active(uuid, uuid, boolean);
-- drop function if exists public.admin_update_operating_cost(uuid, uuid, text, text, bigint, text, text, boolean, date, text);
-- drop function if exists public.admin_create_operating_cost(uuid, text, text, bigint, text, text, boolean, date, text);
--
-- drop function if exists private.assert_operating_cost_admin(uuid);
--
-- drop table if exists private.operating_cost_payments;
-- drop table if exists private.operating_costs;
--
-- commit;
--
-- Note: this does not touch `private` schema itself (shared with
-- invite_codes/credit_grants/etc.), pgcrypto extension, or any other
-- feature's tables/functions - only the objects created by this migration.
-- =========================================================
