-- FlowVid Studio DB setup 02c: admin credit management policies
-- 管理者画面からテスト用クレジットを付与するための権限です。
-- setup-03-admin-trigger.sql と setup-02b-user-policies.sql の後に実行してください。

DROP POLICY IF EXISTS "Admins can update credit balances" ON public.credit_balances;
DROP POLICY IF EXISTS "Admins can insert credit transactions" ON public.credit_transactions;

CREATE POLICY "Admins can update credit balances" ON public.credit_balances
  FOR UPDATE USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "Admins can insert credit transactions" ON public.credit_transactions
  FOR INSERT WITH CHECK (public.is_admin());
