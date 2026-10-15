-- FlowVid Studio:
-- Restrict the retired flowvid_video_history table to server-side access only.
--
-- Current application history is sourced from public.generation_tasks.
-- The legacy video-history API and flowvid_video_history fallback have already
-- been retired.
--
-- This migration:
-- - does not delete the table
-- - does not delete or update existing rows
-- - does not change generation_tasks
-- - does not change video generation, credits, Stripe, or Storage
--
-- Do not apply to production without explicit human approval.
DO $$
BEGIN
  -- Fresh preview databases never contained this retired legacy table.
  -- Keep the hardening for older databases without blocking clean rebuilds.
  IF to_regclass('public.flowvid_video_history') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.flowvid_video_history FROM PUBLIC';
    EXECUTE 'REVOKE ALL ON TABLE public.flowvid_video_history FROM anon';
    EXECUTE 'REVOKE ALL ON TABLE public.flowvid_video_history FROM authenticated';
    EXECUTE 'GRANT ALL ON TABLE public.flowvid_video_history TO service_role';
    EXECUTE 'ALTER TABLE public.flowvid_video_history ENABLE ROW LEVEL SECURITY';
  END IF;
END
$$;
