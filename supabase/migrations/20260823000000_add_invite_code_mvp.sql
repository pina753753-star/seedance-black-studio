-- Pina Studio
-- Invite code MVP
--
-- Safety:
-- - Existing public.handle_new_user() is not replaced.
-- - Existing age verification hook is not replaced.
-- - invite_required starts as false.
-- - Plain invite codes are never stored.
-- - The browser sends only a SHA-256 hash.
-- - The invite trigger runs before on_auth_user_created by trigger name order.

begin;

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

-- =========================================================
-- Global kill switch
-- =========================================================

create table if not exists private.invite_access_settings (
  id smallint primary key default 1,
  invite_required boolean not null default false,
  updated_by uuid null
    references public.profiles(id)
    on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invite_access_settings_singleton_check
    check (id = 1)
);

insert into private.invite_access_settings (
  id,
  invite_required
)
values (
  1,
  false
)
on conflict (id) do nothing;

-- =========================================================
-- Invite code definitions
-- =========================================================

create table if not exists private.invite_codes (
  id uuid primary key default extensions.gen_random_uuid(),

  -- SHA-256 lower-case hex only. Plain codes are never stored.
  code_hash text not null,
  code_hint text not null,
  label text not null,

  is_active boolean not null default true,

  -- Phase 1 uses defaults/NULL.
  starts_at timestamptz not null default now(),
  expires_at timestamptz null,
  max_uses integer null,

  used_count integer not null default 0,

  -- Prevent accidental duplicate creation by retry/double-click.
  creation_request_id uuid not null,

  created_by uuid not null
    references public.profiles(id)
    on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint invite_codes_code_hash_unique
    unique (code_hash),

  constraint invite_codes_creation_request_unique
    unique (creation_request_id),

  constraint invite_codes_code_hash_format_check
    check (code_hash ~ '^[0-9a-f]{64}$'),

  constraint invite_codes_label_length_check
    check (char_length(btrim(label)) between 2 and 80),

  constraint invite_codes_hint_length_check
    check (char_length(btrim(code_hint)) between 5 and 40),

  constraint invite_codes_max_uses_check
    check (max_uses is null or max_uses > 0),

  constraint invite_codes_used_count_check
    check (used_count >= 0),

  constraint invite_codes_used_not_over_limit_check
    check (max_uses is null or used_count <= max_uses),

  constraint invite_codes_expiration_check
    check (expires_at is null or expires_at > starts_at)
);

create index if not exists invite_codes_active_created_idx
  on private.invite_codes (is_active, created_at desc);

-- =========================================================
-- Successful signup attribution ledger
-- =========================================================

create table if not exists private.invite_code_uses (
  id uuid primary key default extensions.gen_random_uuid(),

  invite_code_id uuid not null
    references private.invite_codes(id)
    on delete restrict,

  -- Nullable so aggregate history survives user deletion.
  user_id uuid null
    references auth.users(id)
    on delete set null,

  used_at timestamptz not null default now(),

  constraint invite_code_uses_user_unique
    unique (user_id)
);

create index if not exists invite_code_uses_code_used_idx
  on private.invite_code_uses (invite_code_id, used_at desc);

-- =========================================================
-- Lock down internal tables
-- =========================================================

alter table private.invite_access_settings enable row level security;
alter table private.invite_codes enable row level security;
alter table private.invite_code_uses enable row level security;

revoke all
  on table private.invite_access_settings
  from public, anon, authenticated, service_role;

revoke all
  on table private.invite_codes
  from public, anon, authenticated, service_role;

revoke all
  on table private.invite_code_uses
  from public, anon, authenticated, service_role;

-- =========================================================
-- Read-only validation RPC
-- Called only by the Vercel API through service_role.
-- =========================================================

