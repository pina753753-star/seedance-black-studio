-- H3 Max Live (Director) prompt-command ledger.
--
-- Adds an isolated, append-only audit trail for additional prompts. Existing
-- session, billing, recording, and provider tables are not altered. All access
-- remains server-side through service_role; the browser never reads these
-- tables directly.
--
-- IMPORTANT DEPLOYMENT ORDER:
--   1. Apply this additive migration.
--   2. Deploy the API/client changes that call the two RPCs below.
-- Rolling back the application code is safe because the new objects are
-- otherwise unused. Do not drop the tables during a live rollback.

begin;

create table public.h3_director_prompt_commands (
  command_id             uuid primary key,
  session_id             uuid not null references public.h3_director_sessions(id) on delete cascade,
  user_id                uuid not null references public.profiles(id) on delete cascade,
  prompt_version         integer not null check (prompt_version >= 2),
  original_prompt        text not null,
  current_status         text not null default 'checked'
                           check (current_status in (
                             'checked', 'sent', 'accepted', 'used_for_generation',
                             'visible', 'rejected', 'superseded', 'unknown'
                           )),
  last_reason            text,
  checked_at             timestamptz not null default now(),
  sent_at                timestamptz,
  accepted_at            timestamptz,
  used_for_generation_at timestamptz,
  visible_at             timestamptz,
  rejected_at            timestamptz,
  superseded_at          timestamptz,
  unknown_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint h3_director_prompt_commands_prompt_length_check
    check (char_length(btrim(original_prompt)) between 1 and 2000),
  constraint h3_director_prompt_commands_session_version_unique
    unique (session_id, prompt_version)
);

create index if not exists h3_director_prompt_commands_user_created_idx
  on public.h3_director_prompt_commands (user_id, created_at desc, command_id desc);

create index if not exists h3_director_prompt_commands_session_version_idx
  on public.h3_director_prompt_commands (session_id, prompt_version);

alter table public.h3_director_prompt_commands enable row level security;
revoke all on table public.h3_director_prompt_commands from public, anon, authenticated;
grant select, insert, update on table public.h3_director_prompt_commands to service_role;

create table public.h3_director_prompt_command_events (
  id           bigint generated always as identity primary key,
  command_id   uuid not null references public.h3_director_prompt_commands(command_id) on delete cascade,
  event_type   text not null check (event_type in (
                 'checked', 'sent', 'accepted', 'used_for_generation',
                 'visible', 'rejected', 'superseded', 'unknown'
               )),
  reason       text,
  created_at   timestamptz not null default now(),

  constraint h3_director_prompt_command_events_once_unique
    unique (command_id, event_type)
);

create index if not exists h3_director_prompt_command_events_command_idx
  on public.h3_director_prompt_command_events (command_id, created_at, id);

alter table public.h3_director_prompt_command_events enable row level security;
revoke all on table public.h3_director_prompt_command_events from public, anon, authenticated;
grant select, insert on table public.h3_director_prompt_command_events to service_role;
revoke all on sequence public.h3_director_prompt_command_events_id_seq
  from public, anon, authenticated;
grant usage, select on sequence public.h3_director_prompt_command_events_id_seq
  to service_role;

