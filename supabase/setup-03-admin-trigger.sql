-- FlowVid Studio DB setup 03: admin helper and signup trigger
-- setup-01, setup-02 が成功したあとに実行してください。

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

DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can read all credit balances" ON public.credit_balances;
DROP POLICY IF EXISTS "Admins can read all credit transactions" ON public.credit_transactions;
DROP POLICY IF EXISTS "Admins can read all generation tasks" ON public.generation_tasks;
DROP POLICY IF EXISTS "Admins can read all generation assets" ON public.generation_assets;
DROP POLICY IF EXISTS "Admins can manage sample gallery" ON public.sample_gallery_items;

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