create or replace function public.validate_invite_code_hash(
  p_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_required boolean := false;
  v_hash text := lower(btrim(coalesce(p_code_hash, '')));
  v_code private.invite_codes%rowtype;
begin
  select invite_required
    into v_required
    from private.invite_access_settings
   where id = 1;

  v_required := coalesce(v_required, false);

  if v_hash = '' then
    return jsonb_build_object(
      'valid', not v_required,
      'required', v_required,
      'reason', case when v_required then 'REQUIRED' else 'OPTIONAL' end
    );
  end if;

  if v_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object(
      'valid', false,
      'required', v_required,
      'reason', 'INVALID'
    );
  end if;

  select *
    into v_code
    from private.invite_codes
   where code_hash = v_hash;

  if not found
     or v_code.is_active is not true
     or current_timestamp < v_code.starts_at
     or (
       v_code.expires_at is not null
       and current_timestamp >= v_code.expires_at
     )
     or (
       v_code.max_uses is not null
       and v_code.used_count >= v_code.max_uses
     )
  then
    return jsonb_build_object(
      'valid', false,
      'required', v_required,
      'reason', 'INVALID'
    );
  end if;

  return jsonb_build_object(
    'valid', true,
    'required', v_required,
    'reason', 'VALID'
  );
end;
$function$;

revoke all
  on function public.validate_invite_code_hash(text)
  from public, anon, authenticated, service_role;

grant execute
  on function public.validate_invite_code_hash(text)
  to service_role;

-- =========================================================
-- Authoritative signup trigger
-- =========================================================

create or replace function private.enforce_invite_code_on_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_required boolean := false;
  v_hash text;
  v_code private.invite_codes%rowtype;
  v_inserted integer := 0;
  v_existing_code_id uuid;
begin
  select invite_required
    into v_required
    from private.invite_access_settings
   where id = 1;

  v_required := coalesce(v_required, false);

  v_hash := lower(
    btrim(
      coalesce(
        new.raw_user_meta_data ->> 'invite_code_hash',
        ''
      )
    )
  );

  -- During rollout, no code is allowed only while the switch is OFF.
  if v_hash = '' then
    if v_required then
      raise exception using
        errcode = 'P0001',
        message = 'Invite code is required.';
    end if;

    return new;
  end if;

  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = 'P0001',
      message = 'Invite code is invalid or unavailable.';
  end if;

  -- Row lock prevents concurrent registrations exceeding max_uses.
  select *
    into v_code
    from private.invite_codes
   where code_hash = v_hash
   for update;

  if not found
     or v_code.is_active is not true
     or current_timestamp < v_code.starts_at
     or (
       v_code.expires_at is not null
       and current_timestamp >= v_code.expires_at
     )
     or (
       v_code.max_uses is not null
       and v_code.used_count >= v_code.max_uses
     )
  then
    raise exception using
      errcode = 'P0001',
      message = 'Invite code is invalid or unavailable.';
  end if;

  insert into private.invite_code_uses (
    invite_code_id,
    user_id,
    used_at
  )
  values (
    v_code.id,
    new.id,
    now()
  )
  on conflict (user_id) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select invite_code_id
      into v_existing_code_id
      from private.invite_code_uses
     where user_id = new.id;

    if v_existing_code_id is distinct from v_code.id then
      raise exception using
        errcode = 'P0001',
        message = 'Invite code usage conflict.';
    end if;

    return new;
  end if;

  update private.invite_codes
     set used_count = used_count + 1,
         updated_at = now()
   where id = v_code.id;

  return new;
end;
$function$;

revoke all
  on function private.enforce_invite_code_on_signup()
  from public, anon, authenticated, service_role;

-- Name begins with on_auth_00 so it runs before
-- the existing on_auth_user_created AFTER INSERT trigger.
drop trigger if exists on_auth_00_invite_code on auth.users;

create trigger on_auth_00_invite_code
after insert on auth.users
for each row
execute function private.enforce_invite_code_on_signup();

-- =========================================================
-- Admin RPC: create
-- =========================================================

create or replace function public.admin_create_invite_code(
  p_admin_user_id uuid,
  p_request_id uuid,
  p_label text,
  p_code_hash text,
  p_code_hint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_label text := btrim(coalesce(p_label, ''));
  v_hash text := lower(btrim(coalesce(p_code_hash, '')));
  v_hint text := btrim(coalesce(p_code_hint, ''));
  v_code private.invite_codes%rowtype;
  v_inserted integer := 0;
begin
  if not exists (
    select 1
      from public.profiles
     where id = p_admin_user_id
       and role = 'admin'
  ) then
    raise exception 'admin authorization failed';
  end if;

  if p_request_id is null
     or char_length(v_label) < 2
     or char_length(v_label) > 80
     or v_hash !~ '^[0-9a-f]{64}$'
     or char_length(v_hint) < 5
     or char_length(v_hint) > 40
  then
    raise exception 'invalid invite code payload';
  end if;

  insert into private.invite_codes (
    code_hash,
    code_hint,
    label,
    is_active,
    starts_at,
    expires_at,
    max_uses,
    used_count,
    creation_request_id,
    created_by
  )
  values (
    v_hash,
    v_hint,
    v_label,
    true,
    now(),
    null,
    null,
    0,
    p_request_id,
    p_admin_user_id
  )
  on conflict (creation_request_id) do nothing;

  get diagnostics v_inserted = row_count;

  select *
    into v_code
    from private.invite_codes
   where creation_request_id = p_request_id;

  if not found then
    raise exception 'invite code was not created';
  end if;

  if v_code.code_hash <> v_hash
     or v_code.label <> v_label
     or v_code.code_hint <> v_hint
  then
    raise exception 'request id was already used with different details';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', v_inserted = 0,
    'code', jsonb_build_object(
      'id', v_code.id,
      'label', v_code.label,
      'codeHint', v_code.code_hint,
      'isActive', v_code.is_active,
      'usedCount', v_code.used_count,
      'createdAt', v_code.created_at
    )
  );
end;
$function$;

-- =========================================================
-- Admin RPC: list
-- =========================================================

create or replace function public.admin_list_invite_codes(
  p_admin_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_required boolean := false;
  v_codes jsonb;
begin
  if not exists (
    select 1
      from public.profiles
     where id = p_admin_user_id
       and role = 'admin'
  ) then
    raise exception 'admin authorization failed';
  end if;

  select invite_required
    into v_required
    from private.invite_access_settings
   where id = 1;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'label', label,
        'codeHint', code_hint,
        'isActive', is_active,
        'startsAt', starts_at,
        'expiresAt', expires_at,
        'maxUses', max_uses,
        'usedCount', used_count,
        'remainingUses',
          case
            when max_uses is null then null
            else greatest(max_uses - used_count, 0)
          end,
        'createdAt', created_at,
        'updatedAt', updated_at
      )
      order by created_at desc
    ),
    '[]'::jsonb
  )
  into v_codes
  from private.invite_codes;

  return jsonb_build_object(
    'ok', true,
    'inviteRequired', coalesce(v_required, false),
    'codes', v_codes
  );
