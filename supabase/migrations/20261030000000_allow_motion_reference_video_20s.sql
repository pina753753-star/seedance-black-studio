-- Motion (Kling) reference videos may be up to 20 s. Only the two upper bounds change
-- (15 s -> 20 s); lower bounds, the billable-seconds formula, ownership checks, RLS, grants and
-- existing rows are untouched. The Seedance dance keeps its own 15 s limit in application code
-- (validateReadyReferenceDance), so a 16-20 s row can never be used by it.
--
-- Rollout order: (1) apply this migration, (2) deploy the inspection service (Railway) with the
-- motion profile, (3) deploy the API/UI, (4) only then set klingDance.config.maxUseSeconds to 20.
--
-- Stopping / rollback (no data is ever deleted):
--   1. close the application gate: klingDance.config.maxUseSeconds back to 10 (one constant, api/_lib/reference-dance.js).
--      This stops NEW motion acceptance above 10 s. Existing 16-20 s assets, tasks (polling, completion, refund) and
--      history keep working: the stored-data bound (20 s) is separate from the gate.
--   2. LEAVE these relaxed constraints in place. With the gate closed nothing writes a row longer than 15 s, and the
--      previous application/inspector builds never read a longer row into anything unsafe (the Seedance dance rejects
--      it at its 15 s limit). Restoring the 15 s constraints is NOT part of the rollback: once a 16-20 s row exists a plain
--      ADD CONSTRAINT would fail, and fixing that would require deleting or rewriting user data, which is not done.
begin;

alter table public.seedance_reference_video_uploads
  drop constraint if exists seedance_reference_video_duration_check;
alter table public.seedance_reference_video_uploads
  add constraint seedance_reference_video_duration_check
  check (duration_ms is null or duration_ms between 2000 and 20000);

alter table public.seedance_reference_video_uploads
  drop constraint if exists seedance_reference_video_billable_check;
alter table public.seedance_reference_video_uploads
  add constraint seedance_reference_video_billable_check
  check (
    billable_seconds is null
    or (
      billable_seconds between 2 and 20
      and duration_ms is not null
      and billable_seconds = greatest(2, ceil(duration_ms / 1000.0)::integer)
    )
  );

commit;
