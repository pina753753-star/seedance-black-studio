-- H3 Max — multi-image "reference" and "storyboard" modes.
--
-- Adds two new H3 Max input modes on top of the existing 'text' / 'image'
-- modes in public.h3_live_jobs, WITHOUT touching how 'text' / 'image' jobs
-- are reserved, charged, or refunded:
--   - 'reference'  : 1-9 reference images, order not meaningful to the model
--                    beyond "Image N" labels.
--   - 'storyboard'  : 1-9 images whose order is treated as a time-ordered
--                    hint (see api/_lib/h3-live-fal.js submitReferenceJob).
--
-- Builds on (read, NOT modified):
--   20260831090000_create_h3_live_slice.sql       — h3_live_jobs, h3_live_controls,
--                                                    reserve/deduct/refund RPCs (v1)
--   20260905000000_fix_h3_live_image_upload_limit.sql — h3_live_image_uploads fix
--   20260911000000_h3_beta_pricing.sql             — public.h3_max_credit_cost(),
--                                                    reserve/deduct/refund RPCs (v2,
--                                                    CREATE OR REPLACE, same signature)
--                                                    now the current definition of
--                                                    reserve_h3_live_job_atomic /
--                                                    deduct_h3_live_credits_atomic /
--                                                    refund_h3_live_job_atomic.
--
-- This migration does NOT modify deduct_h3_live_credits_atomic or
-- refund_h3_live_job_atomic — reference/storyboard jobs are ordinary
-- public.h3_live_jobs rows and are charged/refunded through those exact same
-- functions, unchanged. It also does NOT modify reserve_h3_live_job_atomic
-- (the text/image reservation path) — it adds a SEPARATE new RPC,
-- reserve_h3_reference_job_atomic, for the new modes only.
--
-- Adds:
--   1. Widens public.h3_live_jobs.input_mode's CHECK constraint from
--      ('text','image') to ('text','image','reference','storyboard'). This is
--      the ONLY change to the existing h3_live_jobs table definition, and it
--      is purely additive (widens an allow-list; every existing row's
--      input_mode is already 'text' or 'image', so no existing row can
--      violate the new constraint). h3_live_jobs_image_mode_check (which ties
--      image_upload_id to input_mode='image') is untouched and unaffected:
--      reference/storyboard jobs always have image_upload_id = NULL, so that
--      constraint's `(input_mode = 'image') = (image_upload_id is not null)`
--      still holds (false = false).
--   2. public.h3_max_reference_uploads — one row per uploaded reference/
--      storyboard image slot (1-9 per job, independent bucket from the
--      existing single-image 'h3-live-image-quarantine').
--   3. public.h3_live_job_reference_images — join table binding a job to its
--      ordered set of uploads (image_order = 1..9, preserves the order the
--      caller supplied).
--   4. public.reserve_h3_reference_job_atomic(...) — the reference/storyboard
--      counterpart of reserve_h3_live_job_atomic: advisory-lock (SAME lock
--      namespace, 'h3_live:' || user_id, so it serialises with text/image
--      reservations for the same user) + kill-switch + idempotency-key +
--      one-active-job + H3-only cooldown (all shared with text/image via the
--      same h3_live_jobs table and h3_live_controls row) + atomic
--      check-and-bind of every h3_max_reference_uploads row + INSERT job +
--      INSERT ordered image rows. Uses public.h3_max_credit_cost() for the
--      stored price, exactly like the v2 reserve_h3_live_job_atomic added in
--      20260911000000_h3_beta_pricing.sql, so all four modes share one price
--      switch. service_role only.
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
--      AND table_name IN ('h3_max_reference_uploads', 'h3_live_job_reference_images');
--    -> If either returns a row, STOP and investigate before running.
--
-- 2. Function existence:
--    SELECT routine_name FROM information_schema.routines
--    WHERE routine_schema = 'public' AND routine_name = 'reserve_h3_reference_job_atomic';
--    -> If it returns a row, STOP and investigate before running.
--
-- 3. Confirm the CURRENT (v2, post-20260911000000) reserve/deduct/refund
--    function bodies are what this migration's header describes, so the
--    "does not modify them" claim is verified, not assumed:
--    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('reserve_h3_live_job_atomic', 'deduct_h3_live_credits_atomic',
--                         'refund_h3_live_job_atomic');
--    -> Expect deduct/refund bodies to reference v_job.credit_cost (not a
--       hardcoded 110), confirming 20260911000000 is already applied.
--
-- 4. Confirm every existing h3_live_jobs.input_mode value is already in the
--    narrower allow-list this migration widens FROM (sanity check only — the
--    new CHECK is a superset, so this cannot fail the ALTER either way):
--    SELECT DISTINCT input_mode FROM public.h3_live_jobs;
--    -> Expect only 'text' and/or 'image'.
--
-- 5. Verify AFTER migration — only service_role has EXECUTE:
--    SELECT grantee, privilege_type FROM information_schema.role_routine_grants
--    WHERE routine_schema = 'public' AND routine_name = 'reserve_h3_reference_job_atomic';
--
-- 6. Verify AFTER migration — new tables are service_role-only:
--    SELECT has_table_privilege('anon', 'public.h3_max_reference_uploads', 'SELECT')          AS anon_up,
--           has_table_privilege('authenticated', 'public.h3_max_reference_uploads', 'SELECT') AS auth_up,
--           has_table_privilege('service_role', 'public.h3_max_reference_uploads', 'SELECT')  AS svc_up;
--    -> anon_up and auth_up must both be false; svc_up true. Same check for
--       public.h3_live_job_reference_images.
-- ============================================================

