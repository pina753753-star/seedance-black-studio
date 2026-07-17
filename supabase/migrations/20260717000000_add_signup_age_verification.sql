-- FlowVid Studio
-- Reject signups from users under 18 years old.
-- Existing users are not updated or backfilled.

begin;

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create table if not exists private.user_age_verifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  birth_date date null,
  is_adult boolean null,
  verified_at timestamptz null,
  verification_version text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_age_verifications_valid_state check (
    (
      birth_date is null
      and is_adult is null
      and verified_at is null
      and verification_version is null
    )
    or
    (
      birth_date is not null
      and is_adult is true
      and verified_at is not null
      and verification_version is not null
    )
  )
);

alter table private.user_age_verifications enable row level security;

revoke all on table private.user_age_verifications from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.user_age_verifications to service_role;

create or replace function public.hook_enforce_minimum_signup_age(event jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog
as $function$
declare
  birth_date_text text;
  parsed_birth_date date;
  verification_date date;
  adult_cutoff date;
begin
  verification_date := (current_timestamp at time zone 'Asia/Tokyo')::date;
  birth_date_text := event -> 'user' -> 'user_metadata' ->> 'birth_date';

  if birth_date_text is null or btrim(birth_date_text) = '' then
    return jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 400, 'message', 'Birth date is required.')
    );
  end if;

  if birth_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 400, 'message', 'Invalid birth date.')
    );
  end if;

  begin
    parsed_birth_date := to_date(birth_date_text, 'YYYY-MM-DD');
  exception
    when others then
      return jsonb_build_object(
        'error',
        jsonb_build_object('http_code', 400, 'message', 'Invalid birth date.')
      );
  end;

  if to_char(parsed_birth_date, 'YYYY-MM-DD') <> birth_date_text then
    return jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 400, 'message', 'Invalid birth date.')
    );
  end if;

  if parsed_birth_date > verification_date then
    return jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 400, 'message', 'Invalid birth date.')
    );
  end if;

  adult_cutoff := (verification_date - interval '18 years')::date;

  if parsed_birth_date > adult_cutoff then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code', 403,
        'message', 'You must be at least 18 years old to register.'
      )
    );
  end if;

  return '{}'::jsonb;
exception
  when others then
    return jsonb_build_object(
      'error',
      jsonb_build_object('http_code', 500, 'message', 'Age verification unavailable.')
    );
end;
$function$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_enforce_minimum_signup_age(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_enforce_minimum_signup_age(jsonb) from public, anon, authenticated;

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
begin
  verification_date := (current_timestamp at time zone 'Asia/Tokyo')::date;
  birth_date_text := new.raw_user_meta_data ->> 'birth_date';

  if birth_date_text is null
     or btrim(birth_date_text) = ''
     or birth_date_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  then
    raise exception using errcode = 'P0001', message = 'Age verification failed.';
  end if;

  begin
    parsed_birth_date := to_date(birth_date_text, 'YYYY-MM-DD');
  exception
    when others then
      raise exception using errcode = 'P0001', message = 'Age verification failed.';
  end;

  if to_char(parsed_birth_date, 'YYYY-MM-DD') <> birth_date_text
     or parsed_birth_date > verification_date
  then
    raise exception using errcode = 'P0001', message = 'Age verification failed.';
  end if;

  adult_cutoff := (verification_date - interval '18 years')::date;

  if parsed_birth_date > adult_cutoff then
    raise exception using errcode = 'P0001', message = 'Age verification failed.';
  end if;

  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'display_name', null),
    case
      when lower(coalesce(new.email, '')) = 'hinaran53@gmail.com' then 'admin'
      else 'user'
    end
  )
  on conflict (id) do update set
    email = excluded.email,
    role = case
      when lower(excluded.email) = 'hinaran53@gmail.com' then 'admin'
      else public.profiles.role
    end,
    updated_at = now();

  insert into public.credit_balances (
    user_id,
    free_credits,
    subscription_credits,
    purchased_credits
  )
  values (new.id, 0, 0, 0)
  on conflict (user_id) do nothing;

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
    verification_version = excluded.verification_version,
    updated_at = now();

  return new;
end;
$function$;

commit;
