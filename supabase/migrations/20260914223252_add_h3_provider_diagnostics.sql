-- Add nullable, service-only diagnostics for H3 Max queued generations.
-- Existing jobs and billing state are unchanged. These fields let operators
-- compare the exact submitted prompt with fal's expanded prompt and reproduce
-- a result by seed without exposing either value through sanitizeJob().

begin;

alter table public.h3_live_jobs
  add column if not exists provider_prompt text,
  add column if not exists provider_expanded_prompt text,
  add column if not exists provider_seed bigint,
  add column if not exists provider_timings jsonb;

alter table public.h3_live_jobs
  drop constraint if exists h3_live_jobs_provider_prompt_length_check;
alter table public.h3_live_jobs
  add constraint h3_live_jobs_provider_prompt_length_check
  check (provider_prompt is null or char_length(provider_prompt) between 1 and 50000);

alter table public.h3_live_jobs
  drop constraint if exists h3_live_jobs_provider_expanded_prompt_length_check;
alter table public.h3_live_jobs
  add constraint h3_live_jobs_provider_expanded_prompt_length_check
  check (provider_expanded_prompt is null or char_length(provider_expanded_prompt) between 1 and 50000);

alter table public.h3_live_jobs
  drop constraint if exists h3_live_jobs_provider_timings_object_check;
alter table public.h3_live_jobs
  add constraint h3_live_jobs_provider_timings_object_check
  check (provider_timings is null or jsonb_typeof(provider_timings) = 'object');

comment on column public.h3_live_jobs.provider_prompt is
  'Exact prompt submitted by Pina Studio to fal for this H3 Max job.';
comment on column public.h3_live_jobs.provider_expanded_prompt is
  'Expanded prompt returned by fal; nullable when the provider does not expose it.';
comment on column public.h3_live_jobs.provider_seed is
  'Reproduction seed returned by fal; nullable when unavailable.';
comment on column public.h3_live_jobs.provider_timings is
  'Finite numeric timing metrics returned by fal; nullable when unavailable.';

commit;
