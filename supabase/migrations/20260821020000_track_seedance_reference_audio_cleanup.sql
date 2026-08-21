-- Track private Seedance reference audio so abandoned uploads can be removed
-- through the Storage API. No client role receives direct table access.

create table if not exists public.seedance_reference_audio_uploads (
  path text primary key,
  user_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint seedance_reference_audio_uploads_owned_path_check
    check (path like ('users/' || user_id::text || '/%.mp3'))
);

create index if not exists seedance_reference_audio_uploads_expires_at_idx
  on public.seedance_reference_audio_uploads (expires_at);

alter table public.seedance_reference_audio_uploads enable row level security;
revoke all on table public.seedance_reference_audio_uploads from public, anon, authenticated;
grant select, insert, update, delete on table public.seedance_reference_audio_uploads to service_role;
