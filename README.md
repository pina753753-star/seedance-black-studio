# Pina Studio / seedance-black-studio

黒背景UIで、Seedance 2.0 / Fast / 2.5 / 2.5 Turboの動画生成を扱うサービスです。
静的HTML（ルート直下の `*.html`）と `api/` 配下のVercel Serverless Functionsで構成されています。

## 資料と提供状態

[CLAUDE.md](CLAUDE.md) がAI作業の入口、[資料マップ](docs/PROJECT-MAP.md) が全体の案内です。提供状態は [STATUS.md](STATUS.md) を参照してください。コードに存在する機能を、本番公開済み・購入者に利用可能とは扱いません。

- テキスト・画像・リファレンスからの通常動画生成、履歴、クレジット・Stripe連携。
- 解像度・秒数・参照形式はモデルごとに異なります。一律の枚数・秒数ではなく `api/_lib/video-models.js` と `api/_lib/video-model-validation.js` を参照します。
- 単体購入の通常4モデル利用は2026-10-25 23:54 UTCに本番反映済みです（main 15896a45、SQL適用済み）。実認証後・実決済・有料生成の新本番E2Eは未実施です。単体購入のみは透かしあり、有効サブスクは透かしなし。追加機能の既存tierは維持します。
- ダンスのMOV/trim/480pや検証結果はSTATUSへ分離しています。通常モデルの能力・利用権と混同しません。

## セットアップ

```bash
npm install
npm run build
```

`npm run build` は静的HTML/JSを `public/` にコピーするだけで、Next.jsのビルドは行いません。
ローカルでAPI（`api/` 配下）まで含めて動かす場合はVercel CLI（`vercel dev`）を使ってください。

## 通常生成のコード構成（main 15896a45で確認）

Seedance 2.0/FastはOpenRouter、Seedance 2.5/2.5 TurboはWaveSpeedへ分岐します。`api/_lib/video-models.js` がモデル情報、`api/_lib/seedance-start.js` が実際の送信処理です。後者には管理者限定ダンスBETAのMotion Control分岐もあります。

- 生成開始：`api/_lib/seedance-start.js`
- 生成開始のエントリーポイントは `api/seedance-start-priced.js`（モデル名を検証・正規化して共通ハンドラーを呼ぶ。価格計算は共通ハンドラーと `api/_lib/video-pricing.js`）
- 状態取得・履歴は `api/seedance-status.js`、`api/generated-videos.js`、`api/pending-tasks.js`
- 滞留タスク（2時間以上応答なし）の自動返金：`api/openrouter-reconcile.js` / `api/wavespeed-reconcile.js`（Vercel Cron。対象・条件は各実装を確認）
- 課金・クレジットはStripe（`api/stripe-checkout.js` / `stripe-webhook.js` / `stripe-portal.js`）と `api/ensure-user-credits.js` / `api/cron-annual-credit-grant.js`（毎日Cronで年次クレジット付与）

fal.ai経由の生成（`api/_lib/fal-start.js` 等）はAPIコスト削減のため廃止済みです。

## 環境変数

コードから確認できた本番で参照される環境変数は次のとおりです（`.env.example` は現状この一部のみカバーしています。実態との差分は別途確認が必要です）。

```bash
# モデルごとの生成プロバイダ
OPENROUTER_API_KEY=
WAVESPEED_API_KEY=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ANON_KEY=
SUPABASE_REFERENCE_BUCKET=
FLOWVID_VIDEO_BUCKET=

# Stripe
STRIPE_SECRET_KEY=
STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=

# その他
CRON_SECRET=
SITE_URL=
WATERMARK_SERVER_URL=
WATERMARK_SECRET=
```

ファイルを外部プロバイダに渡すには、外部からアクセスできるURLが必要です。公開URL・署名付きURLなどは経路ごとに異なります。非公開のダンス参考動画を公開バケットへ移す指示ではありません。

## ディレクトリ

```text
*.html            画面（index.html, generate-prod.html, admin*.html など）
flowvid-*.js, mode-patch.js  画面用パッチJS
api/
  seedance-start-priced.js   生成開始（モデル正規化）
  seedance-status.js         状態取得・履歴
  generated-videos.js, pending-tasks.js
  openrouter-reconcile.js    滞留タスクの自動返金（Cron）
  stripe-checkout.js, stripe-webhook.js, stripe-portal.js  課金
  ensure-user-credits.js, cron-annual-credit-grant.js      クレジット
  upload-reference-image.js, video-edit.js
  _lib/
    seedance-start.js  モデル別provider連携・資格確認・価格計算
supabase/
  schema.sql, migrations/, setup-*.sql
watermark-server/  Railwayの独立Dockerサービス（透かし・編集・参考動画検査。アプリとは別の配備状態）
```
