-- H3 Live — fix the image-upload "one pending upload per user" limit.
--
-- Follow-up to 20260831090000_create_h3_live_slice.sql (already applied to
-- production; that file is NOT modified here — rewriting an applied
-- migration would break migration history). Code review (chatgpt-codex-
-- connector, 2026-09-02, PR #224) found that
-- h3_live_image_uploads_one_bound_per_job_idx does not enforce the limit its
-- own comment described:
--
--   create unique index ... on public.h3_live_image_uploads (job_id)
--     where job_id is not null;
--
-- Every newly issued upload slot has job_id = NULL, so this index only ever
-- constrains rows that are ALREADY bound to a job — it says nothing about how
-- many *unbound* rows one user can accumulate. The application code
-- (api/_lib/h3-live-image-store.js createImageUploadSlot) inserted a fresh
-- row on every call with no check at all, so an eligible-plan caller could
-- repeatedly call POST /api/h3-live/image-upload-url and accumulate unlimited
-- 20 MiB objects, each persisting up to 48h (IMAGE_UPLOAD_RETENTION_MS) —
-- storage/DB exhaustion.
--
-- This migration:
--   1. Adds a new nullable column, superseded_at timestamptz. Set exactly
--      when createImageUploadSlot supersedes a user's still-pending upload
--      with a new one (see expirePendingUpload in h3-live-image-store.js).
--      Needed because of a second issue found while implementing the first
--      review round's fix (self-discovered, not from the original PR #224
--      thread): Supabase Storage's createSignedUploadUrl token has a fixed,
--      non-configurable ~2h expiry with no revoke API, so a caller that
--      already holds a superseded slot's signed URL can still write a new
--      object to that exact object_path after it is superseded. Stamping
--      deleted_at immediately on supersede (the first draft of this
--      migration/fix did that) would make such a resurrected object
--      permanently invisible to sweepStaleUploads (which filters
--      deleted_at IS NULL) — an unsweepable orphan, i.e. the same class of
--      storage-exhaustion problem this migration exists to close. Leaving
--      deleted_at untouched on supersede (so a later opportunistic sweep
--      still re-checks the object) instead requires a way to make the
--      superseded row stop counting toward the "one pending upload" limit
--      immediately — hence this column and the predicate below.
--   2. Drops h3_live_image_uploads_one_bound_per_job_idx. It provided no real
--      protection beyond what application logic already guarantees (only
--      reserve_h3_live_job_atomic ever sets job_id, and it does so with an
--      UPDATE targeting exactly one row by id — so two rows can never
--      legitimately share a job_id) and its comment mis-described it as the
--      per-user cap, which it never was.
--   3. Adds h3_live_image_uploads_one_pending_per_user_idx — a partial unique
--      index on (user_id) WHERE job_id IS NULL AND deleted_at IS NULL AND
--      superseded_at IS NULL. This is the actual "at most one still-pending,
--      not-yet-superseded upload per user" constraint the original index's
--      comment intended.
--   4. Replaces public.reserve_h3_live_job_atomic (CREATE OR REPLACE; same
--      signature, so existing REVOKE/GRANT privileges on it are unaffected —
--      they attach to the function's OID, which CREATE OR REPLACE preserves)
--      to also reject an image upload whose superseded_at is not null.
--      Found in the second Codex review round on this same migration/fix:
--      the RPC's own "is this upload usable" check (originally: owned by
--      this user, moderation_status = 'passed', not deleted, not already
--      bound to a job) never looked at superseded_at, so it did not by
--      itself guarantee a superseded upload cannot be reserved into a job.
--      In practice api/h3-live/start.js's pre-reservation step re-downloads
--      and re-moderates the actual object on every fresh (uncharged) attempt
--      (see the comment there above the downloadAndValidate call), and a
--      superseded row's object has normally already been removed by
--      expirePendingUpload — so that unrelated safeguard happens to reject
--      the common case with quarantine_object_not_found before any charge.
--      The gap this closes is the narrower case point 1 above describes: a
--      caller who resurrects a superseded object_path with a retained,
--      unrevocable signed upload token inside the deferred sweep window.
--      Adding the check here makes "superseded = not reservable" hold at the
--      one place actually responsible for that invariant, instead of by
--      incidental behavior of a different subsystem.
--
-- Paired app-code change (same PR, already applied to these files):
-- createImageUploadSlot calls the new expirePendingUpload (instead of the
-- existing deleteUploadObject) on any of the caller's prior still-pending
-- uploads before inserting a new one, so ordinary use (pick a different
-- image) never hits this constraint — the new index is a backstop against
-- retries/races/scripted abuse, not the primary UX gate. expirePendingUpload
-- removes the object immediately (best effort) and stamps superseded_at, but
-- defers deleted_at until a later opportunistic sweep, once any retained
-- signed upload URL for that row is guaranteed expired.
--
-- Touches public.h3_live_image_uploads (one add column, one drop index, one
-- create index) and replaces one existing function,
-- public.reserve_h3_live_job_atomic (same signature — a CREATE OR REPLACE,
-- not a new object). Does not touch h3_live_controls, h3_live_jobs, the
-- other 2 h3_live_* functions, the h3-live-image-quarantine bucket row, the 2
-- credit_transactions_h3_live_* indexes, or any object outside the H3 Live
-- slice.
--
-- Confirmed by the operator (read-only check, 2026-09-0X): public.
-- h3_live_image_uploads has 0 rows in production, so the ADD COLUMN, the DROP
-- INDEX, and the new CREATE UNIQUE INDEX all apply with nothing to scan/
-- rewrite and no risk of the new index failing on a pre-existing duplicate.
-- ADD COLUMN ... timestamptz (nullable, no default) is a metadata-only change
-- in Postgres (no table rewrite, no default value to backfill). CREATE INDEX
-- (non-concurrent) takes a SHARE lock on the table for the statement's
-- duration (blocks writes, not reads) — on an empty table this is
-- effectively instantaneous. CREATE OR REPLACE FUNCTION does not depend on
-- row counts at all — it only swaps the function's body and takes no lock
-- on h3_live_image_uploads, only a brief lock on the function's own catalog
-- row for the statement's duration.
--
-- DO NOT run against production without explicit approval.
--
-- ============================================================
-- PRE-CHECK QUERIES (run read-only before executing this file)
-- ============================================================
--
-- 1. Confirm no user already has more than one pending (unbound, not
--    soft-deleted, not superseded) upload — this is the exact condition that
--    would make the new unique index fail to build. superseded_at does not
--    exist yet at pre-check time, so this checks the two columns that do:
--    SELECT user_id, count(*) FROM public.h3_live_image_uploads
--    WHERE job_id IS NULL AND deleted_at IS NULL
--    GROUP BY user_id HAVING count(*) > 1;
--    -> If this returns any row, STOP: resolve those duplicates (e.g. soft-
--       delete all but the newest per user_id) before running this file.
--
-- 2. Confirm the old index still exists (sanity check that this migration
--    has not already been applied):
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexname = 'h3_live_image_uploads_one_bound_per_job_idx';
--    -> Expect exactly 1 row. If 0 rows, this migration (or an equivalent
--       change) may already be applied — investigate before running.
--
-- 3. Confirm the new index does not already exist:
--    SELECT indexname FROM pg_indexes
--    WHERE schemaname = 'public'
--      AND indexname = 'h3_live_image_uploads_one_pending_per_user_idx';
--    -> If it returns a row, STOP and investigate before running.
--
-- 4. Confirm the new column does not already exist:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'h3_live_image_uploads'
--      AND column_name = 'superseded_at';
--    -> If it returns a row, STOP and investigate before running.
--
-- 5. (informational only — not a stop condition) Inspect the function this
--    migration is about to replace, to confirm it is still the version from
--    20260831090000_create_h3_live_slice.sql and not something changed since:
--    SELECT pg_get_functiondef(p.oid) FROM pg_proc p
--    JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'reserve_h3_live_job_atomic';
--    -> Expect the body to check moderation_status/deleted_at/job_id but NOT
--       superseded_at (that check is what this migration adds). If it
--       already checks superseded_at, this migration (or an equivalent
--       change) may already be applied — investigate before running.
-- ============================================================

