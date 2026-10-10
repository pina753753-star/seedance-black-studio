-- Adds an explicit public-sample flag to generated_videos so the public
-- top-page sample query (readGeneratedVideos in api/generated-videos.js)
-- can select curated rows instead of implicitly trusting every completed
-- row. This migration only adds a column, sets two known-healthy rows,
-- and creates a partial index. It does not touch RLS, REVOKE, or GRANT.

do $$
begin
  -- This retired table exists on older production databases but is absent
  -- from clean preview databases. Apply the data migration only where the
  -- table still exists.
  if to_regclass('public.generated_videos') is not null then
    execute 'alter table public.generated_videos add column if not exists is_public_sample boolean not null default false';

    -- Mark the two known-healthy sample videos as public. These rows have a
    -- valid prompt and a verified Supabase Storage video_uri. The other two
    -- rows sharing the same video_uri values have a null prompt and are
    -- duplicate/unhealthy data that must stay non-public.
    execute $statement$
      update public.generated_videos
      set is_public_sample = true
      where id in (
        '13a41b1c-74e0-4a60-b13a-3b018c8e129e',
        '8d5287c4-f943-4f40-bc88-7a1f30edca71'
      )
    $statement$;

    -- Partial index: only public-sample rows need to be scanned by the public
    -- listing query, so index just the flagged subset ordered by recency.
    execute 'create index if not exists idx_generated_videos_public_sample on public.generated_videos (created_at desc) where is_public_sample = true';
  end if;
end
$$;