begin;

-- ────────────────────────────────────────────────────────────────
-- 1. Widen h3_live_jobs.input_mode to allow 'reference' / 'storyboard'.
--    Purely additive: every existing row is 'text' or 'image', both still
--    allowed. h3_live_jobs_image_mode_check is untouched.
-- ────────────────────────────────────────────────────────────────
alter table public.h3_live_jobs
  drop constraint if exists h3_live_jobs_input_mode_check;
alter table public.h3_live_jobs
  add constraint h3_live_jobs_input_mode_check
  check (input_mode in ('text', 'image', 'reference', 'storyboard'));

-- ────────────────────────────────────────────────────────────────
-- 2. public.h3_max_reference_uploads — multi-image upload registry.
--    Independent bucket from 'h3-live-image-quarantine' (the existing
--    single-image mode's bucket, untouched). No storage.objects policies —
--    same posture as every other H3 bucket; access is service-role only via
--    api/_lib/h3-max-reference-image-store.js.
-- ────────────────────────────────────────────────────────────────
insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
values (
  'h3-max-reference-image-quarantine',
  'h3-max-reference-image-quarantine',
  false,
  20971520,                       -- 20 MiB; matches IMAGE_MAX_BYTES per file
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.h3_max_reference_uploads (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles(id) on delete cascade,

  storage_bucket        text not null default 'h3-max-reference-image-quarantine',
  storage_path          text not null unique,
  mime_type             text not null
                          check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size             integer not null check (byte_size >= 0 and byte_size <= 20971520),

  slot                  smallint not null check (slot between 1 and 9),

  moderation_status     text not null default 'pending'
                          check (moderation_status in ('pending', 'passed', 'blocked')),
  moderation_checked_at timestamptz,
  moderation_detail     jsonb,

  -- Set by reserve_h3_reference_job_atomic when this upload is bound into a
  -- job's ordered image set. No FK to h3_live_job_reference_images (that
  -- table carries the FK back to this one) — mirrors how
  -- h3_live_image_uploads.job_id relates to h3_live_jobs.
  job_id                uuid references public.h3_live_jobs(id) on delete set null,

  superseded_at         timestamptz,
  deleted_at            timestamptz,
  delete_after          timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint h3_max_reference_uploads_owned_path_check
    check (storage_path like ('uploads/' || user_id::text || '/%')),

  constraint h3_max_reference_uploads_moderated_at_check
    check ((moderation_status = 'pending') = (moderation_checked_at is null))
);

-- Sweep lookup: rows whose retention window has closed and are not yet deleted.
create index if not exists h3_max_reference_uploads_sweep_idx
  on public.h3_max_reference_uploads (delete_after)
  where deleted_at is null;

-- At most one still-usable (unbound, not deleted, not superseded) upload per
-- (user, slot) at a time — mirrors h3_live_image_uploads_one_pending_per_
-- user_idx's role for the single-image mode, but scoped per slot (1-9) since
-- one job can use up to 9 images at once.
create unique index if not exists h3_max_reference_uploads_one_active_per_slot_idx
  on public.h3_max_reference_uploads (user_id, slot)
  where job_id is null and deleted_at is null and superseded_at is null;

-- Lookup used by moderation / reservation to fetch a user's images by id.
create index if not exists h3_max_reference_uploads_user_idx
  on public.h3_max_reference_uploads (user_id, created_at desc);

alter table public.h3_max_reference_uploads enable row level security;

revoke all on table public.h3_max_reference_uploads from anon;
revoke all on table public.h3_max_reference_uploads from authenticated;
grant all on table public.h3_max_reference_uploads to service_role;

-- ────────────────────────────────────────────────────────────────
-- 3. public.h3_live_job_reference_images — ordered image set per job.
-- ────────────────────────────────────────────────────────────────
create table if not exists public.h3_live_job_reference_images (
  job_id       uuid not null references public.h3_live_jobs(id) on delete cascade,
  upload_id    uuid not null references public.h3_max_reference_uploads(id) on delete restrict,
  image_order  smallint not null check (image_order between 1 and 9),
  created_at   timestamptz not null default now(),

  primary key (job_id, image_order),
  -- One upload can be bound into at most one job's image set — enforced here
  -- in addition to h3_max_reference_uploads.job_id being set exactly once.
  constraint h3_live_job_reference_images_upload_unique unique (upload_id)
);

-- "at most 9 images per job" is enforced at the application layer (the new
-- RPC below validates array_length(p_upload_ids, 1) between 1 and 9 before
-- inserting) AND at the schema layer via image_order's CHECK (1..9) combined
-- with the (job_id, image_order) primary key — a 10th row for the same job
-- would need image_order = 10, which the CHECK rejects outright.

create index if not exists h3_live_job_reference_images_job_idx
  on public.h3_live_job_reference_images (job_id, image_order);

alter table public.h3_live_job_reference_images enable row level security;

revoke all on table public.h3_live_job_reference_images from anon;
revoke all on table public.h3_live_job_reference_images from authenticated;
grant all on table public.h3_live_job_reference_images to service_role;

-- ────────────────────────────────────────────────────────────────
-- 4. public.reserve_h3_reference_job_atomic — reserve a reference/storyboard job.
-- ────────────────────────────────────────────────────────────────
-- Returns the same row shape as reserve_h3_live_job_atomic:
--   job_id, code, retry_after_seconds, existing
-- code is one of (NULL on fresh reservation) 'service_disabled' |
-- 'active_job' | 'cooldown_active' | 'existing' | 'idempotency_conflict' |
-- 'invalid_upload_ids' | 'image_not_usable'.
--
-- p_upload_ids is an ORDERED uuid[] (1-9 entries, no duplicates). On success
-- every named h3_max_reference_uploads row is bound (job_id set) inside this
-- same transaction and public.h3_live_job_reference_images gets one row per
-- upload with image_order = its 1-based position in p_upload_ids.
--
-- Idempotent replay compares p_mode, p_instruction, and the ordered upload id
-- array against the stored job: any difference (including a pure reordering
-- of the same set) returns 'idempotency_conflict', never a silent resend.
create or replace function public.reserve_h3_reference_job_atomic(
  p_user_id         uuid,
  p_idempotency_key uuid,
  p_instruction     text,
  p_mode            text,
  p_upload_ids      uuid[]
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
  v_lock_key             bigint;
  v_enabled              boolean;
  v_existing_id          uuid;
  v_existing_mode        text;
  v_existing_instruction text;
  v_existing_upload_ids  uuid[];
  v_active_count         integer;
  v_finished_at          timestamptz;
  v_retry_after          integer;
  v_job_id               uuid;
  v_credit_cost          integer;
  v_count                integer;
  v_distinct_count       integer;
  v_upload_id            uuid;
  v_upload               public.h3_max_reference_uploads%rowtype;
  v_idx                  integer;
begin
  if p_user_id is null
     or p_idempotency_key is null
     or char_length(btrim(coalesce(p_instruction, ''))) < 1
     or char_length(btrim(coalesce(p_instruction, ''))) > 2000
     or p_mode not in ('reference', 'storyboard')
     or p_upload_ids is null
  then
    raise exception 'invalid_h3_reference_reservation'
      using errcode = 'check_violation';
  end if;

  v_count := array_length(p_upload_ids, 1);
  if v_count is null or v_count < 1 or v_count > 9 then
    return query select null::uuid, 'invalid_upload_ids'::text, 0, false;
    return;
  end if;

  select count(distinct u) into v_distinct_count from unnest(p_upload_ids) as u;
  if v_distinct_count <> v_count then
    return query select null::uuid, 'invalid_upload_ids'::text, 0, false;
    return;
  end if;

  -- Same lock namespace as reserve_h3_live_job_atomic (text/image) — a user
  -- can only ever have one reservation attempt of ANY H3 Max mode in flight
  -- at a time.
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

  -- Idempotent replay: same (user, key). Compare mode + instruction + the
  -- ordered upload id array (array `=` is order-sensitive in Postgres, so a
  -- pure reorder of the same set correctly falls through to conflict).
  select id, instruction, input_mode
    into v_existing_id, v_existing_instruction, v_existing_mode
    from public.h3_live_jobs
   where user_id = p_user_id
     and idempotency_key = p_idempotency_key;

  if found then
    select array_agg(upload_id order by image_order)
      into v_existing_upload_ids
      from public.h3_live_job_reference_images
     where job_id = v_existing_id;

    if v_existing_mode is distinct from p_mode
       or v_existing_instruction is distinct from btrim(p_instruction)
       or coalesce(v_existing_upload_ids, array[]::uuid[]) is distinct from p_upload_ids
    then
      return query select v_existing_id, 'idempotency_conflict'::text, 0, true;
    else
      return query select v_existing_id, 'existing'::text, 0, true;
    end if;
    return;
  end if;

  -- One active H3 Max job per user, shared across all four input modes
  -- (same h3_live_jobs table, same partial unique index
  -- h3_live_jobs_one_active_per_user_idx already enforces this at the
  -- storage layer regardless — this check exists purely to return a clean
  -- 'active_job' code instead of a raw unique-violation exception).
  select count(*)
    into v_active_count
    from public.h3_live_jobs
   where user_id = p_user_id
     and status in ('queued', 'submitting', 'processing');

  if v_active_count > 0 then
    return query select null::uuid, 'active_job'::text, 0, false;
    return;
  end if;

  -- H3-only cooldown, shared across all four modes (same table).
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

  -- Every named upload must be a clean, unbound, passed-moderation image
  -- owned by this user. Lock each row (FOR UPDATE) before validating so a
  -- concurrent reservation attempt using the same image cannot both pass.
  for v_idx in 1 .. v_count loop
    v_upload_id := p_upload_ids[v_idx];

    select *
      into v_upload
      from public.h3_max_reference_uploads
     where id = v_upload_id
     for update;

    if not found
       or v_upload.user_id <> p_user_id
       or v_upload.moderation_status <> 'passed'
       or v_upload.deleted_at is not null
       or v_upload.superseded_at is not null
       or v_upload.job_id is not null
    then
      return query select null::uuid, 'image_not_usable'::text, 0, false;
      return;
    end if;
  end loop;

  -- Same DB-authoritative price function as text/image (v2 reserve, added in
  -- 20260911000000_h3_beta_pricing.sql). All four H3 Max modes therefore
  -- always agree on the price in effect at reservation time.
  v_credit_cost := public.h3_max_credit_cost();
  if v_credit_cost not in (60, 130) then
    raise exception 'h3_reference_credit_cost_invalid' using errcode = 'check_violation';
  end if;

  insert into public.h3_live_jobs (
    user_id, idempotency_key, instruction, status,
    provider, duration_seconds, resolution, credit_cost,
    input_mode, image_upload_id
  )
  values (
    p_user_id, p_idempotency_key, btrim(p_instruction), 'queued',
    'fal', 15, '768p', v_credit_cost,
    p_mode, null
  )
  returning id into v_job_id;

  for v_idx in 1 .. v_count loop
    insert into public.h3_live_job_reference_images (job_id, upload_id, image_order)
    values (v_job_id, p_upload_ids[v_idx], v_idx);

    update public.h3_max_reference_uploads
       set job_id = v_job_id,
           updated_at = now()
     where id = p_upload_ids[v_idx];
  end loop;

  return query select v_job_id, null::text, 0, false;
end;
$$;

revoke all on function public.reserve_h3_reference_job_atomic(uuid, uuid, text, text, uuid[]) from public;
revoke all on function public.reserve_h3_reference_job_atomic(uuid, uuid, text, text, uuid[]) from anon;
revoke all on function public.reserve_h3_reference_job_atomic(uuid, uuid, text, text, uuid[]) from authenticated;
grant execute on function public.reserve_h3_reference_job_atomic(uuid, uuid, text, text, uuid[]) to service_role;

commit;

-- Rollback (if unexpected breakage is observed after applying):
--   begin;
--   drop function if exists public.reserve_h3_reference_job_atomic(uuid, uuid, text, text, uuid[]);
--   drop table if exists public.h3_live_job_reference_images;
--   drop table if exists public.h3_max_reference_uploads;
--   delete from storage.buckets where id = 'h3-max-reference-image-quarantine';
--   alter table public.h3_live_jobs drop constraint if exists h3_live_jobs_input_mode_check;
--   alter table public.h3_live_jobs add constraint h3_live_jobs_input_mode_check
--     check (input_mode in ('text', 'image'));
--   commit;
--   -- Only safe while no h3_live_jobs row has input_mode in
--   -- ('reference','storyboard') — check first:
--   --   SELECT count(*) FROM public.h3_live_jobs WHERE input_mode IN ('reference','storyboard');
--   -- Storage objects (if any) must be removed through the Storage API, not by
--   -- deleting storage.objects rows directly.
