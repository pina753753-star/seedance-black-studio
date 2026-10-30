-- iPhone screen recordings (.mov) arrive as video/quicktime. supabase-js uploads a File as multipart form data and
-- keeps the file's own type, so the private staging bucket must accept video/quicktime. Nothing else changes: the
-- existing allowed types are kept, and visibility (private), the 50 MB limit, RLS, signed upload URLs and every
-- permission stay as they are. The worker still probes the uploaded bytes and normalizes to H.264 MP4.
--
-- Idempotent: running it again leaves the list unchanged. Independent of the 20 s constraint migration.
-- Rollback (only if ever needed): remove 'video/quicktime' from allowed_mime_types of this one bucket.
update storage.buckets
set allowed_mime_types = array_append(allowed_mime_types, 'video/quicktime')
where id = 'seedance-reference-video'
  and allowed_mime_types is not null
  and not ('video/quicktime' = any(allowed_mime_types));
