# Seedance Black Studio

高級感のある黒背景UIで、Seedance 2.0 系の動画生成を扱うサービスです。
静的HTML（ルート直下の `*.html`）と `api/` 配下のVercel Serverless Functionsで構成されています。

## できること

- テキストから動画
- 画像から動画
- 複数リファレンス
  - 参照画像：最大9枚
  - 参照動画：最大3本、合計15秒想定
  - 参照音声：最大3個、合計15秒想定
- 解像度：480p / 720p / 1080p
- 長さ：5〜15秒
- アスペクト比：自動 / 16:9 / 9:16 / 4:3 / 3:4 / 21:9 / 1:1
- 生成前のクレジット目安表示・課金（Stripe連携）
- タスク一覧・生成履歴

## セットアップ

```bash
npm install
npm run build
```

`npm run build` は静的HTML/JSを `public/` にコピーするだけで、Next.jsのビルドは行いません。
ローカルでAPI（`api/` 配下）まで含めて動かす場合はVercel CLI（`vercel dev`）を使ってください。

## 生成の仕組み（本番）

動画生成モードによって、呼び出し先の外部プロバイダが分かれています。

- `text_to_video` / `image_to_video`：`api/_lib/fal-start.js` → fal.ai（`bytedance/seedance-2.0/text-to-video` または `image-to-video`）。結果は `api/fal-webhook.js` がWebhookで受信し、`api/_lib/fal-finalize.js` が確定処理を行う
- `reference_to_video` / `storyboard`：`api/_lib/seedance-start.js` → OpenRouter（`https://openrouter.ai/api/v1/videos`、モデル `bytedance/seedance-2.0`）
- 生成開始のエントリーポイントは `api/seedance-start-priced.js`（クレジット計算をしてから `api/_lib/seedance-start.js` を呼ぶ）
- 状態取得・履歴は `api/seedance-status.js`、`api/generated-videos.js`、`api/pending-tasks.js`
- 課金・クレジットはStripe（`api/stripe-checkout.js` / `stripe-webhook.js` / `stripe-portal.js`）と `api/ensure-user-credits.js` / `api/cron-annual-credit-grant.js`（毎日Cronで年次クレジット付与）

## 環境変数

コードから確認できた本番で参照される環境変数は次のとおりです（`.env.example` は現状この一部のみカバーしています。実態との差分は別途確認が必要です）。

```bash
# OpenRouter経由の生成（reference_to_video / storyboard）
OPENROUTER_API_KEY=

# fal.ai経由の生成（text_to_video / image_to_video）
FAL_KEY=
FAL_WEBHOOK_URL=

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

ファイルを外部プロバイダに渡すには、外部からアクセスできるURLが必要です。Supabase Storageの公開URL（`SUPABASE_REFERENCE_BUCKET` / `FLOWVID_VIDEO_BUCKET`）を使用しています。

## ディレクトリ

```text
*.html            画面（index.html, generate-prod.html, admin*.html など）
flowvid-*.js, mode-patch.js  画面用パッチJS
api/
  seedance-start-priced.js   生成開始（クレジット計算）
  seedance-status.js         状態取得・履歴
  generated-videos.js, pending-tasks.js
  fal-webhook.js             fal.aiからのWebhook受信
  fal-status.js, fal-reconcile.js
  stripe-checkout.js, stripe-webhook.js, stripe-portal.js  課金
  ensure-user-credits.js, cron-annual-credit-grant.js      クレジット
  upload-reference-image.js, video-edit.js
  _lib/
    seedance-start.js  OpenRouter連携
    fal-start.js, fal-finalize.js  fal.ai連携
supabase/
  schema.sql, migrations/, setup-*.sql
watermark-server/  独立したDockerサービス（本リポジトリの他コードとの結線は確認できません）
```
