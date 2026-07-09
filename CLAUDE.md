# FlowVid Studio AI作業ルール

このリポジトリでAIが作業する場合は、作業開始前に必ず以下を読むこと。

1. `ai-rules/00_master_rule.md`
2. 作業内容に応じて、`ai-rules/` 配下の該当ルールファイル

特に、以下を守ること。

- Flow本体のコードは、明示的な指示がない限り触らない
- `package.json`、API route、Supabase関連、OpenRouter関連、README、`.env` / `.env.example` は、明示的な指示がない限り触らない
- git add / commit / push は、ユーザーの明示的な指示があるまで行わない
- 新規生成テストは行わない
- 推測で断定せず、確認できないことは「確認できません」と書く
- 修正前に「原因・修正箇所・確認方法」を出す
- 修正後に「変更内容・確認方法・次の確認箇所」を出す

## プロジェクト構造の概要（分析結果）

**結論：本番で実際に動いているのはルート直下の静的HTML＋`api/`配下のVercel Serverless Functionsであり、`app/`・`components/`・`lib/`（Next.js App Router一式）はビルドに組み込まれておらず未使用の可能性が高い。**

### 理由・根拠

- `package.json` の `build` スクリプトは `*.html` / `*.js` を `public/` にコピーし、`scripts/build-auth-config.js` を実行するだけで、**`next build` を呼び出していない**（package.jsonにはscriptsが1個（build）のみで、`next`という依存もdevDependenciesも存在しない）。
- `vercel.json` の `outputDirectory` は `public`、ルーティングも `*.html` や `/api/*.js` 前提。
- よって `app/api/generate`・`app/api/storyboard`・`app/api/tasks`（Next.js Route Handler）や `lib/seedance.ts`（OpenRouter経由のダミー実装含む）、`components/Studio.tsx` は、README記載の「できること」の説明とは裏腹に、実際のユーザー導線には乗っていない可能性がある。
- 実際の生成フローは `api/seedance-start-priced.js` → `api/_lib/seedance-start.js` → fal.ai（`api/_lib/fal-start.js` / `fal-finalize.js` / `api/fal-webhook.js` / `api/fal-status.js`）が担っており、DBは `supabase/` のテーブル（`generation_tasks` 等）を直接読み書きしている。

### ①全体構造・主要ファイル

| 領域 | 主なファイル | 役割 |
|---|---|---|
| フロント（静的HTML） | `index.html`, `generate.html` / `generate-prod.html` / `generate-cool.html`, `admin*.html`, `login.html`, `pricing.html` 等 | 実際にユーザー・管理者が見る画面。`flowvid-*.js`, `mode-patch.js` などのパッチJSが後付けで読み込まれる構成 |
| API（本番実体） | `api/seedance-start-priced.js`, `api/seedance-status.js`（1017行、最大）, `api/fal-webhook.js`, `api/fal-status.js`, `api/fal-reconcile.js`, `api/_lib/fal-start.js`, `api/_lib/fal-finalize.js`, `api/_lib/seedance-start.js` | 動画生成の開始・fal.aiからの結果受信・状態問い合わせ・タスク一覧取得 |
| 課金 | `api/stripe-checkout.js`, `api/stripe-webhook.js`, `api/stripe-portal.js`, `api/ensure-user-credits.js`, `api/cron-annual-credit-grant.js` | Stripe連携・クレジット付与・年次クレジットのcron（`vercel.json`で毎日00:15 UTCに実行） |
| DB | `supabase/schema.sql`, `supabase/migrations/*.sql`, `supabase/setup-*.sql` | テーブル定義・RLS・管理者権限。マイグレーションが6本＋setup用SQLが別途あり、適用順の一元管理が確認できません |
| 認証設定 | `auth-config.js`, `scripts/build-auth-config.js` | ビルド時にSupabaseのURL/公開鍵をプレビュー環境用に書き換え。秘密鍵混入を防ぐガードあり |
| 未使用の可能性が高い一式 | `app/`, `components/Studio.tsx`, `lib/seedance.ts`, `lib/store.ts`, `lib/cost.ts`, `lib/types.ts` | Next.js App Router構成。README記載内容と実際のビルド出力が一致しない |
| ウォーターマーク | `watermark-server/` | 独立したDockerサービス（`server.js`）。本リポジトリの他コードとの結線は確認できません |