end;
$function$;

-- =========================================================
-- Admin RPC: activate/deactivate
-- =========================================================

create or replace function public.admin_set_invite_code_active(
  p_admin_user_id uuid,
  p_invite_code_id uuid,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_code private.invite_codes%rowtype;
begin
  if not exists (
    select 1
      from public.profiles
     where id = p_admin_user_id
       and role = 'admin'
  ) then
    raise exception 'admin authorization failed';
  end if;

  update private.invite_codes
     set is_active = p_is_active,
         updated_at = now()
   where id = p_invite_code_id
   returning *
    into v_code;

  if not found then
    raise exception 'invite code not found';
  end if;

  return jsonb_build_object(
    'ok', true,
    'id', v_code.id,
    'isActive', v_code.is_active
  );
end;
$function$;

-- =========================================================
-- Admin RPC: emergency switch
-- =========================================================

create or replace function public.admin_set_invite_required(
  p_admin_user_id uuid,
  p_invite_required boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_enabled_code_count integer := 0;
begin
  if not exists (
    select 1
      from public.profiles
     where id = p_admin_user_id
       and role = 'admin'
  ) then
    raise exception 'admin authorization failed';
  end if;

  if p_invite_required then
    select count(*)
      into v_enabled_code_count
      from private.invite_codes
     where is_active is true
       and current_timestamp >= starts_at
       and (
         expires_at is null
         or current_timestamp < expires_at
       )
       and (
         max_uses is null
         or used_count < max_uses
       );

    if v_enabled_code_count < 1 then
      raise exception 'at least one usable invite code is required';
    end if;
  end if;

  update private.invite_access_settings
     set invite_required = p_invite_required,
         updated_by = p_admin_user_id,
         updated_at = now()
   where id = 1;

  return jsonb_build_object(
    'ok', true,
    'inviteRequired', p_invite_required
  );
end;
$function$;

-- =========================================================
-- RPC permissions
-- =========================================================

revoke all on function public.admin_create_invite_code(
  uuid, uuid, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.admin_create_invite_code(
  uuid, uuid, text, text, text
) to service_role;

revoke all on function public.admin_list_invite_codes(
  uuid
) from public, anon, authenticated, service_role;

grant execute on function public.admin_list_invite_codes(
  uuid
) to service_role;

revoke all on function public.admin_set_invite_code_active(
  uuid, uuid, boolean
) from public, anon, authenticated, service_role;

grant execute on function public.admin_set_invite_code_active(
  uuid, uuid, boolean
) to service_role;

revoke all on function public.admin_set_invite_required(
  uuid, boolean
) from public, anon, authenticated, service_role;

grant execute on function public.admin_set_invite_required(
  uuid, boolean
) to service_role;

commit;
