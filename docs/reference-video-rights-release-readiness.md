# 参考動画権利チェック削除 — 公開準備と停止理由

2026-11-15。規約方針と公開についてユーザー承認済み。基準main `d1d9a848a89288fa0f099d2b690c80641fb642c8`。同日のgit ls-remoteでもmain一致。

## 最新の実行記録（以下の過去状態を更新）

2026-11-15。別ブラウザ担当者がProduction Ready、main d1d9a848、対象プロジェクト・ドメインを確認し、Preview 73eec243の規約/privacy/ヘルプ表示も確認済み。ログイン必須の生成画面は実アカウントでは未検証で、通信モックによるPC/390px操作試験で補完。ヘルプFAQはopen属性で直接リンク時にも本文を表示するよう修正した。

ユーザーの公開承認に基づき、Supabase migration APIで `20261115142749_allow_reference_video_without_per_upload_attestation` を適用。CLIは環境の書込み制限で利用できなかったため、APIが記録した正式versionを使ってローカル履歴を保存した。

事前→読み戻し: nullable NO→YES、行数7→7、null0→0。既存日時ハッシュ `429b4b20ce8f6efd3a0480528a1d576d`、他制約ハッシュ `1395c4fa00e0895335c4cbf013beaac1` は一致。RLS true、ACL postgres/service_roleのみで不変。既存記録の補完・更新、実課金・有料生成は行っていない。

本番コード反映は最終Preview確認後。公開URLの実表示・Production Readyは別ブラウザ担当者が確認する。旧デプロイ丸ごとの巻戻しは行わず、nullableと互換バリデータを維持する。

## 過去の準備時点の状態

ローカル変更・テストのみ。push/PR/merge/deploy、本番DDL、実決済、有料生成は行っていない。Supabaseへの操作は列定義、制約、権限、集計件数の読み取りだけ。

独立エージェントレビューでは、コード側に新たな権限回避・課金制御の変更・偽同意日時生成を認めず。追加指摘のサービス内告知、privacy整合、DDL待機上限を修正し再レビュー済み。

## 公開を停止している具体的な理由

- Vercel接続でチーム `pina's projects` / `pina-s-projects` / `team_3F0ueKVc7j6xNcnrUEREIsOl` は取得できるが、プロジェクト一覧とデプロイ一覧は0件。
- リポジトリ運用台帳にある `flowvid-studio` とプロジェクトID `prj_vuiMAkfC0shY9waPwKUvUiABVcwH` は、同チームを指定したget_projectで404。既知の本番ホストへのget_deploymentも404。
- 正規URL `https://www.pinastudio.jp/terms.html` と旧Vercel URLはweb取得不可。curlも接続プロキシからCONNECT 403で、サイトのHTTP応答自体に到達しない。サイト障害とは断定できない。
- `.vercel/project.json` とVercel CLIはなく、VERCEL_TOKENも未設定。接続の対象プロジェクト権限か所属先が合っていない可能性はあるが原因は未確定。
- このため現行本番commit・対象プロジェクト・Preview環境・安全な復帰先・公開後の状態を確認できない。GitHub経由でmainへpushすれば運用台帳上は本番自動反映の可能性があり、迂回してpushしていない。

必要なのは、既存 `flowvid-studio` が参照できるVercel接続の復旧（正しいチーム/プロジェクトとアクセス範囲の確認）および本番/Preview URLを取得できる経路。新プロジェクトの作成や認証情報のチャット貼付は不要。承認を取り直すことでは解決しない。

## 確認できたDBの現状

Supabase `jflpjsdjmlkmkqfahxwy` はコードのsupabaseUrlと一致、ACTIVE_HEALTHY、PostgreSQL17。
`public.seedance_reference_video_uploads.rights_confirmed_at` はtimestamptz、NOT NULL、defaultなし。記録7行、null0件。RLS=true、ACLはpostgres/service_roleのみ。本人用パス・ready完全性・SHA・FK・一意制約を確認。現在の尺制約は最大30000ms/課金30秒。public関数に当該日時列の参照は見つからなかった。

DBは変更していない。権利情報以外の利用者個別データは取得していない。

## 告知・説明文

リポジトリとGitHub mainのterms第1条は「掲載時点で効力」「重要な変更はサービス内告知」を規定。privacy第8条も同様。これに沿って、規約の改定説明、生成画面上部の非ブロッキング告知、ガイドとprivacy該当箇所へのリンクを用意した。告知は同意ボタンを設けず、閲覧済み・同意日時を作らない。