行数の目安：`api/` 配下のJSだけで約5,435行（`components/Studio.tsx`除く主要ファイル計測）。うち `api/seedance-status.js` が1,017行と突出。

### ②修正すると他が壊れやすい危険な箇所

1. **`api/seedance-status.js`（1,017行）** — 単一ファイルが最大。状態問い合わせ・履歴・冪等性判定など複数責務が集中していると見られ、影響範囲の特定が難しい。行内の責務分解は未確認。
2. **`api/_lib/fal-start.js` / `fal-finalize.js` / `api/fal-webhook.js`** — fal.ai Webhook起点の非同期フロー。`00_master_rule.md` の「重複防止」対象そのもの。冪等キーや一意制約の有無はコード全体を読まないと確認できません。
3. **`lib/store.ts` の `updateTask` / `dbRowToTask`** — DBカラム名（`output_url`, `error_message`, `api_task_id` 等）とアプリ側の型（`GenerationTask`）の対応をハードコードしており、Supabaseのカラム名変更や `supabase/migrations/` の追加マイグレーションとズレると静かに壊れる。ただしこの`lib/`一式自体がビルドに乗っているか未確認のため、実害があるかは断定できません。
4. **`vercel.json` のルーティング書き換え**（`/api/seedance-start` → `seedance-start-priced`、`/api/storyboard` → `seedance-status?_r=sb`）— エイリアス依存。ファイル名だけでリネームすると本番URLが壊れる。
5. **`api/stripe-webhook.js` と `api/cron-annual-credit-grant.js`** — 課金・クレジット付与に直結。二重実行時の重複課金リスクは `ai-rules/02_auto_flow_risk_check.md` の対象で、コード変更前に必ずこのルールを通す必要がある。
6. **`supabase/migrations/` と `supabase/setup-*.sql` の二系統** — マイグレーション本体とは別に `setup-01〜03` の初期構築SQLが並存しており、どちらが正で適用順がどうなっているか確認できません。ここに手を入れると既存本番DBとズレるリスクがある。
7. **`scripts/build-auth-config.js`** — ビルド失敗時にデプロイ全体を止める設計（意図的なfail-fast）。ここを緩めると秘密鍵混入防止が効かなくなる。

### ③まず整理すべき優先順位

1. **`app/` ・ `components/` ・ `lib/` が本当に未使用か確認する**（`next build` を呼ぶ場所が他に無いか、Vercelのプロジェクト設定でNext.js Frameworkプリセットが別途指定されていないか）。未使用なら、削除するか「参考実装」として明示するかをユーザーに確認する。README（`触らない領域`）の更新もこの確認後に必要。
2. **`api/seedance-status.js`（1,017行）の責務を棚卸し**して、危険領域①の特定精度を上げる（このタスクではファイル内容までは読んでいません＝行数のみ確認）。
3. **`supabase/migrations/` と `supabase/setup-*.sql` の関係を確認**し、どちらが本番適用済みかをドキュメント化する。
4. **重複生成・重複課金の仕組み（冪等キー等）を `fal-start.js` / `fal-webhook.js` / `stripe-webhook.js` で確認**し、`02_auto_flow_risk_check.md` のチェックリストを実際に埋める。
5. 上記が終わってから、個別のリファクタや整理に着手する。

**確認できないこと（推測せず明記）：**
- `app/` 一式が本当にどこからもビルド・デプロイされていないか（Vercel管理画面側の設定は本リポジトリから確認できません）
- `watermark-server/` が本番のどのフローから呼ばれているか
- `supabase/migrations/` と `setup-*.sql` の適用順・本番反映状況
