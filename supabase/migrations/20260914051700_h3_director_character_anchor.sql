-- H3 Max Live (Director) session identity anchor.
--
-- Records whether a session started with an image and the exact, server-owned
-- identity instruction that must accompany its provider prompts. Binding is
-- atomic and idempotent, happens before charging, and also prevents an HTTP
-- retry from changing image mode while reusing the same start idempotency key.
--
-- DEPLOYMENT ORDER:
--   1. Apply this additive migration.
--   2. Wait for any pre-migration 60-second Director session to finish.
--   3. Deploy the API/client change.
-- Rolling the application back after any active 60-second Director session
-- finishes is safe: the added nullable/defaulted columns and otherwise-unused
-- RPC do not alter the old application path.

begin;

alter table public.h3_director_sessions
  add column if not exists input_mode text not null default 'text',
  add column if not exists initial_image_upload_id uuid,
  add column if not exists identity_anchor_prompt text,
  add column if not exists anchor_bound_at timestamptz;

alter table public.h3_director_sessions
  add constraint h3_director_input_mode_check
    check (input_mode in ('text', 'image')),
  add constraint h3_director_identity_anchor_length_check
    check (
      identity_anchor_prompt is null
      or char_length(btrim(identity_anchor_prompt)) between 1 and 500
    ),
  add constraint h3_director_identity_anchor_state_check
    check (
      (anchor_bound_at is null
        and input_mode = 'text'
        and initial_image_upload_id is null
        and identity_anchor_prompt is null)
      or
      (anchor_bound_at is not null and (
        (input_mode = 'text'
          and initial_image_upload_id is null
          and identity_anchor_prompt is null)
        or
        (input_mode = 'image'
          and initial_image_upload_id is not null
          and identity_anchor_prompt is not null)
      ))
    );

-- The shared upload registry previously knew only about queued H3 jobs. A
-- Director image therefore continued to look pending after its session had
-- reserved it, so a second upload could supersede and remove the object while
-- the provider was still fetching it. Give Director its own mutually-exclusive
-- bind marker and exclude bound rows from the one-pending-upload backstop.
alter table public.h3_live_image_uploads
  add column if not exists director_session_id uuid
    references public.h3_director_sessions(id) on delete set null,
  add constraint h3_live_image_uploads_single_consumer_check
    check (not (job_id is not null and director_session_id is not null));

drop index if exists public.h3_live_image_uploads_one_pending_per_user_idx;

create unique index h3_live_image_uploads_one_pending_per_user_idx
  on public.h3_live_image_uploads (user_id)
  where job_id is null
    and director_session_id is null
    and deleted_at is null
    and superseded_at is null;

create unique index h3_live_image_uploads_one_director_session_idx
  on public.h3_live_image_uploads (director_session_id)
  where director_session_id is not null;

create or replace function public.bind_h3_director_session_anchor_atomic(
  p_session_id uuid,
  p_user_id uuid,
  p_image_upload_id uuid default null,
  p_anchor_prompt text default null
)
returns table(code text, input_mode text, anchor_prompt text, replay boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_session public.h3_director_sessions%rowtype;
  v_mode text := case when p_image_upload_id is null then 'text' else 'image' end;
  v_anchor text := nullif(btrim(coalesce(p_anchor_prompt, '')), '');
  v_claimed_image_id uuid;
begin
  if p_session_id is null or p_user_id is null
     or (v_mode = 'text' and v_anchor is not null)
     or (v_mode = 'image' and (v_anchor is null or char_length(v_anchor) > 500)) then
    return query select 'invalid_input'::text, null::text, null::text, false;
    return;
  end if;

  select * into v_session
  from public.h3_director_sessions
  where id = p_session_id and user_id = p_user_id
  for update;

  if not found then
    return query select 'session_not_found'::text, null::text, null::text, false;
    return;
  end if;

  if v_session.anchor_bound_at is not null then
    if v_session.input_mode = v_mode
       and v_session.initial_image_upload_id is not distinct from p_image_upload_id
       and v_session.identity_anchor_prompt is not distinct from v_anchor then
      return query select 'bound'::text, v_session.input_mode,
        v_session.identity_anchor_prompt, true;
      return;
    end if;
    return query select 'anchor_conflict'::text, v_session.input_mode,
      v_session.identity_anchor_prompt, false;
    return;
  end if;

  if v_session.status <> 'reserved' or v_session.charged_at is not null then
    return query select 'session_not_bindable'::text, null::text, null::text, false;
    return;
  end if;

  if v_mode = 'image' then
    -- Atomic claim: the shared replacement path may supersede only uploads
    -- whose two consumer ids are still NULL. The losing transaction returns
    -- without deleting an active image or charging the session.
    update public.h3_live_image_uploads
    set director_session_id = p_session_id,
        updated_at = now()
    where id = p_image_upload_id
      and user_id = p_user_id
      and moderation_status = 'passed'
      and job_id is null
      and director_session_id is null
      and deleted_at is null
      and superseded_at is null
    returning id into v_claimed_image_id;

    if v_claimed_image_id is null then
      return query select 'image_not_usable'::text, null::text, null::text, false;
      return;
    end if;
  end if;

  update public.h3_director_sessions
  set input_mode = v_mode,
      initial_image_upload_id = p_image_upload_id,
      identity_anchor_prompt = v_anchor,
      anchor_bound_at = now(),
      updated_at = now()
  where id = p_session_id and user_id = p_user_id;

  return query select 'bound'::text, v_mode, v_anchor, false;
end;
$$;

revoke all on function public.bind_h3_director_session_anchor_atomic(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_h3_director_session_anchor_atomic(uuid, uuid, uuid, text)
  to service_role;

commit;
