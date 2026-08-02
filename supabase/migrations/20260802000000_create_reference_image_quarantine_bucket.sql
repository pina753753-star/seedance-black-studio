-- Create a private quarantine bucket for reference images before safety checks.
--
-- This migration intentionally creates no storage.objects policies.
-- Only trusted server-side code using the Supabase service role may read,
-- write, move, or delete objects in this bucket.
--
-- Re-running this migration is safe: the existing bucket is updated to the
-- required private configuration instead of creating a duplicate.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'reference-image-quarantine',
  'reference-image-quarantine',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