begin;

alter table public.h3_live_image_uploads
  add column if not exists superseded_at timestamptz;

drop index if exists public.h3_live_image_uploads_one_bound_per_job_idx;

-- At most one still-pending (unbound, not soft-deleted, not superseded)
-- upload row per user. This is the constraint the original index's comment
-- described but its predicate (job_id IS NOT NULL) never actually enforced.
create unique index if not exists h3_live_image_uploads_one_pending_per_user_idx
  on public.h3_live_image_uploads (user_id)
  where job_id is null and deleted_at is null and superseded_at is null;

-- Identical to the function created in 20260831090000_create_h3_live_slice.sql
-- except for one added line in the image-mode "is this upload usable" check
-- (marked below). Must run after the ADD COLUMN above so that
-- v_upload public.h3_live_image_uploads%rowtype includes superseded_at.
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

  -- Image mode: the frame must be a clean, unbound, non-superseded upload
  -- owned by this user. superseded_at is checked here (added by this
  -- migration; see the header comment above) so this invariant holds even
  -- in the narrow window where a caller has resurrected a superseded
  -- object_path with a retained, unrevocable signed upload token — it does
  -- not rely solely on api/h3-live/start.js's pre-reservation re-moderation
  -- happening to reject the common case (object already removed from
  -- storage) with quarantine_object_not_found before this function ever runs.
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
       or v_upload.superseded_at is not null
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

commit;

