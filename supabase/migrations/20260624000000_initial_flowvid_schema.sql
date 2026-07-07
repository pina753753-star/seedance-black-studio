-- FlowVid Studio baseline migration
--
-- The original base schema lived only in supabase/schema.sql and
-- supabase/setup-01..03 (applied manually via the SQL Editor) and was never
-- present under supabase/migrations. Supabase Git Branching applies only
-- supabase/migrations in order, so Preview branches failed on the first
-- migration (20260625_add_ultimate_plan.sql) with:
--   ERROR: relation "public.profiles" does not exist (SQLSTATE 42P01)
--
-- This baseline recreates the schema exactly as it existed BEFORE
-- 20260625_add_ultimate_plan.sql (source: git history at commit 5aabde4,
-- the last supabase/ change before the 20260625 migration). In particular,
-- profiles_plan_check is created WITHOUT 'ultimate' — the 20260625 migration
-- adds it, matching that migration's documented pre-state.
--
-- Schema objects only: no seed data, no production data, no user rows.
-- All statements are guarded (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS)
-- so this is a no-op-safe baseline on a database where the schema already
-- exists (e.g. production, where it was applied manually).

-- Extensions (gen_random_uuid; built into PG13+, pgcrypto kept for parity)
create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────────
-- 1. Tables (dependency order: profiles → balances/transactions/tasks → assets)
-- ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'user'
    constraint profiles_role_check check (role in ('user', 'admin')),
  plan text not null default 'free'
    constraint profiles_plan_check check (plan in ('free', 'standard', 'premium', 'scale', 'team')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_balances (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  free_credits integer not null default 0 check (free_credits >= 0),
  subscription_credits integer not null default 0 check (subscription_credits >= 0),
  purchased_credits integer not null default 0 check (purchased_credits >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null,
  credit_type text not null check (credit_type in ('free', 'subscription', 'purchased')),
  reason text not null,
  related_task_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.generation_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('text_to_video', 'image_to_video', 'reference_to_video')),
  model text not null default 'seedance-2.0',
  prompt text not null,
  resolution text not null default '480p',
  duration_seconds integer not null default 5,
  aspect_ratio text not null default 'auto',
  credit_cost integer not null default 0,
  status text not null default 'draft' check (status in ('draft', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  api_provider text,
  api_task_id text,
  output_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generation_assets (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.generation_tasks(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  asset_kind text not null check (asset_kind in ('image', 'video')),
  reference_name text not null,
  file_name text,
  storage_path text,
  public_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.sample_gallery_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null,
  thumbnail_url text,
  video_url text,
  prompt_sample text,
  is_published boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ────────────────────────────────────────────────────────────────
-- 2. Row Level Security
-- ────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.credit_balances enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.generation_tasks enable row level security;
alter table public.generation_assets enable row level security;
alter table public.sample_gallery_items enable row level security;

-- ────────────────────────────────────────────────────────────────
-- 3. Admin helper function (needed by admin policies below)
-- ────────────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ────────────────────────────────────────────────────────────────
-- 4. Policies (drop-if-exists for repeat safety)
-- ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can read own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users can read own credit balance" ON public.credit_balances;
DROP POLICY IF EXISTS "Users can read own credit transactions" ON public.credit_transactions;
DROP POLICY IF EXISTS "Users can read own generation tasks" ON public.generation_tasks;
DROP POLICY IF EXISTS "Users can insert own generation tasks" ON public.generation_tasks;
DROP POLICY IF EXISTS "Users can update own draft generation tasks" ON public.generation_tasks;
DROP POLICY IF EXISTS "Users can read own generation assets" ON public.generation_assets;
DROP POLICY IF EXISTS "Users can insert own generation assets" ON public.generation_assets;
DROP POLICY IF EXISTS "Anyone can read published sample gallery" ON public.sample_gallery_items;
DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can read all credit balances" ON public.credit_balances;
DROP POLICY IF EXISTS "Admins can read all credit transactions" ON public.credit_transactions;
DROP POLICY IF EXISTS "Admins can read all generation tasks" ON public.generation_tasks;
DROP POLICY IF EXISTS "Admins can read all generation assets" ON public.generation_assets;
DROP POLICY IF EXISTS "Admins can manage sample gallery" ON public.sample_gallery_items;
DROP POLICY IF EXISTS "Admins can update credit balances" ON public.credit_balances;
DROP POLICY IF EXISTS "Admins can insert credit transactions" ON public.credit_transactions;
DROP POLICY IF EXISTS "Admins can delete generation tasks" ON public.generation_tasks;
DROP POLICY IF EXISTS "Admins can update generation tasks" ON public.generation_tasks;

-- User policies
CREATE POLICY "Users can read own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can read own credit balance" ON public.credit_balances
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can read own credit transactions" ON public.credit_transactions
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can read own generation tasks" ON public.generation_tasks
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own generation tasks" ON public.generation_tasks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own draft generation tasks" ON public.generation_tasks
  FOR UPDATE USING (auth.uid() = user_id AND status in ('draft', 'failed'))
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can read own generation assets" ON public.generation_assets
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own generation assets" ON public.generation_assets
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Anyone can read published sample gallery" ON public.sample_gallery_items
  FOR SELECT USING (is_published = true);

-- Admin policies (read: setup-03, credit mgmt: setup-02c, task mgmt: setup-02d)
CREATE POLICY "Admins can read all profiles" ON public.profiles
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can read all credit balances" ON public.credit_balances
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can read all credit transactions" ON public.credit_transactions
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can read all generation tasks" ON public.generation_tasks
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can read all generation assets" ON public.generation_assets
  FOR SELECT USING (public.is_admin());

CREATE POLICY "Admins can manage sample gallery" ON public.sample_gallery_items
  FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "Admins can update credit balances" ON public.credit_balances
  FOR UPDATE USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can insert credit transactions" ON public.credit_transactions
  FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY "Admins can delete generation tasks" ON public.generation_tasks
  FOR DELETE USING (public.is_admin());

CREATE POLICY "Admins can update generation tasks" ON public.generation_tasks
  FOR UPDATE USING (public.is_admin())
  WITH CHECK (public.is_admin());

-- ────────────────────────────────────────────────────────────────
-- 5. Signup trigger: auto-create profile + credit balance
--    (function body matches setup-03-admin-trigger.sql / schema.sql)
-- ────────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'display_name', null),
    case when lower(coalesce(new.email, '')) = 'hinaran53@gmail.com' then 'admin' else 'user' end
  )
  on conflict (id) do update set
    email = excluded.email,
    role = case when lower(excluded.email) = 'hinaran53@gmail.com' then 'admin' else public.profiles.role end,
    updated_at = now();

  insert into public.credit_balances (user_id, free_credits, subscription_credits, purchased_credits)
  values (new.id, 0, 0, 0)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- NOTE: the manual setup scripts also backfilled the admin account's
-- profiles/credit_balances rows from auth.users. That is data seeding tied to
-- an existing production user and is intentionally NOT part of this baseline.
