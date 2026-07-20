-- FlowVid Studio
-- 新規登録者向け無料クレジット付与キャンペーン
--
-- 目的:
-- - このマイグレーション適用後に登録した最初の10人へ
--   100 free_creditsを自動付与する
-- - 11人目以降は従来どおり0クレジットで開始する
-- - max_grants、credits_per_user、enabled、期間は
--   private.signup_credit_campaignsの設定変更だけで調整可能にする
-- - 設定行をFOR UPDATEで排他ロックし、同時登録時の上限超過を防ぐ
-- - キャンペーン処理だけで障害が起きた場合は、
--   新規登録を止めず0クレジットで登録を継続する
-- - 既存の年齢確認、profiles作成、年齢確認台帳保存は維持する

begin;

create extension if not exists pgcrypto;

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create table if not exists private.signup_credit_campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_key text not null unique,
  enabled boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz null,
  max_grants integer not null
    constraint signup_credit_campaigns_max_grants_check
    check (max_grants >= 0),
  credits_per_user integer not null
    constraint signup_credit_campaigns_credits_per_user_check
    check (credits_per_user >= 0),
  granted_count integer not null default 0
    constraint signup_credit_campaigns_granted_count_check
    check (granted_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signup_credit_campaigns_granted_not_over_limit_check
    check (granted_count <= max_grants)
);

create table if not exists private.signup_credit_grants (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null
    references private.signup_credit_campaigns(id)
    on delete restrict,
  user_id uuid not null
    references auth.users(id)
    on delete cascade,
  credits integer not null
    constraint signup_credit_grants_credits_check
    check (credits > 0),
  granted_at timestamptz not null default now(),
  constraint signup_credit_grants_campaign_user_unique
    unique (campaign_id, user_id)
);

alter table private.signup_credit_campaigns
  enable row level security;

alter table private.signup_credit_grants
  enable row level security;

revoke all
  on table private.signup_credit_campaigns
  from public, anon, authenticated;

revoke all
  on table private.signup_credit_grants
  from public, anon, authenticated;

grant usage
  on schema private
  to service_role;

grant select, insert, update, delete
  on table private.signup_credit_campaigns
  to service_role;

grant select, insert, update, delete
  on table private.signup_credit_grants
  to service_role;

insert into private.signup_credit_campaigns (
  campaign_key,
  enabled,
  starts_at,
  ends_at,
  max_grants,
  credits_per_user,
  granted_count
)
values (
  'signup_free_credit_v1',
  true,
  now(),
  null,
  10,
  100,
  0
)
on conflict (campaign_key) do nothing;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_catalog
as $function$
declare
  birth_date_text text;
  parsed_birth_date date;
  verification_date date;
  adult_cutoff date;

  signup_campaign private.signup_credit_campaigns%rowtype;
  initial_free_credits integer := 0;
  balance_rows_inserted integer := 0;
  grant_rows_inserted integer := 0;
  campaign_processing_succeeded boolean := false;
begin
  verification_date :=
    (current_timestamp at time zone 'Asia/Tokyo')::date;

  birth_date_text :=
    new.raw_user_meta_data ->> 'birth_date';

  if birth_date_text is null
     or btrim(birth_date_text) = ''
     or birth_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  then
    raise exception using
      errcode = 'P0001',
      message = 'Age verification failed.';
  end if;

  begin
    parsed_birth_date :=
      to_date(birth_date_text, 'YYYY-MM-DD');
  exception
    when others then
      raise exception using
        errcode = 'P0001',
        message = 'Age verification failed.';
  end;

  if to_char(parsed_birth_date, 'YYYY-MM-DD') <> birth_date_text
     or parsed_birth_date > verification_date
  then
    raise exception using
      errcode = 'P0001',
      message = 'Age verification failed.';
  end if;

  adult_cutoff :=
    (verification_date - interval '18 years')::date;

  if parsed_birth_date > adult_cutoff then
    raise exception using
      errcode = 'P0001',
      message = 'Age verification failed.';
  end if;

  insert into public.profiles (
    id,
    email,
    display_name,
    role
  )
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      null
    ),
    case
      when lower(coalesce(new.email, '')) =
        'hinaran53@gmail.com'
      then 'admin'
      else 'user'
    end
  )
  on conflict (id) do update set
    email = excluded.email,
    role = case
      when lower(excluded.email) =
        'hinaran53@gmail.com'
      then 'admin'
      else public.profiles.role
    end,
    updated_at = now();

  begin
    initial_free_credits := 0;
    balance_rows_inserted := 0;
    grant_rows_inserted := 0;

    select *
    into signup_campaign
    from private.signup_credit_campaigns
    where campaign_key = 'signup_free_credit_v1'
    for update;

    if found
       and signup_campaign.enabled = true
       and new.created_at >= signup_campaign.starts_at
       and (
         signup_campaign.ends_at is null
         or new.created_at < signup_campaign.ends_at
       )
       and signup_campaign.granted_count
         < signup_campaign.max_grants
    then
      initial_free_credits :=
        signup_campaign.credits_per_user;
    end if;

    insert into public.credit_balances (
      user_id,
      free_credits,
      subscription_credits,
      purchased_credits
    )
    values (
      new.id,
      initial_free_credits,
      0,
      0
    )
    on conflict (user_id) do nothing;

    get diagnostics balance_rows_inserted = row_count;

    if balance_rows_inserted = 1
       and initial_free_credits > 0
    then
      insert into private.signup_credit_grants (
        campaign_id,
        user_id,
        credits,
        granted_at
      )
      values (
        signup_campaign.id,
        new.id,
        initial_free_credits,
        now()
      )
      on conflict (campaign_id, user_id) do nothing;

      get diagnostics grant_rows_inserted = row_count;

      if grant_rows_inserted = 1 then
        update private.signup_credit_campaigns
        set
          granted_count = granted_count + 1,
          updated_at = now()
        where id = signup_campaign.id;

        insert into public.credit_transactions (
          user_id,
          amount,
          credit_type,
          reason
        )
        values (
          new.id,
          initial_free_credits,
          'free',
          'signup_credit_campaign:signup_free_credit_v1'
        );
      end if;
    end if;

    campaign_processing_succeeded := true;

  exception
    when others then
      campaign_processing_succeeded := false;
      initial_free_credits := 0;

      raise warning
        'Signup credit campaign skipped. SQLSTATE=%',
        sqlstate;
  end;

  if not campaign_processing_succeeded then
    insert into public.credit_balances (
      user_id,
      free_credits,
      subscription_credits,
      purchased_credits
    )
    values (
      new.id,
      0,
      0,
      0
    )
    on conflict (user_id) do nothing;
  end if;

  insert into private.user_age_verifications (
    user_id,
    birth_date,
    is_adult,
    verified_at,
    verification_version,
    updated_at
  )
  values (
    new.id,
    parsed_birth_date,
    true,
    now(),
    'birth-date-v1',
    now()
  )
  on conflict (user_id) do update set
    birth_date = excluded.birth_date,
    is_adult = excluded.is_adult,
    verified_at = excluded.verified_at,
    verification_version =
      excluded.verification_version,
    updated_at = now();

  return new;
end;
$function$;

commit;
