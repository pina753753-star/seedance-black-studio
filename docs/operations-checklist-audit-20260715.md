# FlowVid Studio 運営チェックリスト照合結果

最終確認日: 2026-07-15

## 1. Supabase Storage

### 公開設定

**一部確認・要対応**。

本番Supabaseの `storage.buckets` を読み取り確認した結果、存在するバケットは `reference-images` 1個で、`public=true`。`file_size_limit` と `allowed_mime_types` は未設定。

同じ公開バケット内に、参照画像だけでなく `generated-videos/*.mp4` も保存されている。

`api/upload-reference-image.js` は `SUPABASE_SERVICE_ROLE_KEY` でアップロードし、`getPublicUrl()` の公開URLを返す実装。

### CORS

**確認できません**。

CORS設定は `storage.buckets` のDB定義には保持されず、今回利用できるSupabase管理ツールから設定値を取得できなかった。実行環境のネットワーク制約により、Storage URLへの実preflight確認もできなかった。

Supabase DashboardのStorage設定、またはブラウザのNetwork画面で確認が必要。

## 2. OpenRouter Spending Limit

**確認できません・要ダッシュボード確認**。

リポジトリ、Vercel設定、SupabaseからOpenRouterアカウント側のSpending Limit値は取得できない。

OpenRouter Dashboardで上限が設定済みか、ユーザーによる確認が必要。

## 3. Stripe Checkoutとユーザー紐付け

**完了**。

`api/stripe-checkout.js` は認証済みユーザーIDを以下へ設定する。

- Checkout Session `metadata.user_id`
- `client_reference_id`
- サブスクリプション時の `subscription_data.metadata.user_id`

`api/stripe-webhook.js` は `session.metadata.user_id` を優先し、存在しない場合は `session.client_reference_id` を使って `meta.userId` を復元する。そのIDでプロフィール、クレジット、`user_subscriptions` を紐付ける。

一般チェックリストの `metadata.userId` というcamelCase名ではなく、実装上は `metadata.user_id` を使用している。

## 4. Discord/Slack等へのエラー通知

**未着手**。

リポジトリ全体を検索したが、Discord webhook、Slack webhook、Sentry等の外部通知実装は見つからなかった。

エラーは主に `console.error` に記録され、Vercel/Supabase標準ログで確認する構成。

## 5. Supabase Storageの古い動画自動削除

**未着手**。

`vercel.json` のcronは以下だけ。

- `/api/cron-annual-credit-grant`
- `/api/openrouter-reconcile`

Storage cleanup用cronは無い。リポジトリ内にも `storage.remove()` や、作成日時を基準に古いStorageオブジェクトを削除する処理は見つからなかった。

公開バケット内に動画が蓄積するため、保持期間、削除対象、DB URLとの整合を決めた上でcleanup cronまたは運用手順が必要。

## 判定まとめ

| 項目 | 状態 |
|---|---|
| Storageバケット公開設定 | 一部確認・要対応 |
| Storage CORS | 確認できません |
| OpenRouter Spending Limit | 確認できません・要ダッシュボード確認 |
| Stripe metadataによるユーザー紐付け | 完了 |
| Discord/Slack等のエラー通知 | 未着手 |
| Storage古い動画の自動削除 | 未着手 |

## 安全確認

- 本番DB変更なし
- Supabase Storage設定変更なし
- Vercel環境変数変更なし
- OpenRouter呼び出しなし
- 新規動画生成なし
- credits消費なし
