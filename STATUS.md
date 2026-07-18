# FlowVid Studio 完成までの全体像(最終更新: 2026-07-16)

> このファイルは、リポジトリ・git履歴・Supabase(本番DB実測)・Vercel設定・ai-rules/READMEを一次調査した結果に基づく。確認できなかった点は「確認できません」と明記している。今後のセッションはまずこのファイルを読むこと。

## 2026-07-15 追加分: 完了・本番適用済み(すべてSupabase本番DB実測 / GitHub PRマージ状態で検証済み)

- **generation_tasksのUPDATE RLSポリシー削除(PR #70)**: 本番適用済み。DB実測で `Users can update own draft generation tasks` は存在せず、`Admins can update generation tasks` のみ残存を確認。
- **generation_tasksのINSERT RLSポリシー削除(PR #71)**: **2026-07-15、本番適用完了。** マージ後、本番Supabaseへマイグレーションを適用し、`pg_policies` 実測で `Users can insert own generation tasks` の消滅を確認済み(残るのは `Admins can delete/update/read generation tasks`, `Users can read own generation tasks` の4件のみ)。一般ユーザーからの直接INSERTは不可能になり、正常系(`generate-prod.html` → `/api/seedance-start` → service-role専用の `reserve_generation_task` RPC)には影響しない。
- **grant_annual_subscription_creditsの権限修正(PR #72)**: 本番適用済み・完全解決。DB実測で、旧3引数版は削除され4引数版のみ存在し、`has_function_privilege('anon', ...)` / `('authenticated', ...)` はともに `false`(service_roleのみ実行可)。以前STATUS.mdで「致命的ブロッカー」としていた `grant_annual_subscription_credits` 未認証実行問題はこれで解消。
- **user_subscriptions・annual_credit_grant_logの権限REVOKE(PR #75)**: **2026-07-15、本番適用完了。** マージ後、本番Supabaseへマイグレーションを適用し、`has_table_privilege` 実測で両テーブルとも `anon_dml=false`, `authenticated_dml=false`, `service_role_dml=true` を確認済み。RLSのdefault-denyに加え、テーブルレベル権限も明示的にservice_role限定になった。Stripe webhook・年額cron・`grant_annual_subscription_credits` RPCはすべてservice_role経由のため影響なし。
- **flowvid_video_history（旧テーブル）の権限REVOKE(PR #81)**: **2026-07-15、本番適用完了。** `20260715_revoke_legacy_video_history_access.sql` を本番Supabaseへ適用し、DB実測でRLS有効・ポリシー0件、`anon` / `authenticated` のSELECT・INSERT・UPDATE・DELETEがすべてfalse、`service_role`のみすべてtrueを確認済み。テーブルと既存行は削除・更新していない。
- **reference-imagesストレージバケットの制限**: 適用済み。DB実測(`storage.buckets`)で `file_size_limit=52428800`(50MB)、`allowed_mime_types=[image/jpeg, image/png, image/webp, video/mp4, video/webm, video/quicktime]` を確認。手動でのダッシュボード設定と申告どおり。
- **参照画像アップロードの認証必須化(PR #78)**: 本番mainにマージ済み(`664bdf2`)。**この修正が入るまで、`generate-prod.html`のアップロード処理は`Authorization`ヘッダーを送っておらず、`api/upload-reference-image.js`側は元々Bearerトークン必須(401)だったため、参照画像アップロード機能自体が常に失敗する状態だった。** 現在はPreview環境でログイン済みユーザーによる実アップロード成功を実機確認済み。

### 残っている項目

- `flowvid_video_history` の権限REVOKEは本番適用・実測確認まで完了。追加対応なし。

## 2026-07-16 追加分: 完了・本番適用済み

- **NSFW・違法コンテンツの生成前チェック導入(旧・最優先ブロッカー)**: **本番適用・実機確認済み。** PR #82にて、OpenAI Moderation API(`omni-moderation-latest`)による生成前チェックを `api/_lib/seedance-start.js` 内、Supabase JWT認証成功後・残高確認/タスク作成/クレジット消費/OpenRouter呼び出し前に実装。検査失敗時(API障害等)は安全側に倒して生成を停止する方式(A案)を採用。
  - 初回レビューで「認証前にモデレーションが呼ばれ、未認証ユーザーがOpenAI APIを叩けてしまう」問題が発見され、認証後への移動で修正済み。
  - Vercel Production・Preview両方に `OPENAI_API_KEY` を設定し、本番マージ・デプロイ済み。
  - 本番実機テスト実施。OpenAIアカウントのクレジット残高$0が原因で一時的に全生成が停止する事象が発生したが、ユーザーが$5のクレジットを追加し解決、正常生成(ウォーターマークも含む)を実機確認済み。
  - PR #83にて、検査失敗時に誤って表示されていた「返金確認が必要」の文言を、クレジット未消費である旨を明記した正しいエラーメッセージへ修正。OpenAIエラーの詳細(ステータスコード等、機密情報は含まない)をログへ記録する改善も本番反映済み。
  - **防げるもの**: 性的表現、暴力、ヘイト、自傷、一部の違法行為の指示。
  - **防げないもの(現在の最優先課題)**: 実在人物・有名人の無断利用、児童性的虐待素材(CSAM)の専用検知、著作権侵害。これらはOpenAI Moderation APIのカバー範囲外であり、別途対策が必要。
- **特定商取引法の表記不備の修正**: **PR #84で本番反映済み。** 消費者庁ガイドライン(通信販売広告Q&A)に基づく「開示請求方式」に変更し、所在地・電話番号・運営統括責任者は請求時に開示、開示請求は `help.html` のお問い合わせフォーム経由(実際の転送先メールアドレスはサイト上に非表示)。
- **本番Stripeキー(live mode)の確認**: **確認完了。** ユーザー本人がVercelダッシュボードで直接確認し、Production環境の `STRIPE_SECRET_KEY` は `sk_live_`、`STRIPE_PUBLISHABLE_KEY` は `pk_live_` で始まっており、live mode(本番課金モード)で稼働中であることを確認済み。
- **Stripe Webhook署名シークレット(`STRIPE_WEBHOOK_SECRET`)のProduction未設定を発見・修正**: 上記のlive mode確認作業中に、`STRIPE_WEBHOOK_SECRET` がVercelのPreview環境にのみ設定され、**Production環境には未設定**であることが判明。
  - `api/stripe-webhook.js` の仕様上、未設定の場合はHTTP 500で即座に処理を停止する安全側の設計のため、無効なWebhookが素通りする心配はなかったが、**本番の決済・サブスク更新イベントが一切処理されない状態**だった。
  - Stripeダッシュボードで本番Webhookエンドポイント(`engaging-voyage`、送信先 `https://flowvid-studio.vercel.app/api/stripe-webhook`)が正しく存在することを確認。配信履歴は0件であり、発見時点で実際の顧客への実害は発生していなかったと判断(一般公開前のため)。
  - ユーザー本人がVercelダッシュボード(デスクトップ表示モードで複数環境選択の不具合を回避)で、Production環境のみに正しい署名シークレットを設定し解決済み。Preview環境の既存のテスト用値には変更なし。
- **Railway watermark-serverの稼働確認**: **2026-07-16、確認完了。** 本番実機テストで無料動画にウォーターマークが付与され、Vercelの `api/seedance-status.js` からRailway上の本番サービスへ接続し、ffmpeg処理・Supabase Storage保存まで成功していることを確認。Railwayには本番稼働中の `gallant-balance` プロジェクトのみが存在する。
  - 使われていない別プロジェクト `joyful-enthusiasm` はビルド失敗状態だった。当初サービスのみ削除したところGitHub連携により自動再作成されたため、2026-07-16、ユーザー本人がプロジェクトごと完全に削除し解決済み。今後この件の失敗通知は発生しない。
- **参照画像生成モードの一時停止**: **PR #85で本番反映済み。** 2026-07-16、実在人物への無断なりすまし対策・CSAM専用検知が未実装であることを踏まえ、安全のため参照画像を使った生成モードを一時停止。テキストのみの生成は通常通り稼働。上記2つの検知機能が実装され本番稼働し次第、再開する。

## 2026-07-18 追加分: 完了・本番適用済み

- **年齢確認機能の実装・本番反映(PR #86)**: `login.html`に生年月日入力欄を追加、18歳未満の登録をクライアント側でブロック。SupabaseのBefore User Created Hook(`hook_enforce_minimum_signup_age`)により、サーバー側でも18歳未満の登録を拒否。タイムゾーンはAsia/Tokyoに固定。実機テストで動作確認済み、本番稼働中。既存6ユーザーへの遡及適用は行っていない。
- **メール確認の多重防御の実装・本番反映(PR #87)**: `auth-guard.js`(クライアント側)、`api/_lib/confirmed-auth.js`(サーバー側)を新規作成。`login.html`、`profile.html`に確認済みユーザーのみアクセスできるガードを追加。`api/_lib/seedance-start.js`、`api/upload-reference-image.js`に`requireConfirmedAuth()`を導入。`onAuthStateChange`のデッドロック問題を修正済み。
- **CSAM専用検知(PhotoDNA)への申請 → 却下**: Microsoft PhotoDNA Cloud Serviceへ申請したが、「現時点では資格要件を満たしていない」との理由で却下された。法人化後に再申請予定。それまで保留。Thorn Saferは個別契約・審査不透明のため未着手。
- **実在人物なりすまし検知の設計案完成、AWSアカウント作成待ちで保留中**: プロンプトでの人物名・なりすまし表現検査、Amazon RekognitionのRecognizeCelebritiesによる著名人一致検知(一般人の顔は通過)の設計案は完成済み。AWSアカウント作成(サインアップ確認メール未達で中断)がボトルネック、法人化まで保留と判断。
- **参照画像モードは引き続き停止中(PR #85のまま)**: 実在人物なりすまし検知・CSAM専用検知が揃うまで再開しない方針を継続。
- **Railway watermark-server /editエンドポイントの安全化(PR #88、マージ・デプロイ済み)**: `/watermark`との共有同時実行ガードへ接続(`MAX_CONCURRENT_EDIT_JOBS=1`で`/watermark`用の枠を確保)。リクエスト全体で単一のタイムアウト(300秒)。ダウンロードサイズ・クリップ尺(30秒/クリップ、180秒合計)の上限。SSRF対策(reference-imagesバケット配下のみ許可、リダイレクト無効化)、エラーメッセージの許可リスト化。
- **動画編集Vercel API実装(PR #89、マージ・デプロイ・マイグレーション適用済み)**: `video_edit_tasks`テーブル、`reserve_video_edit_task`/`refund_video_edit_task` RPC新規作成。`requireConfirmedAuth()`による認証、videoIdベースの所有権確認。料金体系:基本10credits(1〜3クリップ・合計30秒以内)、15credits(4〜6クリップまたは30秒超)。taskIdを使った決定的なStorageパス(`edited/<userId>/<taskId>.mp4`)により、Vercel側のタイムアウト・切断時も後から処理結果を復旧できる仕組み(`video-edit-reconcile.js`、5分おきのcron)。Storage確認結果をexists/missing/unknownの3状態に分け、一時的な確認失敗では返金しない設計。テスト用に`hinaran53@gmail.com`の`subscription_expires_at`を一時的に更新済み(実際のStripe課金とは連動していない)。
- **動画編集の最小UI実装(PR #90、マージ・デプロイ済み)**: `generate-prod.html`の「動画編集」タブを実画面に置き換え。過去動画一覧(`/api/generated-videos`流用)から最大6本選択。開始・終了秒の数値入力によるトリム指定(※使いにくいとのフィードバックあり、次回スライダー式UIへ改善予定)。冪等再送処理、ポーリング、エラーハンドリング実装済み。

### 次回やるべきこと(優先順位順)

1. 動画編集のトリミングUI改善:数値入力→スライダー式(VLLOやCapCut等を参考にした直感的な操作性)への変更。
2. AWSアカウント作成(サインアップ確認メール未達の解決)→実在人物なりすまし検知(著名人認識+プロンプト検査)の実装。
3. 法人化後、PhotoDNA再申請または他のCSAM検知手段の検討。
4. 上記2・3が完了次第、参照画像モードの再開を検討。
5. 新規フリーユーザー100人への100クレジット付与施策の実装状況確認(まだ着手していない)。
6. 絵コンテ機能の残存コード(`?mode=storyboard`で開ける)の削除検討(優先度低)。
7. 動画編集の追加機能(字幕+5credits、BGM+5credits、上限25credits)は将来段階として保留中。

---

## 前提: このサイトは何か

静的HTML(ルート直下の `*.html`) + Vercel Serverless Functions (`api/`) 構成。Next.jsは過去に導入されたが削除済み(コミット `614eacc`)。動画生成はOpenRouter経由でSeedanceモデルを呼び出す。fal.ai経由の旧生成経路は廃止済み(コミット `930ddba`)。決済はStripe。透かし(watermark)処理はRailway上の別サービス `watermark-server/`(Node/Express/ffmpeg)が担う。

Supabase本番プロジェクト(`jflpjsdjmlkmkqfahxwy`, ap-northeast-1, ACTIVE_HEALTHY)を実際に確認した。**実データ規模: ユーザー1人、`generation_tasks` 47件、`credit_transactions` 38件。実質まだ稼働(本番運用)していない、開発・検証段階のデータ量。**

---

## サイトとして運営するために必要なもの(全項目)

### 動画生成コア機能
- **生成フロー本体(OpenRouter経由)**: 完了。`api/seedance-start-priced.js` → `api/_lib/seedance-start.js` → `api/seedance-status.js`(ポーリング・完了判定・課金確定・返金・watermark連携の中心ファイル)という流れで実装済み。7月の複数回のリグレッション(fal.ai廃止時)を経て、現在は安定化のためのルール(CLAUDE.md恒久ルール)が敷かれている。
- **料金計算ロジック**: 完了。`api/_lib/video-pricing.js` に実装され、`tests/video-pricing-regression.test.js` で回帰テストあり(ただし `npm test` 等には未接続、実行方法確認できません)。
- **重複生成・二重課金防止**: 完了。DB側で `generation_cooldown`, `single_active_generation_guard` のマイグレーションにより保護。OpenRouter用のatomic refund機構も導入済み(`allow_openrouter_atomic_refund`, `fix_refund_task_status_field_typo`)。
- **タイムアウト生成の自動返金(cron)**: 完了。`api/openrouter-reconcile.js` が15分ごとに動作(`vercel.json` のcron設定で確認)、2時間超放置タスクを返金。
- **透かし(watermark)処理とRailway連携**: **本番稼働・実機確認済み。** `api/seedance-status.js` が `WATERMARK_SERVER_URL` と `WATERMARK_SECRET` を使ってRailway上の `watermark-server` の `/watermark` を呼び出す。2026-07-16の本番実機テストで、無料動画へのウォーターマーク付与、ffmpeg処理、Supabase Storage保存、加工済み動画URLの返却まで成功を確認。`api/video-edit.js` の `/edit` 接続は別機能であり、現在は未接続・近日対応扱い。

### 決済・課金
- **Stripe決済(単発・サブスク)**: 完了。`stripe-checkout.js` / `stripe-webhook.js` / `stripe-portal.js` / `stripe-config.js` が揃い、Webhookのクレジット付与にはDBレベルの一意制約(`add_stripe_reason_unique_constraint` マイグレーション)による冪等性保護あり。埋め込みCheckout、モバイル決済のリグレッション修正も履歴上確認できる、かなり成熟した実装。
- **年額サブスクの自動クレジット付与(cron)**: 完了。`api/cron-annual-credit-grant.js` が毎日00:15 UTCに実行。日付計算バグは一度発生し `20260705_fix_annual_credit_grant_dates.sql` で修正済み。
- **年額サブスク付与対象statusの不整合**: **要確認・未修正**。cronコードは `active` と `trialing` を付与候補として扱う一方、DB関数 `grant_annual_subscription_credits` は `active` と `past_due` だけを許可し、`trialing` を `invalid` として拒否する。逆に関数単体は `past_due` を許可するが、cronは対象外にしている。意図した仕様を確認し、cronとDB関数の許可statusを一致させる必要がある。今回は記録のみで修正していない。
- **本番Stripeキー(live mode)への切り替え**: **2026-07-16、確認完了。** ユーザー本人がVercelダッシュボードで直接確認し、Production環境の `STRIPE_SECRET_KEY`/`STRIPE_PUBLISHABLE_KEY` がともにlive mode用のプレフィックスで稼働中であることを確認済み。
- **Stripe Webhook署名シークレット(`STRIPE_WEBHOOK_SECRET`)**: **2026-07-16、発見・修正完了。** 確認作業中にProduction環境のみ未設定であることが判明(Preview環境には既存)。未設定時は `api/stripe-webhook.js` がHTTP 500で即座に処理を停止する安全側の設計だった。Stripe側の配信履歴は0件で、発見時点で実害は確認されなかった。ユーザー本人がProduction環境にのみ正しい値を設定し解決済み。
- **返金・チャージバック対応フロー**: 自動返金(生成失敗時)は実装済みだが、**手動チャージバック対応の運用手順・問い合わせ窓口対応フローは未着手**(help.html等の問い合わせ導線はあるが、運用マニュアルは見当たらない)。

### ユーザー認証
- **ログイン・ログアウト・パスワードリカバリ**: 完了。`login.html`, `logout.html`, `recover.html`, `auth-config.js` あり。
- **新規登録(signup)フロー**: **一部対応・要確認**。専用の `signup.html` は見つからず、`login.html` に統合されている可能性が高いが、内容を行単位で確認していないため断定できません。次に確認すべき箇所。
- **管理者ログイン**: 完了。`admin-login.html` が別途存在。
- **年齢確認の技術的な強制**: **未着手の可能性が高い、要確認**。`terms.html` に「13歳以上、18歳未満は保護者同意が必要」という規約文言はあるが、サインアップ時にこれを技術的にチェックしているコードは見つかっていません。規約に書いてあるだけで実効性がない状態の可能性がある。

### コンテンツポリシー・年齢確認・モデレーション
- **アダルトコンテンツ禁止ポリシー**: `content-policy.html` に明記あり(フィクション含むCSAM完全禁止、成人向けコンテンツも一律禁止)。**注記: 「Black Studio」という名称はダーク系UIテーマの意味であり、アダルト向けサービスではない。** ポリシー文面は完成している。
- **NSFW・違法コンテンツの技術的検知・フィルタリング**: **2026-07-16、本番適用・実機確認済み。** OpenAI Moderation API(`omni-moderation-latest`)による生成前チェックを `api/_lib/seedance-start.js` のSupabase JWT認証成功後・残高確認/タスク作成/クレジット消費/OpenRouter呼び出し前に実装(PR #82)、検査失敗時のエラーメッセージ・ログ改善(PR #83)も本番反映済み。性的表現・暴力・ヘイト・自傷・一部の違法行為の指示は検知可能。
- **実在人物・CSAM専用検知**: **現在の最優先の未解決課題。** 実在人物・有名人の無断利用、本人同意、画像内の児童判定、CSAM専用検知はOpenAI Moderation APIのカバー範囲外。専用対策が本番稼働するまで、PR #85により参照画像生成モードを本番で一時停止済み。テキストのみの生成は継続稼働中。

### 法務・コンプライアンス
- **特定商取引法に基づく表記(legal.html)**: **PR #84で開示請求方式（消費者庁ガイドラインに基づく）を本番反映済み。** 所在地・電話番号・運営統括責任者は請求時に開示、開示請求は `help.html` のお問い合わせフォーム経由。
- **利用規約(terms.html)**: 完了(内容は存在)。年齢制限条項あり。
- **プライバシーポリシー(privacy.html)**: ページは存在するが、個人情報保護法(APP)やGDPR相当の要件を満たしているかは行単位で確認しておらず、**確認できません**。
- **コンテンツポリシー(content-policy.html)**: 完了(文面としては存在)。

### インフラ・運用
- **Vercelデプロイ設定**: 完了。`vercel.json` にビルド・ルーティング・cronが正しく設定されている。
- **Supabase DB・RLS**: **一部対応**。実データで確認した結果、RLSは全テーブルで有効。ただし以下のセキュリティ指摘がSupabase Advisorから出ている(実測、2026-07-15時点):
  - ~~`annual_credit_grant_log`, `flowvid_video_history`, `user_subscriptions` の3テーブルはRLSが有効だがポリシーが1つも無い~~ **3テーブルすべて2026-07-15にテーブルレベル権限をservice_role限定へ修正し、本番DBで実測確認済み**。`annual_credit_grant_log`, `user_subscriptions` はPR #75、`flowvid_video_history` はPR #81で対応。`flowvid_video_history` はRLS有効・ポリシー0件のdefault-denyに加え、anon/authenticatedのCRUD権限もすべてfalse。
  - `generated_videos` テーブルに `USING (true) / WITH CHECK (true)` の全許可ポリシーがあり、これはservice_role用の想定だが、意図通りかの再確認が必要。
  - ~~`grant_annual_subscription_credits`, `handle_new_user`, `is_admin`, `set_generation_task_finished_at` の4つの `SECURITY DEFINER` 関数が、未ログインユーザー(anon)からも直接RPC経由で呼び出し可能な状態。~~ **`grant_annual_subscription_credits` は2026-07-15、PR #72の本番適用により解決済み**(DB実測でanon/authenticated実行不可を確認)。残る `handle_new_user`, `is_admin`, `set_generation_task_finished_at` は引数なしのトリガー/チェック用関数で、直接RPC実行しても実害のある副作用が起きない設計であることをコードレビューで確認済み(詳細は本ファイル冒頭の調査ログ外、セッション内のやり取りを参照)。優先度は低い。
  - 漏洩パスワード保護(HaveIBeenPwned連携)が無効。
  - **これらはすべて「一次調査で見つかった実際のSupabase Advisor指摘」であり、放置すると認可バイパスや不正クレジット付与に繋がりうる。運営開始前に必ず精査すべき。**
  - また、リポジトリの `supabase/migrations/` には11ファイルあるのに対し、Supabase側が「適用済み」として認識しているマイグレーションは5件のみ(`20260711`〜`20260714` のもの)。それより前の `20260624`(初期スキーマ)等はSupabase側の管理下に記録されておらず、`supabase/setup-*.sql` 経由で手動適用された可能性が高い。**つまりこのDBのスキーマ管理は「CLI/マイグレーション管理」と「手動SQL適用」の2系統が混在しており、今後のスキーマ変更時に何が本当に当たっているか把握しづらい状態。**
- **Railway(watermark-server)**: **2026-07-16、稼働確認完了。** 本番実機テストでウォーターマーク付き動画の生成に成功し、現在Railwayには本番稼働中の `gallant-balance` プロジェクトのみが存在する。不要な `joyful-enthusiasm` プロジェクトはプロジェクトごと完全削除済みで、今後この件の失敗通知は発生しない。
- **`.env.example` の陳腐化**: **要対応**。README自身が「実態との差分は別途確認が必要」と明記する通り、`.env.example` には現行実装で使われていない旧変数(`SEEDANCE_PROVIDER=mock`, 直接Volcengine接続用の変数等)が並び、実際に使われている `OPENROUTER_API_KEY`, `WATERMARK_SERVER_URL`, `WATERMARK_SECRET`, `CRON_SECRET` 等が載っていない。新しい開発者・AIが環境変数を把握する助けになっておらず、実質使い物にならない状態。
- **エラー監視・ログ収集(Sentry等)**: **未着手**。専用の監視ツール導入は見当たらない。Vercel/Supabase標準ログのみに依存している状態と推測される(確認できません、要ユーザー確認)。
- **CI(継続的インテグレーション)**: **実質未着手**。`.github/workflows/preview-ops-audit.yml` が唯一のワークフローだが、これは特定の過去PR(#37)・特定ブランチにピン留めされた一回限りの監査スクリプトで、今後のPRには発火しない。**通常のlint/test/build確認を行うCIは存在しない。**
- **レート制限**: `api/_lib/seedance-start.js` にそれらしき言及が1箇所あるのみで、専用のレート制限ミドルウェアは見当たらない。悪意あるユーザーによる過剰リクエスト・コスト増大への防御が薄い可能性がある。**確認できません(実装の中身までは未確認)。次に確認すべき箇所。**

---

## 今すぐ運営を始めるにあたって、致命的に足りないもの・ブロックしているもの(優先順位順)

1. **実在人物への無断なりすまし対策・CSAM専用検知の実装が未完了(現在の最優先課題)。** OpenAI Moderation APIでは実在人物判定、本人同意、画像内の児童判定、CSAM専用検知を代替できない。安全対策としてPR #85を2026-07-16に本番反映し、参照画像生成モードは一時停止済み。テキストのみの生成は通常稼働。専用検知を実装し本番確認できるまで参照画像モードを再開しない。
2. ~~NSFW・違法コンテンツの自動検知の有無が未確認~~ **2026-07-16、OpenAI Moderation APIによる生成前チェックの本番適用・実機確認により解決済み(PR #82, #83)。**
3. ~~未認証で叩けるSECURITY DEFINER関数(特に `grant_annual_subscription_credits`)~~ **2026-07-15、PR #72の本番適用により解決済み**。
4. ~~特定商取引法の表記が不十分(住所・電話番号・代表者個人名の欠落)~~ **PR #84で開示請求方式を本番反映済み。**
5. ~~RLSポリシーが1つも無いテーブルが3つ存在(`annual_credit_grant_log`, `flowvid_video_history`, `user_subscriptions`)~~ **2026-07-15、3テーブルすべてテーブルレベル権限をservice_role限定へ修正し、本番DBで実測確認済み。解決済み。**
6. ~~Railway watermark-serverの実際の稼働状況が未確認~~ **2026-07-16、本番実機テストとRailway確認により解決済み。`gallant-balance` が本番稼働中。**
7. ~~本番Stripeキーがlive modeになっているか未確認~~ **2026-07-16、確認完了。** あわせて `STRIPE_WEBHOOK_SECRET` のProduction未設定も同日発見・修正済み。
8. **年齢確認が規約の文言だけで技術的な強制がない可能性**。未成年利用の法的リスク。未確認のまま。
9. **サインアップフローの詳細が未確認**(メール確認は必須になっているか、等)。なりすまし・大量アカウント作成のリスクに関わる。
10. **CIが実質存在しない**。今後の変更で正常系を壊すリスクが継続する。少なくともbuild確認だけでも自動化すべき。
11. **`.env.example` が実態と乖離**していて、今後別の担当者・AIが環境構築するときに間違った変数を設定するリスクがある。
12. **Supabase StorageのCORS設定確認など、その他の運用チェック項目**(2026-07-16時点で未着手)。

---

## もう完成していて、今後一切触らなくていいもの

- OpenRouter経由の動画生成コアフロー(`api/_lib/seedance-start.js`, `api/seedance-start-priced.js`)。fal.ai廃止後、複数回のリグレッションを経て安定化済み。CLAUDE.mdの恒久ルールにより、今後は「明示的な指示がない限り触らない」対象として明確に保護されている。
- Stripe決済まわり(checkout / webhook / portal / config)。冪等性対応済みで、履歴上も十分にハードニングされている。
- 生成タスクの重複防止・cooldown・atomic refund機構(DB migration群)。
- 年額サブスクの自動クレジット付与cron(日付バグ修正済み)。
- 料金計算ロジック(`video-pricing.js`)とその回帰テスト。

---

## 過去に作ったが今は使われていない、もう見なくていいもの

- 旧Next.js App Router一式(コミット `614eacc` で削除済み。現在は完全に静的HTML + Vercel Functions構成)。
- fal.ai経由の旧動画生成経路(コミット `930ddba` で廃止済み。関連するreturn/webhook処理はOpenRouter経路に置き換え済み)。
- `.github/workflows/preview-ops-audit.yml`(特定の過去PR #37・過去ブランチにピン留めされた一回限りの監査で、今後発火しない。実質死んでいるが削除するかは今回判断していません)。
- `supabase/setup-*.sql` 系ファイル(現行の `supabase/migrations/` と役割が重複・混在している可能性が高いが、実際に今のスキーマにどこまで寄与しているかは未確認のため、断定はできません。次に確認すべき箇所として残す)。

---

## 別件: CLAUDE.md/AGENTS.mdが自動で読み込まれない件について

調査の結果:
- `CLAUDE.md` はリポジトリルート(`/home/user/seedance-black-studio/CLAUDE.md`)に存在し、これはClaude Codeが自動読み込みする正しい配置場所。サブディレクトリに競合する `CLAUDE.md` も存在しない。
- `AGENTS.md` もルートに存在するが、これは「CLAUDE.mdの内容をCodex向けに書き写したもの」と明記された別ツール向けファイルであり、Claude Codeの自動読み込みとは無関係。ただし内容が手動同期のため既に一部ドリフトしている(AGENTS.mdには `api/seedance-status.js` が中心ファイルであることやRailway連携の詳細など、CLAUDE.mdより踏み込んだ記述がある)。

配置自体に問題は見当たらず、**「毎回手動でファイルを読めと指示しないと読まれない」という現象の直接的な原因はリポジトリ側の設定不備としては確認できませんでした**。これがセッションごとに実際に発生しているなら、原因はリポジトリ構成ではなく、セッションを開始しているクライアント側(Claude Code CLI/Webのどちらを使っているか、起動時のオプション)にある可能性が高いです。この点はリポジトリ調査だけでは切り分けができないため、次にこの現象が起きたときに「どのクライアント・どの起動方法だったか」を教えていただければ、より具体的に切り分けられます。
