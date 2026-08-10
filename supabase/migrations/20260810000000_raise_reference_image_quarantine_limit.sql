-- Raise reference-image-quarantine bucket's file_size_limit from 10MB to 20MB
-- to match the new client-direct-upload flow's MAX_FILE_BYTES
-- (api/reference-image-upload-url.js / api/reference-image-confirm-upload.js).
--
-- Re-running this migration is safe: it only updates the existing bucket row.

update storage.buckets
set file_size_limit = 20971520 -- 20 * 1024 * 1024
where id = 'reference-image-quarantine';
