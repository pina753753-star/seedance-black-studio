-- H3 Live — standalone slice, stage 1 (schema + atomic credit RPCs).
--
-- H3 Live is an independent feature: chat instruction -> short fal.ai
-- "H3 Max" video (15s / 768p fixed) -> shown on the user's own broadcast-style
-- screen. It shares NOTHING with the Seedance generation flow, the billing /
-- Stripe code, or the watermark server. The only shared surface is the
-- existing credit currency: charges/refunds are written to the existing
-- public.credit_balances and public.credit_transactions tables through the
-- new dedicated RPCs below, exactly the way public.reserve_video_edit_task /
-- public.refund_video_edit_task (20260718000000_add_video_edit_tasks.sql)
-- already do for the video-edit feature.
--
-- Adds:
--   1. public.h3_live_controls — one-row kill switch for H3 Live, independent
--      of Seedance's public.generation_control. `enabled` defaults to false,
--      so nothing can start until an operator flips it on.
--   2. public.h3_live_jobs — one row per H3 Live generation request
--      (queued -> submitting -> processing -> completed/failed). No foreign
--      key or column dependency on public.generation_tasks. input_mode is
--      'text' or 'image'; image jobs also carry image_upload_id.
--   2b. storage bucket 'h3-live-image-quarantine' (private, no policies) plus
--      public.h3_live_image_uploads — the registry for image-mode input
--      frames. Independent of Seedance's reference-image-quarantine bucket and
--      api/reference-image-*.js. Frames are never promoted to a public bucket.
--   3. public.reserve_h3_live_job_atomic(...) — advisory-lock + kill-switch +
--      idempotency-key + one-active-job + H3-only cooldown + (image mode) an
--      atomic check-and-bind of the h3_live_image_uploads row + INSERT.
--      service_role only. Mirrors public.reserve_generation_task's
--      advisory-lock pattern but uses a DISTINCT lock namespace
--      ('h3_live:' || user_id) so H3 never serialises against Seedance or
--      video-edit.
--   4. public.deduct_h3_live_credits_atomic(...) — locks the job row then the
--      balance row, deducts subscription -> free -> purchased (same order as
--      public.deduct_generation_credits_atomic), writes negative
--      public.credit_transactions rows with reason='h3_live_generation' and
--      related_task_id = the h3_live_jobs id. Idempotent on the job id.
--      service_role only.
--   5. public.refund_h3_live_job_atomic(...) — restores exactly the pools the
--      charge came from, reason='h3_live_refund', guards against double
--      refund via refunded_at + a partial unique ledger index. service_role
--      only.
--
-- CONFIRMED from 20260624000000_initial_flowvid_schema.sql (lines 47-55) and
-- 20260718000000_add_video_edit_tasks.sql (lines 18-28): the only foreign key
-- on public.credit_transactions is credit_transactions_user_id_fkey
-- (user_id -> profiles(id)). related_task_id carries no foreign key, and
-- `reason` has no CHECK constraint, so reason='h3_live_generation' /
-- 'h3_live_refund' with related_task_id = an h3_live_jobs id is not a
-- constraint violation and needs no change to that table's definition.
--
-- This migration does NOT modify any existing table, function, index, policy,
-- or grant. It only CREATEs new objects (two tables, one storage bucket, three
-- functions) and ADDs two partial indexes to public.credit_transactions whose
-- predicates (reason = 'h3_live_*') cannot overlap any existing ledger row.
-- The 'h3-live-image-quarantine' bucket is inserted with
-- ON CONFLICT (id) DO UPDATE, so re-running only re-asserts its private config.
--
-- DO NOT run against production without explicit approval.
--
-- ============================================================
-- PRE-CHECK QUERIES (run read-only before executing this file)
-- ============================================================
--
-- 1. Table existence:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema = 'public'
--      AND table_name IN ('h3_live_controls', 'h3_live_jobs',
--                         'h3_live_image_uploads');
--    -> If any returns a row, STOP and investigate before running.
--
-- 1b. Storage bucket existence:
--    SELECT id FROM storage.buckets WHERE id = 'h3-live-image-quarantine';
--    -> If it returns a row, the ON CONFLICT branch will only re-assert the
--       private config (public=false, size limit, mime allow-list). Confirm
--       nothing else already relies on that id before running.
--
-- 2. Function existence:
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('reserve_h3_live_job_atomic',
--                           'deduct_h3_live_credits_atomic',
--                           'refund_h3_live_job_atomic');
--    -> If any returns a row, STOP and investigate before running.
--
-- 3. Index existence:
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexname IN ('credit_transactions_h3_live_charge_unique',
--                        'credit_transactions_h3_live_refund_unique');
--    -> If either returns a row, STOP and investigate before running.
--
-- 4. Verify AFTER migration — only service_role has EXECUTE:
--    SELECT grantee, privilege_type
--    FROM information_schema.role_routine_grants
--    WHERE routine_schema = 'public'
--      AND routine_name IN ('reserve_h3_live_job_atomic',
--                           'deduct_h3_live_credits_atomic',
--                           'refund_h3_live_job_atomic');
--
-- 5. Verify AFTER migration — tables are service_role-only:
--    SELECT has_table_privilege('anon', 'public.h3_live_jobs', 'SELECT')          AS anon_jobs,
--           has_table_privilege('authenticated', 'public.h3_live_jobs', 'SELECT') AS auth_jobs,
--           has_table_privilege('service_role', 'public.h3_live_jobs', 'SELECT')  AS svc_jobs;
--    -> anon_jobs and auth_jobs must both be false; svc_jobs true.
--    (No RLS policies are created for these tables — same posture as
--    public.video_edit_tasks. All access goes through api/h3-live/*.js, which
--    uses the service-role client.)
-- ============================================================

begin;

-- ────────────────────────────────────────────────────────────────
-- 1. public.h3_live_controls — H3 Live kill switch (independent of Seedance)
-- ────────────────────────────────────────────────────────────────
create table if not exists public.h3_live_controls (
  control_key text primary key
    constraint h3_live_controls_key_check check (control_key = 'h3_live'),
  enabled     boolean not null default false,
  note        text,
  updated_at  timestamptz not null default now()
);

insert into public.h3_live_controls (control_key, enabled, note)
values ('h3_live', false, 'H3 Live disabled until operator enables it.')
on conflict (control_key) do nothing;

alter table public.h3_live_controls enable row level security;

revoke all on table public.h3_live_controls from anon;
revoke all on table public.h3_live_controls from authenticated;
grant select, update on table public.h3_live_controls to service_role;

-- ────────────────────────────────────────────────────────────────
-- 2. public.h3_live_jobs — one row per H3 Live generation request
-- ────────────────────────────────────────────────────────────────
create table if not exists public.h3_live_jobs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,

  idempotency_key       uuid not null,
  instruction           text not null,
  status                text not null default 'queued'
                          check (status in ('queued', 'submitting', 'processing', 'completed', 'failed')),

  -- 'text' -> minimax/h3-max/text-to-video, 'image' -> .../image-to-video.
  -- image_upload_id points at public.h3_live_image_uploads.id (no FK on purpose:
  -- the row is created before the job and the reserve RPC enforces the link,
  -- and h3_live_image_uploads already carries a FK back to this table).
  input_mode            text not null default 'text'
                          check (input_mode in ('text', 'image')),
  image_upload_id       uuid,

  provider              text not null default 'fal' check (provider = 'fal'),
  provider_model_id     text,
  provider_request_id   text,
  provider_poll_url     text,
  provider_response_url text,
  provider_status       text,

  duration_seconds      smallint not null default 15 check (duration_seconds = 15),
  resolution            text not null default '768p' check (resolution = '768p'),
  credit_cost           integer not null default 110 check (credit_cost = 110),

  deducted_subscription integer not null default 0 check (deducted_subscription >= 0),
  deducted_free         integer not null default 0 check (deducted_free >= 0),
  deducted_purchased    integer not null default 0 check (deducted_purchased >= 0),

  output_url            text,
  error_code            text,
  error_message         text,

  charged_at            timestamptz,
  submitted_at          timestamptz,
  last_polled_at        timestamptz,
  poll_attempt_count    integer not null default 0 check (poll_attempt_count >= 0),
  completed_at          timestamptz,
  failed_at             timestamptz,
  refunded_at           timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint h3_live_jobs_instruction_length_check
    check (char_length(btrim(instruction)) between 1 and 2000),

  -- image_upload_id is present exactly for image-mode jobs.
  constraint h3_live_jobs_image_mode_check
    check ((input_mode = 'image') = (image_upload_id is not null)),

  -- Either nothing has been charged, or the three pool amounts sum to the cost.
  constraint h3_live_jobs_charge_state_check
    check (
      (charged_at is null
        and deducted_subscription = 0
        and deducted_free = 0
        and deducted_purchased = 0)
      or
      (charged_at is not null
        and deducted_subscription + deducted_free + deducted_purchased = credit_cost)
    ),

  -- finished_at is set exactly when the job reaches a terminal status.
  constraint h3_live_jobs_terminal_timestamp_check
    check ((status in ('completed', 'failed')) = (finished_at is not null)),

  constraint h3_live_jobs_completed_state_check
    check ((status = 'completed') = (completed_at is not null)),

  constraint h3_live_jobs_failed_state_check
    check ((status = 'failed') = (failed_at is not null)),

  constraint h3_live_jobs_completed_output_check
    check (status <> 'completed' or output_url is not null),

  -- A refund can only exist for a job that was charged and then failed.
  constraint h3_live_jobs_refund_state_check
    check (refunded_at is null or (charged_at is not null and status = 'failed'))
);

-- Idempotency: a retried /start with the same key maps to the same row.
create unique index if not exists h3_live_jobs_user_idempotency_idx
  on public.h3_live_jobs (user_id, idempotency_key);

-- One active H3 Live job per user (independent of Seedance's guard).
create unique index if not exists h3_live_jobs_one_active_per_user_idx
  on public.h3_live_jobs (user_id)
  where status in ('queued', 'submitting', 'processing');

-- A fal request id maps to at most one job.
create unique index if not exists h3_live_jobs_provider_request_idx
  on public.h3_live_jobs (provider, provider_request_id)
  where provider_request_id is not null;

-- History (keyset pagination) and feed lookups.
create index if not exists h3_live_jobs_user_created_idx
  on public.h3_live_jobs (user_id, created_at desc, id desc);

create index if not exists h3_live_jobs_user_completed_idx
  on public.h3_live_jobs (user_id, completed_at desc)
  where status = 'completed';

create index if not exists h3_live_jobs_user_finished_idx
  on public.h3_live_jobs (user_id, finished_at desc)
  where finished_at is not null;

-- One charge ledger row per job per pool, and one refund ledger row per job
-- per pool. Predicates are H3-only, so these can never match an existing
-- Seedance / video-edit ledger row.
create unique index if not exists credit_transactions_h3_live_charge_unique
  on public.credit_transactions (related_task_id, reason, credit_type)
  where reason = 'h3_live_generation';

create unique index if not exists credit_transactions_h3_live_refund_unique
  on public.credit_transactions (related_task_id, reason, credit_type)
  where reason = 'h3_live_refund';

-- RLS enabled, no policies: service_role-only, same posture as
-- public.video_edit_tasks. h3-live.html never queries this table directly —
-- it goes through api/h3-live/jobs.js and api/h3-live/feed.js (service role).
alter table public.h3_live_jobs enable row level security;

revoke all on table public.h3_live_jobs from anon;
revoke all on table public.h3_live_jobs from authenticated;
grant all on table public.h3_live_jobs to service_role;

-- ────────────────────────────────────────────────────────────────
-- 2b. H3 Live image input (image -> video) — private quarantine bucket
--     + upload registry. Independent of Seedance's reference-image-quarantine
--     bucket and of api/reference-image-*.js. Only trusted server-side code
--     using the service role touches this bucket; no storage.objects policies
--     are created (same posture as reference-image-quarantine and
--     seedance-reference-audio). Uploaded frames are NEVER promoted to a public
--     bucket — api/h3-live/start.js hands fal.ai a short-lived signed URL.
-- ────────────────────────────────────────────────────────────────
insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'h3-live-image-quarantine',
  'h3-live-image-quarantine',
  false,
  20971520,                       -- 20 MiB; matches api/_lib/h3-live-config.js
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- One row per issued upload slot. Tracks moderation state, the bound job, and
-- an absolute delete-after so abandoned uploads can be swept opportunistically
-- (there is no dedicated cron — api/h3-live/*.js sweep a bounded batch on each
-- call, and api/h3-live/image-cleanup.js is an auth'd manual/cron entrypoint).
create table if not exists public.h3_live_image_uploads (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,

  object_path           text not null unique,
  content_type          text not null
                          check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size             integer not null check (byte_size >= 0 and byte_size <= 20971520),

  moderation_status     text not null default 'pending'
                          check (moderation_status in ('pending', 'passed', 'blocked')),
  moderated_at          timestamptz,
  moderation_categories text[],

  -- Set by reserve_h3_live_job_atomic when the upload is bound to a job.
  job_id                uuid references public.h3_live_jobs(id) on delete set null,

  delete_after          timestamptz not null,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Object path is always "uploads/<userId>/<uploadId>/<file>" so one user can
  -- never register another user's path.
  constraint h3_live_image_uploads_owned_path_check
    check (object_path like ('uploads/' || user_id::text || '/%')),

  constraint h3_live_image_uploads_moderated_at_check
    check ((moderation_status = 'pending') = (moderated_at is null))
);

-- Sweep lookup: rows whose retention window has closed and are not yet deleted.
create index if not exists h3_live_image_uploads_sweep_idx
  on public.h3_live_image_uploads (delete_after)
  where deleted_at is null;

-- One usable (passed, not deleted, unbound) upload per user at a time is all the
-- UI offers; this partial unique index makes that explicit and prevents a
-- second job from re-binding an upload.
create unique index if not exists h3_live_image_uploads_one_bound_per_job_idx
  on public.h3_live_image_uploads (job_id)
  where job_id is not null;

alter table public.h3_live_image_uploads enable row level security;

revoke all on table public.h3_live_image_uploads from anon;
revoke all on table public.h3_live_image_uploads from authenticated;
grant all on table public.h3_live_image_uploads to service_role;

-- ────────────────────────────────────────────────────────────────
-- 3. public.reserve_h3_live_job_atomic — reserve an H3 Live job row
-- ────────────────────────────────────────────────────────────────
-- Returns a single row with:
--   job_id              uuid    — set on success and on idempotent replay
--   code                text    — NULL on a fresh reservation; otherwise one of
--                                 'service_disabled' | 'active_job' |
--                                 'cooldown_active' | 'existing' |
--                                 'idempotency_conflict' | 'image_not_usable'
--   retry_after_seconds integer — seconds to wait when code='cooldown_active'
--   existing            boolean — true when job_id points at a pre-existing
--                                 (user_id, idempotency_key) row
--
-- p_input_mode 'text' (default) reserves a text-to-video job. 'image' also
-- requires p_image_upload_id to name a public.h3_live_image_uploads row that
-- belongs to p_user_id, has moderation_status='passed', is not deleted, and is
-- not already bound to a job — otherwise code='image_not_usable'. On success the
-- upload row's job_id is set inside this same transaction, so an upload can
-- never be shared between two jobs. On idempotent replay the stored image is
-- compared with p_image_upload_id, so a retried key cannot swap the image.
create or replace function public.reserve_h3_live_job_atomic(
  p_user_id         uuid,
  p_idempotency_key uuid,
  p_instruction     text,
  p_input_mode      text default 'text',
  p_image_upload_id uuid default null
)
returns table (
  job_id              uuid,
  code                text,
  retry_after_seconds integer,
  existing            boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lock_key                  bigint;
  v_enabled                   boolean;
  v_existing_id               uuid;
  v_existing_instruction      text;
  v_existing_image_upload_id  uuid;
  v_active_count              integer;
  v_finished_at               timestamptz;
  v_retry_after               integer;
  v_job_id                    uuid;
  v_upload                    public.h3_live_image_uploads%rowtype;
begin
  if p_user_id is null
     or p_idempotency_key is null
     or char_length(btrim(coalesce(p_instruction, ''))) < 1
     or char_length(btrim(coalesce(p_instruction, ''))) > 2000
     or coalesce(p_input_mode, 'text') not in ('text', 'image')
     or (coalesce(p_input_mode, 'text') = 'image' and p_image_upload_id is null)
     or (coalesce(p_input_mode, 'text') = 'text' and p_image_upload_id is not null)
  then
    raise exception 'invalid_h3_live_reservation'
      using errcode = 'check_violation';
  end if;

  -- Lock namespace distinct from reserve_generation_task and
  -- reserve_video_edit_task, so H3 Live never serialises against them.
  v_lock_key := hashtext('h3_live:' || p_user_id::text)::bigint;

  if not pg_try_advisory_xact_lock(v_lock_key) then
    return query select null::uuid, 'active_job'::text, 0, false;
    return;
  end if;

  select enabled
    into v_enabled
    from public.h3_live_controls
   where control_key = 'h3_live';

  if coalesce(v_enabled, false) is not true then
    return query select null::uuid, 'service_disabled'::text, 0, false;
    return;
  end if;

  -- Idempotent replay: same (user, key).
  select id, instruction, image_upload_id
    into v_existing_id, v_existing_instruction, v_existing_image_upload_id
    from public.h3_live_jobs
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key;

  if found then
    if v_existing_instruction is distinct from btrim(p_instruction)
       or v_existing_image_upload_id is distinct from p_image_upload_id
    then
      return query select v_existing_id, 'idempotency_conflict'::text, 0, true;
    else
      return query select v_existing_id, 'existing'::text, 0, true;
    end if;
    return;
  end if;

  -- One active H3 Live job per user.
  select count(*)
    into v_active_count
    from public.h3_live_jobs
   where user_id = p_user_id
     and status in ('queued', 'submitting', 'processing');

  if v_active_count > 0 then
    return query select null::uuid, 'active_job'::text, 0, false;
    return;
  end if;

  -- H3-only cooldown: 10 seconds after the last job reached a terminal state.
  select max(finished_at)
    into v_finished_at
    from public.h3_live_jobs
   where user_id = p_user_id
     and finished_at is not null;

  if v_finished_at is not null
     and v_finished_at + interval '10 seconds' > now()
  then
    v_retry_after := greatest(
      1,
      least(
        10,
        ceil(extract(epoch from (v_finished_at + interval '10 seconds' - now())))::integer
      )
    );
    return query select null::uuid, 'cooldown_active'::text, v_retry_after, false;
    return;
  end if;

  -- Image mode: the frame must be a clean, unbound upload owned by this user.
  if p_input_mode = 'image' then
    select *
      into v_upload
      from public.h3_live_image_uploads
     where id = p_image_upload_id
     for update;

    if not found
       or v_upload.user_id <> p_user_id
       or v_upload.moderation_status <> 'passed'
       or v_upload.deleted_at is not null
       or v_upload.job_id is not null
    then
      return query select null::uuid, 'image_not_usable'::text, 0, false;
      return;
    end if;
  end if;

  insert into public.h3_live_jobs (
    user_id, idempotency_key, instruction, status,
    provider, duration_seconds, resolution, credit_cost,
    input_mode, image_upload_id
  )
  values (
    p_user_id, p_idempotency_key, btrim(p_instruction), 'queued',
    'fal', 15, '768p', 110,
    coalesce(p_input_mode, 'text'), p_image_upload_id
  )
  returning id into v_job_id;

  if p_input_mode = 'image' then
    update public.h3_live_image_uploads
       set job_id = v_job_id,
           updated_at = now()
     where id = p_image_upload_id;
  end if;

  return query select v_job_id, null::text, 0, false;
end;
$$;

revoke all on function public.reserve_h3_live_job_atomic(uuid, uuid, text, text, uuid) from public;
revoke all on function public.reserve_h3_live_job_atomic(uuid, uuid, text, text, uuid) from anon;
revoke all on function public.reserve_h3_live_job_atomic(uuid, uuid, text, text, uuid) from authenticated;
grant execute on function public.reserve_h3_live_job_atomic(uuid, uuid, text, text, uuid) to service_role;

-- ────────────────────────────────────────────────────────────────
-- 4. public.deduct_h3_live_credits_atomic — charge 110 credits for a job
-- ────────────────────────────────────────────────────────────────
-- Locks the job row, then the balance row. Deducts subscription -> free ->
-- purchased (same order as public.deduct_generation_credits_atomic). Writes
-- negative public.credit_transactions rows with reason='h3_live_generation',
-- related_task_id = p_job_id. Idempotent: a second call after a committed
-- charge returns code='already_deducted' without deducting again.
create or replace function public.deduct_h3_live_credits_atomic(
  p_job_id  uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job                     public.h3_live_jobs%rowtype;
  v_enabled                 boolean;
  v_free                    integer;
  v_subscription            integer;
  v_purchased               integer;
  v_subscription_expires_at timestamptz;
  v_purchased_expires_at    timestamptz;
  v_total                   integer;
  v_remaining               integer;
  v_from_subscription       integer := 0;
  v_from_free               integer := 0;
  v_from_purchased          integer := 0;
  v_has_charge              boolean;
  v_charge_subscription     integer;
  v_charge_free             integer;
  v_charge_purchased        integer;
begin
  select *
    into v_job
    from public.h3_live_jobs
   where id = p_job_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;

  if v_job.user_id <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'job_owner_mismatch');
  end if;

  if v_job.credit_cost <> 110 then
    raise exception 'h3_live_credit_cost_mismatch'
      using errcode = 'check_violation';
  end if;

  -- Reconstruct any existing charge from the ledger.
  select
    count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'free'         then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased'    then abs(amount) else 0 end), 0)
    into v_has_charge, v_charge_subscription, v_charge_free, v_charge_purchased
    from public.credit_transactions
   where related_task_id = p_job_id
     and reason = 'h3_live_generation'
     and amount < 0;

  -- Idempotent replay after a committed deduction.
  if v_job.charged_at is not null or v_has_charge then
    if v_job.charged_at is null
       or not v_has_charge
       or v_charge_subscription <> v_job.deducted_subscription
       or v_charge_free <> v_job.deducted_free
       or v_charge_purchased <> v_job.deducted_purchased
       or v_charge_subscription + v_charge_free + v_charge_purchased <> 110
    then
      raise exception 'h3_live_charge_state_inconsistent'
        using errcode = 'data_exception';
    end if;

    select free_credits, subscription_credits, purchased_credits
      into v_free, v_subscription, v_purchased
      from public.credit_balances
     where user_id = p_user_id;

    return jsonb_build_object(
      'ok', true,
      'code', 'already_deducted',
      'deducted', 110,
      'new_balance', coalesce(v_free, 0) + coalesce(v_subscription, 0) + coalesce(v_purchased, 0),
      'from_subscription', v_charge_subscription,
      'from_free', v_charge_free,
      'from_purchased', v_charge_purchased
    );
  end if;

  if v_job.status <> 'queued' or v_job.provider_request_id is not null then
    return jsonb_build_object('ok', false, 'code', 'job_not_chargeable');
  end if;

  -- Re-check the kill switch inside the same transaction that will charge.
  select enabled
    into v_enabled
    from public.h3_live_controls
   where control_key = 'h3_live';

  if coalesce(v_enabled, false) is not true then
    update public.h3_live_jobs
       set status = 'failed',
           error_code = 'service_disabled',
           error_message = 'H3 Live is disabled',
           failed_at = now(),
           finished_at = now(),
           updated_at = now()
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'service_disabled');
  end if;

  select
    free_credits, subscription_credits, purchased_credits,
    subscription_expires_at, purchased_expires_at
    into
      v_free, v_subscription, v_purchased,
      v_subscription_expires_at, v_purchased_expires_at
    from public.credit_balances
   where user_id = p_user_id
   for update;

  if not found then
    update public.h3_live_jobs
       set status = 'failed',
           error_code = 'balance_not_found',
           error_message = 'Credit balance was not found',
           failed_at = now(),
           finished_at = now(),
           updated_at = now()
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'balance_not_found');
  end if;

  if v_subscription_expires_at is not null and v_subscription_expires_at < now() then
    v_subscription := 0;
  end if;
  if v_purchased_expires_at is not null and v_purchased_expires_at < now() then
    v_purchased := 0;
  end if;

  v_total := coalesce(v_free, 0) + coalesce(v_subscription, 0) + coalesce(v_purchased, 0);

  if v_total < 110 then
    -- Persist the expiry-zeroing we just applied, then fail the job.
    update public.credit_balances
       set subscription_credits = v_subscription,
           purchased_credits = v_purchased,
           updated_at = now()
     where user_id = p_user_id;

    update public.h3_live_jobs
       set status = 'failed',
           error_code = 'insufficient_credits',
           error_message = 'Insufficient credits',
           failed_at = now(),
           finished_at = now(),
           updated_at = now()
     where id = p_job_id;

    return jsonb_build_object(
      'ok', false, 'code', 'insufficient_credits',
      'balance', v_total, 'required', 110
    );
  end if;

  v_remaining := 110;
  v_from_subscription := least(v_remaining, coalesce(v_subscription, 0));
  v_remaining := v_remaining - v_from_subscription;
  v_from_free := least(v_remaining, coalesce(v_free, 0));
  v_remaining := v_remaining - v_from_free;
  v_from_purchased := least(v_remaining, coalesce(v_purchased, 0));

  update public.credit_balances
     set subscription_credits = coalesce(v_subscription, 0) - v_from_subscription,
         free_credits         = coalesce(v_free, 0) - v_from_free,
         purchased_credits    = coalesce(v_purchased, 0) - v_from_purchased,
         updated_at = now()
   where user_id = p_user_id;

  if v_from_subscription > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_subscription, 'subscription', 'h3_live_generation', p_job_id);
  end if;
  if v_from_free > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_free, 'free', 'h3_live_generation', p_job_id);
  end if;
  if v_from_purchased > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (p_user_id, -v_from_purchased, 'purchased', 'h3_live_generation', p_job_id);
  end if;

  update public.h3_live_jobs
     set deducted_subscription = v_from_subscription,
         deducted_free = v_from_free,
         deducted_purchased = v_from_purchased,
         charged_at = now(),
         updated_at = now()
   where id = p_job_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'deducted',
    'deducted', 110,
    'new_balance', v_total - 110,
    'from_subscription', v_from_subscription,
    'from_free', v_from_free,
    'from_purchased', v_from_purchased
  );
end;
$$;

revoke all on function public.deduct_h3_live_credits_atomic(uuid, uuid) from public;
revoke all on function public.deduct_h3_live_credits_atomic(uuid, uuid) from anon;
revoke all on function public.deduct_h3_live_credits_atomic(uuid, uuid) from authenticated;
grant execute on function public.deduct_h3_live_credits_atomic(uuid, uuid) to service_role;

-- ────────────────────────────────────────────────────────────────
-- 5. public.refund_h3_live_job_atomic — refund a charged, non-completed job
-- ────────────────────────────────────────────────────────────────
-- Returns jsonb { ok, code, refunded[, refunded_amount] } where code is one of
--   'job_not_found' | 'already_completed' | 'no_charge_found' |
--   'already_refunded' | 'refunded'.
-- Restores exactly the pools the charge came from and marks the job failed.
-- Idempotent: a second call returns code='already_refunded'.
create or replace function public.refund_h3_live_job_atomic(
  p_job_id        uuid,
  p_error_code    text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job                 public.h3_live_jobs%rowtype;
  v_balance_user_id     uuid;
  v_has_charge          boolean;
  v_charge_subscription integer;
  v_charge_free         integer;
  v_charge_purchased    integer;
  v_has_refund          boolean;
  v_refund_subscription integer;
  v_refund_free         integer;
  v_refund_purchased    integer;
begin
  select *
    into v_job
    from public.h3_live_jobs
   where id = p_job_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;

  -- A completed job is never refunded — the video was delivered.
  if v_job.status = 'completed' then
    return jsonb_build_object('ok', true, 'code', 'already_completed', 'refunded', false);
  end if;

  select
    count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'free'         then abs(amount) else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased'    then abs(amount) else 0 end), 0)
    into v_has_charge, v_charge_subscription, v_charge_free, v_charge_purchased
    from public.credit_transactions
   where related_task_id = p_job_id
     and reason = 'h3_live_generation'
     and amount < 0;

  -- No charge was ever taken: just move the job to a terminal failed state.
  if not v_has_charge then
    if v_job.charged_at is not null
       or v_job.deducted_subscription + v_job.deducted_free + v_job.deducted_purchased <> 0
    then
      raise exception 'h3_live_charge_state_inconsistent'
        using errcode = 'data_exception';
    end if;

    update public.h3_live_jobs
       set status = 'failed',
           error_code = coalesce(error_code, left(nullif(btrim(p_error_code), ''), 100)),
           error_message = coalesce(error_message, left(nullif(btrim(p_error_message), ''), 1000)),
           failed_at = coalesce(failed_at, now()),
           finished_at = coalesce(finished_at, now()),
           updated_at = now()
     where id = p_job_id;

    return jsonb_build_object('ok', true, 'code', 'no_charge_found', 'refunded', false);
  end if;

  if v_job.charged_at is null
     or v_charge_subscription <> v_job.deducted_subscription
     or v_charge_free <> v_job.deducted_free
     or v_charge_purchased <> v_job.deducted_purchased
     or v_charge_subscription + v_charge_free + v_charge_purchased <> 110
  then
    raise exception 'h3_live_charge_state_inconsistent'
      using errcode = 'data_exception';
  end if;

  -- Existing refund? (double-refund guard, backed by the partial unique index)
  select
    count(*) > 0,
    coalesce(sum(case when credit_type = 'subscription' then amount else 0 end), 0),
    coalesce(sum(case when credit_type = 'free'         then amount else 0 end), 0),
    coalesce(sum(case when credit_type = 'purchased'    then amount else 0 end), 0)
    into v_has_refund, v_refund_subscription, v_refund_free, v_refund_purchased
    from public.credit_transactions
   where related_task_id = p_job_id
     and reason = 'h3_live_refund'
     and amount > 0;

  if v_job.refunded_at is not null or v_has_refund then
    if v_job.refunded_at is null
       or not v_has_refund
       or v_refund_subscription <> v_charge_subscription
       or v_refund_free <> v_charge_free
       or v_refund_purchased <> v_charge_purchased
    then
      raise exception 'h3_live_refund_state_inconsistent'
        using errcode = 'data_exception';
    end if;

    return jsonb_build_object('ok', true, 'code', 'already_refunded', 'refunded', true);
  end if;

  select user_id
    into v_balance_user_id
    from public.credit_balances
   where user_id = v_job.user_id
   for update;

  if not found then
    raise exception 'h3_live_balance_not_found'
      using errcode = 'no_data_found';
  end if;

  if v_charge_subscription > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_job.user_id, v_charge_subscription, 'subscription', 'h3_live_refund', p_job_id);
  end if;
  if v_charge_free > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_job.user_id, v_charge_free, 'free', 'h3_live_refund', p_job_id);
  end if;
  if v_charge_purchased > 0 then
    insert into public.credit_transactions (user_id, amount, credit_type, reason, related_task_id)
    values (v_job.user_id, v_charge_purchased, 'purchased', 'h3_live_refund', p_job_id);
  end if;

  update public.credit_balances
     set subscription_credits = subscription_credits + v_charge_subscription,
         free_credits         = free_credits + v_charge_free,
         purchased_credits    = purchased_credits + v_charge_purchased,
         updated_at = now()
   where user_id = v_job.user_id;

  update public.h3_live_jobs
     set status = 'failed',
         error_code = coalesce(error_code, left(nullif(btrim(p_error_code), ''), 100)),
         error_message = coalesce(error_message, left(nullif(btrim(p_error_message), ''), 1000)),
         failed_at = coalesce(failed_at, now()),
         refunded_at = now(),
         finished_at = coalesce(finished_at, now()),
         updated_at = now()
   where id = p_job_id;

  return jsonb_build_object(
    'ok', true, 'code', 'refunded', 'refunded', true, 'refunded_amount', 110
  );
end;
$$;

revoke all on function public.refund_h3_live_job_atomic(uuid, text, text) from public;
revoke all on function public.refund_h3_live_job_atomic(uuid, text, text) from anon;
revoke all on function public.refund_h3_live_job_atomic(uuid, text, text) from authenticated;
grant execute on function public.refund_h3_live_job_atomic(uuid, text, text) to service_role;

commit;

-- Rollback (if unexpected breakage is observed after applying):
--   begin;
--   drop function if exists public.refund_h3_live_job_atomic(uuid, text, text);
--   drop function if exists public.deduct_h3_live_credits_atomic(uuid, uuid);
--   drop function if exists public.reserve_h3_live_job_atomic(uuid, uuid, text, text, uuid);
--   drop index if exists public.credit_transactions_h3_live_refund_unique;
--   drop index if exists public.credit_transactions_h3_live_charge_unique;
--   drop table if exists public.h3_live_image_uploads;
--   drop table if exists public.h3_live_jobs;
--   drop table if exists public.h3_live_controls;
--   delete from storage.buckets where id = 'h3-live-image-quarantine';
--   commit;
--   -- Storage objects (if any) must be removed through the Storage API, not by
--   -- deleting storage.objects rows directly.
