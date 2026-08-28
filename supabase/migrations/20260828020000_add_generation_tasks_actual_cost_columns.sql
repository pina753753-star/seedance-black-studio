-- Add columns to record the actual provider-side cost (OpenRouter/WaveSpeed)
-- for a generation task, looked up after the fact via each provider's
-- per-generation billing API. This is metadata only: it does not affect
-- credit deduction, refunds, or the generation flow itself.
--
-- Context: 2026-08-27〜28, two Seedance 2.5 720p tasks completed on the
-- provider side but returned no video URL (completed-no-url-timeout),
-- and were fully refunded to the user. There was previously no way to
-- record what the actual provider-side charge was for such tasks.
--
-- Both columns are nullable with no default, so existing rows are
-- unaffected and no backfill is required. Population is done by
-- application code (api/seedance-status.js), not by this migration.
--
-- Rollback: DROP COLUMN actual_cost_usd, DROP COLUMN actual_cost_checked_at
-- on public.generation_tasks (safe: no other object depends on these
-- columns as of this migration).

ALTER TABLE public.generation_tasks
  ADD COLUMN actual_cost_usd numeric,
  ADD COLUMN actual_cost_checked_at timestamptz;

COMMENT ON COLUMN public.generation_tasks.actual_cost_usd IS
  'Actual provider-side cost in USD, fetched after the fact from OpenRouter (GET /api/v1/generation) or WaveSpeed (POST /api/v3/billings/search). NULL = not looked up, or lookup failed.';
COMMENT ON COLUMN public.generation_tasks.actual_cost_checked_at IS
  'Timestamp of the last attempt to fetch actual_cost_usd, regardless of success. NULL = never attempted.';