create or replace function public.approve_h3_director_prompt_atomic(
  p_session_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_prompt text
)
returns table(command_id uuid, prompt_version integer, code text, replay boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session public.h3_director_sessions%rowtype;
  v_existing public.h3_director_prompt_commands%rowtype;
  v_next_version integer;
begin
  if p_session_id is null or p_user_id is null or p_command_id is null
     or char_length(btrim(coalesce(p_prompt, ''))) not between 1 and 2000 then
    return query select null::uuid, null::integer, 'invalid_input'::text, false;
    return;
  end if;

  select * into v_existing
  from public.h3_director_prompt_commands
  where h3_director_prompt_commands.command_id = p_command_id
  for update;

  if found then
    if v_existing.session_id = p_session_id
       and v_existing.user_id = p_user_id
       and v_existing.original_prompt = btrim(p_prompt) then
      return query select v_existing.command_id, v_existing.prompt_version, 'approved'::text, true;
    else
      return query select null::uuid, null::integer, 'command_id_conflict'::text, false;
    end if;
    return;
  end if;

  select * into v_session
  from public.h3_director_sessions
  where id = p_session_id and user_id = p_user_id
  for update;

  if not found then
    return query select null::uuid, null::integer, 'session_not_found'::text, false;
    return;
  end if;

  -- A concurrent retry with the same command_id can pass the first lookup
  -- before the winning transaction inserts its row. The session row lock
  -- serializes both transactions, so repeat the lookup after acquiring it.
  -- This turns the losing transaction into a replay instead of a unique-key
  -- error and also rejects reuse of the id with different command content.
  select * into v_existing
  from public.h3_director_prompt_commands
  where h3_director_prompt_commands.command_id = p_command_id
  for update;

  if found then
    if v_existing.session_id = p_session_id
       and v_existing.user_id = p_user_id
       and v_existing.original_prompt = btrim(p_prompt) then
      return query select v_existing.command_id, v_existing.prompt_version, 'approved'::text, true;
    else
      return query select null::uuid, null::integer, 'command_id_conflict'::text, false;
    end if;
    return;
  end if;

  if v_session.status not in ('connecting', 'live')
     or v_session.expires_at is null
     or v_session.expires_at <= now() then
    return query select null::uuid, null::integer, 'session_not_live'::text, false;
    return;
  end if;

  v_next_version := greatest(coalesce(v_session.prompt_version, 1), 1) + 1;

  update public.h3_director_sessions
  set prompt_version = v_next_version, updated_at = now()
  where id = p_session_id and user_id = p_user_id;

  insert into public.h3_director_prompt_commands (
    command_id, session_id, user_id, prompt_version, original_prompt,
    current_status, checked_at, created_at, updated_at
  ) values (
    p_command_id, p_session_id, p_user_id, v_next_version, btrim(p_prompt),
    'checked', now(), now(), now()
  );

  insert into public.h3_director_prompt_command_events (
    command_id, event_type, created_at
  ) values (
    p_command_id, 'checked', now()
  );

  return query select p_command_id, v_next_version, 'approved'::text, false;
end;
$$;

revoke all on function public.approve_h3_director_prompt_atomic(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_h3_director_prompt_atomic(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.record_h3_director_prompt_event_atomic(
  p_session_id uuid,
  p_user_id uuid,
  p_command_id uuid,
  p_prompt_version integer,
  p_event_type text,
  p_reason text default null
)
returns table(code text, current_status text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_command public.h3_director_prompt_commands%rowtype;
  v_event text := btrim(coalesce(p_event_type, ''));
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 500), '');
  v_allowed boolean := false;
begin
  if v_event not in (
    'sent', 'accepted', 'used_for_generation', 'visible',
    'rejected', 'superseded', 'unknown'
  ) then
    return query select 'invalid_event'::text, null::text;
    return;
  end if;

  select * into v_command
  from public.h3_director_prompt_commands
  where command_id = p_command_id
    and session_id = p_session_id
    and user_id = p_user_id
    and prompt_version = p_prompt_version
  for update;

  if not found then
    return query select 'command_not_found'::text, null::text;
    return;
  end if;

  if exists (
    select 1 from public.h3_director_prompt_command_events
    where command_id = p_command_id and event_type = v_event
  ) then
    return query select 'already_recorded'::text, v_command.current_status;
    return;
  end if;

  v_allowed := case v_event
    when 'sent' then v_command.current_status = 'checked'
    when 'accepted' then v_command.current_status in ('checked', 'sent', 'unknown')
    when 'used_for_generation' then v_command.current_status in ('checked', 'sent', 'accepted', 'unknown')
    when 'visible' then v_command.current_status in ('checked', 'sent', 'accepted', 'used_for_generation', 'unknown')
    when 'rejected' then v_command.current_status in ('checked', 'sent', 'accepted', 'unknown')
    when 'superseded' then v_command.current_status in ('checked', 'sent', 'accepted', 'unknown')
    when 'unknown' then v_command.current_status in ('checked', 'sent', 'accepted')
    else false
  end;

  if not v_allowed then
    return query select 'invalid_transition'::text, v_command.current_status;
    return;
  end if;

  insert into public.h3_director_prompt_command_events (
    command_id, event_type, reason, created_at
  ) values (
    p_command_id, v_event, v_reason, now()
  );

  update public.h3_director_prompt_commands
  set current_status = v_event,
      last_reason = coalesce(v_reason, last_reason),
      sent_at = case when v_event = 'sent' then coalesce(sent_at, now()) else sent_at end,
      accepted_at = case when v_event = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
      used_for_generation_at = case when v_event = 'used_for_generation' then coalesce(used_for_generation_at, now()) else used_for_generation_at end,
      visible_at = case when v_event = 'visible' then coalesce(visible_at, now()) else visible_at end,
      rejected_at = case when v_event = 'rejected' then coalesce(rejected_at, now()) else rejected_at end,
      superseded_at = case when v_event = 'superseded' then coalesce(superseded_at, now()) else superseded_at end,
      unknown_at = case when v_event = 'unknown' then coalesce(unknown_at, now()) else unknown_at end,
      updated_at = now()
  where command_id = p_command_id;

  return query select 'recorded'::text, v_event;
end;
$$;

revoke all on function public.record_h3_director_prompt_event_atomic(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_h3_director_prompt_event_atomic(uuid, uuid, uuid, integer, text, text)
  to service_role;

commit;