承認された権利・本人同意・外部送信・検査の限界の4段落をterms第6条へ反映。privacy第4条はWaveSpeedAIとRailwayの参考動画形式検査/変換だけを最小追記。学習不使用、即時削除等を保証しない。SEO/headは変更前と完全一致。

現在のHTMLは11月15日公開候補として日付を用意している。実際の公開日が変わる場合、規約・privacy・告知の日付とリンクIDを揃えて更新する。既存条文を機械的に守ることが法的十分性の保証になるわけではない。法令上必要な告知期間・同意方式の最終判断は本準備で保証しない。

## 接続復旧後の適用順序

1. mainと対象プロジェクト/チーム/現在のproduction commit・deployment ID・ドメイン・自動割当を再確認して記録する。既存更新との衝突があれば差分を再レビュー。
2. 対象プロジェクトのPreviewが本番DB/課金系へ誤接続しないことを確認し、無課金でPreview確認する。新しい有料環境は無断で作らない。
3. SQL草案を正式なマイグレーションにする。`supabase migration new`を使って生成し、認証されたmigration経路で適用する準備を整える。適用直前に本番列/制約を再確認。
4. `docs/sql/reference-video-rights-nullable.sql`相当を短いtransactionで適用する。lock_timeout=3s、statement_timeout=10s。NOT NULL解除と列コメントのみ。ロック待ちや失敗があればtransactionを中断し、コード公開へ進まない。架空日時の補完・過去記録の更新はしない。
5. nullable=YES、既存日時不変、RLS/ACL/他制約不変を読み戻す。DB拡張だけなら旧APIのstrict trueからのtimestamp INSERTは引き続き成功する。
6. 互換API/バリデータを先に公開する。キャッシュされた旧UIのtrueを受け入れ、新UIの省略はnullとし、どちらも同じ技術検査と権限・課金制御を経る。APIを含む検証済みデプロイを記録する。
7. 規約・ガイド・privacy・告知とUI削除を反映する。単一デプロイなら手順6-7を一体化できるが、DBの先行確認は省略しない。テスト済み候補を本番昇格する。今は対象デプロイが取得できないため実施不可。
8. 公開URLから規約・リンク・告知・チェック非表示・スクリプト版を確認し、認証失敗/権限不足の拒否や安全なアップロード・検査・削除を無課金で確認。生成開始・決済は実行しない。デプロイログで新規エラーを確認する。

## 互換性とロールバック

- 新APIは旧UIのrightsConfirmed:trueを許容し、既存方式の自己申告受信時刻を保存。false/未送信/string等ではnull。クライアント指定日時は無視。
- DB変更後も旧APIが書く日時は受け入れられる。新しい30秒素材と既存日時が共存できることを隔離PostgreSQLで検証。
- 旧バリデータへ戻すとnull素材はreference_video_rights_unconfirmedで拒否されることを旧HEAD実コードで再現。新バリデータ保持ならnull素材が通り、日時を変更しないことを検証。
- 通常の「直前デプロイへ丸ごと戻す」は禁止。必要ならUIだけの復帰/前進修正を行い、nullableと互換API/バリデータは維持する。規約・privacy・告知も消さない。利用者がチェックしなかった素材にチェック済み日時を入れない。
- NOT NULL再付与はnullが存在すると失敗することを隔離SQLで検証。履歴を埋め直して戻さない。nullable保持は既存データ破壊を伴わない。
- 復帰用デプロイの実作成・実環境試験は、Vercel接続復旧後。現在はローカル互換テストまでで、本番ロールバック可能性の実証はできていない。

## 最終検証

- 対象94テスト: 94成功/失敗0/skip0。30秒の現行制約、旧クライアント日時、新規null、NOT NULL再付与の拒否を含む隔離PGlite SQL試験。
- 全体: 1751件、成功1692、既存失敗42、skip5、todo12。変更前46失敗との比較で新規失敗なし。詳細は既存のfailure-comparison.jsonと今回のrelease-all.log。
- PC/390pxでチェックなしアップロード・削除・再選択・検査失敗復旧と改定告知: 各1成功、想定外API0。すべてモック。
- 規約改定案内→素材ガイド→privacyのリンクと内容: 390px/1280pxの2ケース成功。外部通信なし。
- npm run build成功、生成された対象5静的ファイルがソースと完全一致。ビルドが更新した無関係な既存publicファイルは開始時の内容に戻した。
- 4ページのHTML内JavaScript構文、git diff --check成功。4ページともhead/SEOはHEADと完全一致。
- 独立レビュー: コア94件再実行成功、文言追記後も権利関連12件と構文検証成功。重大な新規コード所見なし。公開経路未確認のため停止を支持。

公開後検証は未実施。公開自体を行っていないため、公開済みとは報告しない。
