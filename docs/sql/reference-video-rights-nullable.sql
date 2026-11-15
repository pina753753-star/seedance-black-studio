-- Historical draft; applied 2026-11-15 as migration 20261115142749.
-- Canonical SQL: supabase/migrations/20261115142749_allow_reference_video_without_per_upload_attestation.sql
-- Do not backfill consent or rewrite historical confirmations.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE public.seedance_reference_video_uploads
  ALTER COLUMN rights_confirmed_at DROP NOT NULL;
COMMENT ON COLUMN public.seedance_reference_video_uploads.rights_confirmed_at IS
  'Legacy client self-attestation received at upload when rightsConfirmed is strictly true; NULL means no explicit attestation recorded. Not proof of rights or terms acceptance.';
COMMIT;
