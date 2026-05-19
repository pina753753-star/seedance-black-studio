-- FlowVid Studio DB setup 02d: admin generation task management policies
-- 管理者画面からテスト用タスクを削除・更新するための権限です。
-- setup-03-admin-trigger.sql と setup-02b-user-policies.sql の後に実行してください。

DROP POLICY IF EXISTS "Admins can delete generation tasks" ON public.generation_tasks;
DROP POLICY IF EXISTS "Admins can update generation tasks" ON public.generation_tasks;

CREATE POLICY "Admins can delete generation tasks" ON public.generation_tasks
  FOR DELETE USING (public.is_admin());

CREATE POLICY "Admins can update generation tasks" ON public.generation_tasks
  FOR UPDATE USING (public.is_admin())
  WITH CHECK (public.is_admin());
