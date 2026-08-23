-- Pina Studio
-- Require invite-code signup for the free credit campaign grant
--
-- Scope:
-- - Only the signup_credit_campaigns eligibility check inside
--   public.handle_new_user() is changed: it now also requires that the
--   new user exists in private.invite_code_uses (i.e. signed up using a
--   valid invite code). Every other line of handle_new_user() -- age
--   verification, profiles insert, credit_balances/credit_transactions
--   bookkeeping, user_age_verifications -- is copied unchanged from
--   20260720000000_add_signup_credit_campaign.sql.
-- - private.invite_codes / private.invite_code_uses /
--   private.invite_access_settings and the on_auth_00_invite_code
--   trigger are not touched by this migration.
-- - No existing row in credit_balances / credit_transactions /
--   signup_credit_grants is modified. This migration only changes the
--   function definition; it contains no UPDATE/INSERT against those
--   tables for already-signed-up users.
--
-- Why this is safe to evaluate inside handle_new_user():
-- on_auth_00_invite_code (named to sort before on_auth_user_created)
-- already runs first and, on success, inserts the calling user's row
-- into private.invite_code_uses before handle_new_user() executes. So
-- by the time this function's campaign check runs, invite_code_uses
-- reflects whether this signup used a valid invite code.

begin;

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
       and exists (
         select 1
         from private.invite_code_uses
         where user_id = new.id
       )
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
