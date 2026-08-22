-- Pina Studio
-- 新規登録クレジットキャンペーン(signup_free_credit_v1)の設定変更
--
-- 変更内容:
--   - max_grants:        20  -> 50
--   - credits_per_user:  800 -> 100
--
-- 背景:
--   private.signup_credit_campaigns の設定値は、20260720000000_add_signup_credit_campaign.sql
--   適用時点では (max_grants=10, credits_per_user=100) だったが、その後
--   マイグレーション履歴に記録のない形で (max_grants=20, credits_per_user=800) へ
--   手動変更されていたことを、本マイグレーション作成前に本番Supabaseへの
--   読み取り専用クエリで確認済み(2026-08-22時点、granted_count=19、内訳は
--   100credits×17人・800credits×2人)。
--
-- 触れないもの(このマイグレーションはUPDATE 1文のみ):
--   - credit_balances、signup_credit_grants、credit_transactions、
--     profiles等の既存ユーザーデータは一切変更しない。
--   - public.handle_new_user() は変更しない。20人目以降の付与判定は
--     既存ロジック(granted_count < max_grants の間だけcredits_per_userを付与)の
--     ままで、max_grants/credits_per_userの値を変えるだけで
--     「20人目から100credits付与・51人目以降は0credits」という挙動が
--     実現される。
--
-- 安全策:
--   UPDATE文のWHERE句に「作業前提と一致する場合のみ」という条件
--   (max_grants=20, credits_per_user=800, granted_count=19)を付け、
--   一致しない場合(=作業直前に新規登録が発生し前提が崩れていた場合)は
--   0行更新のままロールバックする。RAISE EXCEPTIONで明示的に中断し、
--   「更新されたかどうか分からない」状態を残さない。
--
-- DO NOT run against production without explicit approval.
--
-- ============================================================
-- PRE-CHECK QUERY(本番Supabaseで事前に実行し、想定通りであることを確認済み)
-- ============================================================
--   select max_grants, credits_per_user, granted_count
--   from private.signup_credit_campaigns
--   where campaign_key = 'signup_free_credit_v1';
--   -> 確認結果(2026-08-22): max_grants=20, credits_per_user=800, granted_count=19
-- ============================================================

begin;

do $$
declare
  v_updated_id uuid;
begin
  update private.signup_credit_campaigns
  set
    max_grants = 50,
    credits_per_user = 100,
    updated_at = now()
  where campaign_key = 'signup_free_credit_v1'
    and max_grants = 20
    and credits_per_user = 800
    and granted_count = 19
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'signup_credit_campaigns の現在値が想定(max_grants=20, credits_per_user=800, granted_count=19)と一致しなかったため、更新を中止しました。作業直前に新規登録が発生していないか確認してください。';
  end if;
end;
$$;

commit;

-- Rollback(適用後に元へ戻す必要が生じた場合):
--   begin;
--   update private.signup_credit_campaigns
--   set max_grants = 20, credits_per_user = 800, updated_at = now()
--   where campaign_key = 'signup_free_credit_v1';
--   commit;