-- Rollback (if unexpected breakage is observed after applying):
--   The function restore MUST run before the DROP COLUMN below, in the same
--   transaction: dropping superseded_at while the deployed function body
--   still references v_upload.superseded_at would break
--   reserve_h3_live_job_atomic on its very next call. Restoring the
--   original body first (with the column still present) is always safe
--   regardless of exactly when Postgres would validate the reference.
--   begin;
--   create or replace function public.reserve_h3_live_job_atomic(
--     p_user_id         uuid,
--     p_idempotency_key uuid,
--     p_instruction     text,
--     p_input_mode      text default 'text',
--     p_image_upload_id uuid default null
--   )
--   returns table (
--     job_id              uuid,
--     code                text,
--     retry_after_seconds integer,
--     existing            boolean
--   )
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $$
--   declare
--     v_lock_key                  bigint;
--     v_enabled                   boolean;
--     v_existing_id               uuid;
--     v_existing_instruction      text;
--     v_existing_image_upload_id  uuid;
--     v_active_count              integer;
--     v_finished_at               timestamptz;
--     v_retry_after               integer;
--     v_job_id                    uuid;
--     v_upload                    public.h3_live_image_uploads%rowtype;
--   begin
--     if p_user_id is null
--        or p_idempotency_key is null
--        or char_length(btrim(coalesce(p_instruction, ''))) < 1
--        or char_length(btrim(coalesce(p_instruction, ''))) > 2000
--        or coalesce(p_input_mode, 'text') not in ('text', 'image')
--        or (coalesce(p_input_mode, 'text') = 'image' and p_image_upload_id is null)
--        or (coalesce(p_input_mode, 'text') = 'text' and p_image_upload_id is not null)
--     then
--       raise exception 'invalid_h3_live_reservation'
--         using errcode = 'check_violation';
--     end if;
--     v_lock_key := hashtext('h3_live:' || p_user_id::text)::bigint;
--     if not pg_try_advisory_xact_lock(v_lock_key) then
--       return query select null::uuid, 'active_job'::text, 0, false;
--       return;
--     end if;
--     select enabled
--       into v_enabled
--       from public.h3_live_controls
--      where control_key = 'h3_live';
--     if coalesce(v_enabled, false) is not true then
--       return query select null::uuid, 'service_disabled'::text, 0, false;
--       return;
--     end if;
--     select id, instruction, image_upload_id
--       into v_existing_id, v_existing_instruction, v_existing_image_upload_id
--       from public.h3_live_jobs
--      where user_id = p_user_id
--        and idempotency_key = p_idempotency_key;
--     if found then
--       if v_existing_instruction is distinct from btrim(p_instruction)
--          or v_existing_image_upload_id is distinct from p_image_upload_id
--       then
--         return query select v_existing_id, 'idempotency_conflict'::text, 0, true;
--       else
--         return query select v_existing_id, 'existing'::text, 0, true;
--       end if;
--       return;
--     end if;
--     select count(*)
--       into v_active_count
--       from public.h3_live_jobs
--      where user_id = p_user_id
--        and status in ('queued', 'submitting', 'processing');
--     if v_active_count > 0 then
--       return query select null::uuid, 'active_job'::text, 0, false;
--       return;
--     end if;
--     select max(finished_at)
--       into v_finished_at
--       from public.h3_live_jobs
--      where user_id = p_user_id
--        and finished_at is not null;
--     if v_finished_at is not null
--        and v_finished_at + interval '10 seconds' > now()
--     then
--       v_retry_after := greatest(
--         1,
--         least(
--           10,
--           ceil(extract(epoch from (v_finished_at + interval '10 seconds' - now())))::integer
--         )
--       );
--       return query select null::uuid, 'cooldown_active'::text, v_retry_after, false;
--       return;
--     end if;
--     if p_input_mode = 'image' then
--       select *
--         into v_upload
--         from public.h3_live_image_uploads
--        where id = p_image_upload_id
--        for update;
--       if not found
--          or v_upload.user_id <> p_user_id
--          or v_upload.moderation_status <> 'passed'
--          or v_upload.deleted_at is not null
--          or v_upload.job_id is not null
--       then
--         return query select null::uuid, 'image_not_usable'::text, 0, false;
--         return;
--       end if;
--     end if;
--     insert into public.h3_live_jobs (
--       user_id, idempotency_key, instruction, status,
--       provider, duration_seconds, resolution, credit_cost,
--       input_mode, image_upload_id
--     )
--     values (
--       p_user_id, p_idempotency_key, btrim(p_instruction), 'queued',
--       'fal', 15, '768p', 110,
--       coalesce(p_input_mode, 'text'), p_image_upload_id
--     )
--     returning id into v_job_id;
--     if p_input_mode = 'image' then
--       update public.h3_live_image_uploads
--          set job_id = v_job_id,
--              updated_at = now()
--        where id = p_image_upload_id;
--     end if;
--     return query select v_job_id, null::text, 0, false;
--   end;
--   $$;
--   drop index if exists public.h3_live_image_uploads_one_pending_per_user_idx;
--   create unique index if not exists h3_live_image_uploads_one_bound_per_job_idx
--     on public.h3_live_image_uploads (job_id)
--     where job_id is not null;
--   alter table public.h3_live_image_uploads drop column if exists superseded_at;
--   commit;
--   -- Dropping superseded_at discards which rows had been marked superseded;
--   -- since rollback also reopens the unlimited-pending-uploads gap this
--   -- migration exists to close, that is consistent with reverting to the
--   -- pre-fix state. Reverting also means expirePendingUpload's supersede
--   -- marking (h3-live-image-store.js) has no column to write to — that app
--   -- code would need to be rolled back together with this migration, not
--   -- left running against the reverted schema.
