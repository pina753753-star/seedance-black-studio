-- Private source-audio storage for Seedance 2.5 reference_audios.
-- Browser uploads use server-issued signed upload URLs. No storage policies are
-- created, so anon/authenticated users cannot list or read another user's music.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'seedance-reference-audio',
  'seedance-reference-audio',
  false,
  15728640,
  array['audio/mpeg']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
