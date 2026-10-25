-- Closed admin-only BETA storage and registry for Seedance 2.5 reference videos.
-- Browser roles receive no direct table or bucket policies. Uploads use a
-- server-issued signed upload token; all reads, inspection and deletion use
-- service_role on the Vercel/Railway servers.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'seedance-reference-video',
  'seedance-reference-video',
  false,
  52428800,
  array['video/mp4', 'image/jpeg']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.seedance_reference_video_uploads (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'uploading'
    check (status in ('uploading', 'checking', 'ready', 'blocked', 'failed')),
  staging_path text not null unique,
  approved_path text unique,
  review_paths jsonb not null default '[]'::jsonb,
  original_filename text,
  rights_confirmed_at timestamptz not null,
  declared_size_bytes bigint,
  size_bytes bigint,
  duration_ms integer,
  billable_seconds integer,
  width integer,
  height integer,
  fps numeric,
  video_codec text,
  sha256 text,
  inspection_attempts integer not null default 0,
  moderation_categories jsonb not null default '[]'::jsonb,
  last_task_id uuid references public.generation_tasks(id) on delete set null,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint seedance_reference_video_staging_owned_check
    check (staging_path = ('staging/' || user_id::text || '/' || id::text || '.mp4')),
  constraint seedance_reference_video_approved_owned_check
    check (approved_path is null or approved_path = ('approved/' || user_id::text || '/' || id::text || '.mp4')),
  constraint seedance_reference_video_duration_check
    check (duration_ms is null or duration_ms between 2000 and 15000),
  constraint seedance_reference_video_billable_check
    check (
      billable_seconds is null
      or (
        billable_seconds between 2 and 15
        and duration_ms is not null
        and billable_seconds = greatest(2, ceil(duration_ms / 1000.0)::integer)
      )
    ),
  constraint seedance_reference_video_sha_check
    check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  constraint seedance_reference_video_ready_complete_check
    check (
      status <> 'ready'
      or (
        approved_path is not null
        and size_bytes between 1 and 52428800
        and duration_ms is not null
        and billable_seconds is not null
        and video_codec = 'h264'
        and sha256 is not null
        and jsonb_typeof(review_paths) = 'array'
        and jsonb_array_length(review_paths) = 5
      )
    )
);

create index if not exists seedance_reference_video_user_created_idx
  on public.seedance_reference_video_uploads (user_id, created_at desc);
create index if not exists seedance_reference_video_expires_idx
  on public.seedance_reference_video_uploads (expires_at)
  where status in ('uploading', 'checking', 'ready', 'blocked', 'failed');

alter table public.seedance_reference_video_uploads enable row level security;
revoke all on table public.seedance_reference_video_uploads from public, anon, authenticated;
grant select, insert, update, delete on table public.seedance_reference_video_uploads to service_role;

-- Atomically claims an upload for inspection. Concurrent confirmations return
-- busy; a request whose response was lost may be reclaimed after five minutes.
create or replace function public.claim_seedance_reference_video_inspection(
  p_asset_id uuid,
  p_user_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.seedance_reference_video_uploads%rowtype;
begin
  select * into v_row
  from public.seedance_reference_video_uploads
  where id = p_asset_id and user_id = p_user_id
  for update;

  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if v_row.status = 'ready' then return jsonb_build_object('ok', true, 'code', 'ready'); end if;
  if v_row.status in ('blocked', 'failed') then
    return jsonb_build_object('ok', false, 'code', v_row.status);
  end if;
  if v_row.inspection_attempts >= 3 then
    update public.seedance_reference_video_uploads
      set status = 'failed', updated_at = now()
      where id = p_asset_id;
    return jsonb_build_object('ok', false, 'code', 'attempt_limit');
  end if;
  if v_row.status = 'checking' and v_row.updated_at > now() - interval '5 minutes' then
    return jsonb_build_object('ok', false, 'code', 'busy');
  end if;

  update public.seedance_reference_video_uploads
    set status = 'checking',
        inspection_attempts = inspection_attempts + 1,
        expires_at = greatest(expires_at, now() + interval '1 hour'),
        updated_at = now()
    where id = p_asset_id;
  return jsonb_build_object('ok', true, 'code', 'claimed');
end;
$$;

revoke all on function public.claim_seedance_reference_video_inspection(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_seedance_reference_video_inspection(uuid, uuid)
  to service_role;

