-- FlowVid Studio DB setup 02b: user access policies
-- setup-02a-rls.sql と setup-03-admin-trigger.sql が成功した後に実行してください。

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
