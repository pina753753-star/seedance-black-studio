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
BEGIN;
REVOKE ALL ON TABLE public.flowvid_video_history
FROM PUBLIC;
REVOKE ALL ON TABLE public.flowvid_video_history
FROM anon;
REVOKE ALL ON TABLE public.flowvid_video_history
FROM authenticated;
GRANT ALL ON TABLE public.flowvid_video_history
TO service_role;
ALTER TABLE public.flowvid_video_history
ENABLE ROW LEVEL SECURITY;
COMMIT;
