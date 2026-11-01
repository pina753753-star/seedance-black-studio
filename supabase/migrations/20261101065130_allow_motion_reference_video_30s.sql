-- Follow-up to the applied 20-second migration; only upper bounds change.
-- Preserve lower bounds, ceil billing, RLS, existing rows and existing 20s history.
-- Deploy DB, then motion worker, then API/UI. Keep relaxed DB bounds on rollback.
begin;

alter table public.seedance_reference_video_uploads
  drop constraint if exists seedance_reference_video_duration_check;
alter table public.seedance_reference_video_uploads
  add constraint seedance_reference_video_duration_check
  check (duration_ms is null or duration_ms between 2000 and 30000);

alter table public.seedance_reference_video_uploads
  drop constraint if exists seedance_reference_video_billable_check;
alter table public.seedance_reference_video_uploads
  add constraint seedance_reference_video_billable_check
  check (
    billable_seconds is null
    or (
      billable_seconds between 2 and 30
      and duration_ms is not null
      and billable_seconds = greatest(2, ceil(duration_ms / 1000.0)::integer)
    )
  );

commit;
