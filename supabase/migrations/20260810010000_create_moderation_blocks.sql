-- Records content-policy blocks that happen before any generation_tasks row
-- is created (api/_lib/seedance-start.js rejects the request with 422/503
-- before task creation, credit deduction, or the OpenRouter call). Until now
-- this information only existed as a console.warn in Vercel runtime logs and
-- was never visible in admin.html.
--
-- Admin-only read access mirrors the existing generation_tasks RLS pattern
-- (public.is_admin(), defined in 20260624000000_initial_flowvid_schema.sql).
-- Rows are inserted only by trusted server-side code using the service role
-- key, which bypasses RLS, so no INSERT policy is defined here.

create table public.moderation_blocks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  mode text,
  categories text[] not null default '{}',
  reason text,
  classification jsonb,
  prompt text not null
);

create index moderation_blocks_created_at_idx on public.moderation_blocks (created_at desc);
create index moderation_blocks_user_id_idx on public.moderation_blocks (user_id);

alter table public.moderation_blocks enable row level security;

create policy "Admins can read moderation blocks"
  on public.moderation_blocks
  for select
  using (public.is_admin());
