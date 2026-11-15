# 参考動画チェック削除 — Preview確認手順

2026-11-15。今回の許可範囲は専用ブランチのPreview作成まで。本番DB適用、main更新、Production昇格、実決済、有料生成は行わない。

## 検証者が最初に確認すること

1. Vercel上で対象が `flowvid-studio` の **Preview** であること、Git branchが `codex/reference-video-rights-preview-20261115`、commitが引き渡しSHAと一致することを確認する。ProductionへのPromoteは押さない。
2. PreviewのProtectionはそのまま保ち、Vercelログインで閲覧する。保護迂回リンクを公開しない。
3. Pinaユーザーとしてログインする前にPreviewの接続先を確認する。auth-config.jsのsupabaseUrlが本番 `jflpjsdjmlkmkqfahxwy` の場合、本番を参照する。バックエンド側のSUPABASE_URLもVercel設定で確認する（秘密値の出力や共有は不要）。値不明なら本番接続として扱う。
4. 本番DBのrights_confirmed_atはまだNOT NULL。新UIから実アップロードするとnull INSERTが失敗する。今回は正常アップロードを証明する段階ではない。

## 今回の非書き込み確認

- /terms.html#revision-20261115: 改定説明、第6条の権利・本人同意・外部AI送信・検査の限界、古い第三者提供否定がなくなっていること。
- /help.html#reference-materials: 該当FAQを開き、文言と規約/privacyリンクを確認。
- /privacy.html#reference-processing: WaveSpeedAIとRailwayの形式検査・変換の説明を確認。
- /generate-prod.html: 上部の改定告知、リンク、操作を要求する新しい同意チェックがないこと。Pina未ログインでリダイレクトする場合は、認証を突破せず後述モックで確認する。
- 390px/1280pxで横はみ出し、リンク先、メニューを確認。SEO/metaは既存のまま。
- 生成画面を認証状態で確認する場合は、先にブラウザ自動化でAPI全体とStorageアップロードをモック/遮断する。GETのstatus系も更新・返金等の副作用があり得るため、本物のAPIを通さない。実ファイル選択・生成開始・削除・アカウント初期化を本番へ送らない。

## ローカルで実証済みの操作

以下は全通信をモック/遮断し、課金も実アップロードも起こさない。

```
DANCE_E2E_FILTER=checkbox-free node tests/browser/dance-kling-e2e.cjs
DANCE_E2E_WIDTH=390 DANCE_E2E_FILTER=checkbox-free node tests/browser/dance-kling-e2e.cjs
node tests/browser/reference-policy-pages.cjs
```

選択→削除→再選択、検査失敗→再選択→成功、権利申告フィールド未送信、告知表示を確認済み。これは外部AI・Supabaseの実連携確認の代わりではない。

## この段階の完了報告

Preview URL、deployment ID、commit、Ready状態、確認したページ/幅、APIが実通信されていないこと、接続先DBの識別、エラーを報告する。DB適用・main更新・本番公開は次段階へ持ち越す。公開日が変わる場合は日付とリンクIDの再調整が必要。
