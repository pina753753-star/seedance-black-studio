-- FlowVid Studio DB setup 01: tables only
-- Supabase SQL Editorにこのファイルの中身を全部貼って実行してください。

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  role text not null default 'user' check (role in ('user', 'admin')),
  plan text not null default 'free' check (plan in ('free', 'standard', 'premium', 'ultimate', 'scale', 'team')),
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
