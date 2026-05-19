-- FlowVid Studio initial database schema
-- Apply this in Supabase SQL Editor after authentication setup.

-- 1. User profile table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  plan text not null default 'free' check (plan in ('free', 'standard', 'premium', 'scale', 'team')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 2. Credit balance table
create table if not exists public.credit_balances (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  free_credits integer not null default 0 check (free_credits >= 0),
  subscription_credits integer not null default 0 check (subscription_credits >= 0),
  purchased_credits integer not null default 0 check (purchased_credits >= 0),
  updated_at timestamptz not null default now()
);

-- 3. Credit transaction history
create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount integer not null,
  credit_type text not null check (credit_type in ('free', 'subscription', 'purchased')),
  reason text not null,
  related_task_id uuid,
  created_at timestamptz not null default now()
);

-- 4. Generation task table
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

-- 5. Uploaded asset metadata table
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

-- 6. Optional sample gallery table for public home gallery
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

-- Enable RLS
alter table public.profiles enable row level security;
alter table public.credit_balances enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.generation_tasks enable row level security;
alter table public.generation_assets enable row level security;
alter table public.sample_gallery_items enable row level security;

-- Drop existing policies safely for repeated setup
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

-- Admin helper function
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

-- Admin policies
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

-- Auto-create profile and credit balance when a new auth user signs up
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

-- If the admin account already exists, mark it as admin and create a balance row.
insert into public.profiles (id, email, role)
select id, email, 'admin'
from auth.users
where lower(email) = 'hinaran53@gmail.com'
on conflict (id) do update set role = 'admin', email = excluded.email, updated_at = now();

insert into public.credit_balances (user_id, free_credits, subscription_credits, purchased_credits)
select id, 0, 0, 0
from auth.users
where lower(email) = 'hinaran53@gmail.com'
on conflict (user_id) do nothing;
