# Seedance Black Studio

高級感のある黒背景UIで、Seedance 2.0 系の動画生成を扱うための Next.js MVP です。

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
- 生成前のクレジット目安表示
- タスク一覧
- API接続部分を `lib/seedance.ts` に分離

## 重要

このプロジェクトは、UIとタスク管理がそのまま起動します。

本番でSeedance 2.0を呼び出すには、公式のAPIキー、利用可能なモデルID、APIの正確なリクエスト形式が必要です。
公式ドキュメント側の細部が変わる可能性があるため、API接続部分は `lib/seedance.ts` に集約しています。

## セットアップ

```bash
npm install
cp .env.example .env.local
npm run dev
```

http://localhost:3000 を開きます。

## 環境変数

```bash
# mock or real
SEEDANCE_PROVIDER=mock

# real運用時
SEEDANCE_API_KEY=
SEEDANCE_API_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
SEEDANCE_CREATE_PATH=/contents/generations/tasks
SEEDANCE_QUERY_PATH=/contents/generations/tasks/{task_id}
SEEDANCE_MODEL=seedance-2.0

# Supabase Storageを使う場合
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_STORAGE_BUCKET=seedance-assets
```

## mockとreal

### mock
APIキーなしでUIとタスク保存の動作確認ができます。

```bash
SEEDANCE_PROVIDER=mock
```

### real
APIキーを使って外部APIに送信します。

```bash
SEEDANCE_PROVIDER=real
SEEDANCE_API_KEY=your_key
```

ファイルをSeedance側に渡すには、外部からアクセスできるURLが必要です。
本番ではSupabase Storageなどの公開URLを使ってください。

## API接続部分

`lib/seedance.ts` を見てください。

- `createSeedanceTask()`
- `getSeedanceTask()`
- `buildSeedancePayload()`

API仕様が違う場合は、このファイルだけ修正すればUI側はそのまま使えます。

## ディレクトリ

```text
app/
  api/
    generate/route.ts
    tasks/route.ts
    tasks/[id]/route.ts
  globals.css
  layout.tsx
  page.tsx
components/
  Studio.tsx
lib/
  cost.ts
  seedance.ts
  store.ts
  types.ts
```
