# FlowVid Studio 完成までの全体像(最終更新: 2026-07-15)

> このファイルは、リポジトリ・git履歴・Supabase(本番DB実測)・Vercel設定・ai-rules/READMEを一次調査した結果に基づく。確認できなかった点は「確認できません」と明記している。今後のセッションはまずこのファイルを読むこと。

## 2026-07-15 追加分: 完了・本番適用済み(すべてSupabase本番DB実測 / GitHub PRマージ状態で検証済み)

- **generation_tasksのUPDATE RLSポリシー削除(PR #70)**: 本番適用済み。DB実測で `Users can update own draft generation tasks` は存在せず、`Admins can update generation tasks` のみ残存を確認。
- **generation_tasksのINSERT RLSポリシー削除(PR #71)**: **2026-07-15、本番適用完了。** マージ後、本番Supabaseへマイグレーションを適用し、`pg_policies` 実測で `Users can insert own generation tasks` の消滅を確認済み(残るのは `Admins can delete/update/read generation tasks`, `Users can read own generation tasks` の4件のみ)。一般ユーザーからの直接INSERTは不可能になり、正常系(`generate-prod.html` → `/api/seedance-start` → service-role専用の `reserve_generation_task` RPC)には影響しない。
- **grant_annual_subscription_creditsの権限修正(PR #72)**: 本番適用済み・完全解決。DB実測で、旧3引数版は削除され4引数版のみ存在し、`has_function_privilege('anon', ...)` / `('authenticated', ...)` はともに `false`(service_roleのみ実行可)。以前STATUS.mdで「致命的ブロッカー」としていた `grant_annual_subscription_credits` 未認証実行問題はこれで解消。
- **user_subscriptions・annual_credit_grant_logの権限REVOKE(PR #75)**: **2026-07-15、本番適用完了。** マージ後、本番Supabaseへマイグレーションを適用し、`has_table_privilege` 実測で両テーブルとも `anon_dml=false`, `authenticated_dml=false`, `service_role_dml=true` を確認済み。RLSのdefault-denyに加え、テーブルレベル権限も明示的にservice_role限定になった。Stripe webhook・年額cron・`grant_annual_subscription_credits` RPCはすべてservice_role経由のため影響なし。
- **reference-imagesストレージバケットの制限**: 適用済み。DB実測(`storage.buckets`)で `file_size_limit=52428800`(50MB)、`allowed_mime_types=[image/jpeg, image/png, image/webp, video/mp4, video/webm, video/quicktime]` を確認。手動でのダッシュボード設定と申告どおり。
- **参照画像アップロードの認証必須化(PR #78)**: 本番mainにマージ済み(`664bdf2`)。**この修正が入るまで、`generate-prod.html`のアップロード処理は`Authorization`ヘッダーを送っておらず、`api/upload-reference-image.js`側は元々Bearerトークン必須(401)だったため、参照画像アップロード機能自体が常に失敗する状態だった。** 現在はPreview環境でログイン済みユーザーによる実アップロード成功を実機確認済み。

### 残っている項目

- `flowvid_video_history` はPR #75のスコープ外(用途調査中のため意図的に除外、と本文に明記)であり、依然RLSポリシー0件・権限未整理のまま。次に確認すべき箇所。

## 前提: このサイトは何か

静的HTML(ルート直下の `*.html`) + Vercel Serverless Functions (`api/`) 構成。Next.jsは過去に導入されたが削除済み(コミット `614eacc`)。動画生成はOpenRouter経由でSeedanceモデルを呼び出す。fal.ai経由の旧生成経路は廃止済み(コミット `930ddba`)。決済はStripe。透かし(watermark)処理はRailway上の別サービス `watermark-server/`(Node/Express/ffmpeg)が担う想定。

Supabase本番プロジェクト(`jflpjsdjmlkmkqfahxwy`, ap-northeast-1, ACTIVE_HEALTHY)を実際に確認した。**実データ規模: ユーザー1人、`generation_tasks` 47件、`credit_transactions` 38件。実質まだ稼働(本番運用)していない、開発・検証段階のデータ量。**

---

## サイトとして運営するために必要なもの(全項目)

### 動画生成コア機能
- **生成フロー本体(OpenRouter経由)**: 完了。`api/seedance-start-priced.js` → `api/_lib/seedance-start.js` → `api/seedance-status.js`(ポーリング・完了判定・課金確定・返金・watermark連携の中心ファイル)という流れで実装済み。7月の複数回のリグレッション(fal.ai廃止時)を経て、現在は安定化のためのルール(CLAUDE.md恒久ルール)が敷かれている。
- **料金計算ロジック**: 完了。`api/_lib/video-pricing.js` に実装され、`tests/video-pricing-regression.test.js` で回帰テストあり(ただし `npm test` 等には未接続、実行方法確認できません)。
- **重複生成・二重課金防止**: 完了。DB側で `generation_cooldown`, `single_active_generation_guard` のマイグレーションにより保護。OpenRouter用のatomic refund機構も導入済み(`allow_openrouter_atomic_refund`, `fix_refund_task_status_field_typo`)。
- **タイムアウト生成の自動返金(cron)**: 完了。`api/openrouter-reconcile.js` が15分ごとに動作(`vercel.json` のcron設定で確認)、2時間超放置タスクを返金。
- **透かし(watermark)処理とRailway連携**: **一部対応、要確認**。コード上は `api/video-edit.js` がRailwayの `watermark-server` の `/edit` を呼ぶ実装があるが、README自身が「本リポジトリの他コードとの結線は確認できません」と明記しており、**実際にRailway上でこのサービスが起動していて疎通しているかは未確認**。無料プランは透かしあり、有料プランは透かしなしという設計だが、これが本番で機能しているかは確認できません。

### 決済・課金
- **Stripe決済(単発・サブスク)**: 完了。`stripe-checkout.js` / `stripe-webhook.js` / `stripe-portal.js` / `stripe-config.js` が揃い、Webhookのクレジット付与にはDBレベルの一意制約(`add_stripe_reason_unique_constraint` マイグレーション)による冪等性保護あり。埋め込みCheckout、モバイル決済のリグレッション修正も履歴上確認できる、かなり成熟した実装。
- **年額サブスクの自動クレジット付与(cron)**: 完了。`api/cron-annual-credit-grant.js` が毎日00:15 UTCに実行。日付計算バグは一度発生し `20260705_fix_annual_credit_grant_dates.sql` で修正済み。
- **年額サブスク付与対象statusの不整合**: **要確認・未修正**。cronコードは `active` と `trialing` を付与候補として扱う一方、DB関数 `grant_annual_subscription_credits` は `active` と `past_due` だけを許可し、`trialing` を `invalid` として拒否する。逆に関数単体は `past_due` を許可するが、cronは対象外にしている。意図した仕様を確認し、cronとDB関数の許可statusを一致させる必要がある。今回は記録のみで修正していない。
- **本番Stripeキー(live mode)への切り替え**: **確認できません**。テスト用キーのままか本番稼働用キーに切り替わっているかはVercel環境変数の値を直接見る権限がなく確認できていません(ユーザー側でVercelダッシュボードの確認が必要)。
- **返金・チャージバック対応フロー**: 自動返金(生成失敗時)は実装済みだが、**手動チャージバック対応の運用手順・問い合わせ窓口対応フローは未着手**(help.html等の問い合わせ導線はあるが、運用マニュアルは見当たらない)。

### ユーザー認証
- **ログイン・ログアウト・パスワードリカバリ**: 完了。`login.html`, `logout.html`, `recover.html`, `auth-config.js` あり。
- **新規登録(signup)フロー**: **一部対応・要確認**。専用の `signup.html` は見つからず、`login.html` に統合されている可能性が高いが、内容を行単位で確認していないため断定できません。次に確認すべき箇所。
- **管理者ログイン**: 完了。`admin-login.html` が別途存在。
- **年齢確認の技術的な強制**: **未着手の可能性が高い、要確認**。`terms.html` に「13歳以上、18歳未満は保護者同意が必要」という規約文言はあるが、サインアップ時にこれを技術的にチェックしているコードは見つかっていません。規約に書いてあるだけで実効性がない状態の可能性がある。

### コンテンツポリシー・年齢確認・モデレーション
- **アダルトコンテンツ禁止ポリシー**: `content-policy.html` に明記あり(フィクション含むCSAM完全禁止、成人向けコンテンツも一律禁止)。**注記: 「Black Studio」という名称はダーク系UIテーマの意味であり、アダルト向けサービスではない。** ポリシー文面は完成している。
- **NSFW・違法コンテンツの技術的検知・フィルタリング**: **未着手の可能性が高い、要確認**。リポジトリ内にモデレーション用のコードは見つからず、OpenRouter/Seedance側で上流フィルタリングがされているかは確認できません。**ポリシーで禁止と書いてあるだけで、生成物を自動チェックする仕組みが存在しない可能性が高い。これは違法コンテンツ生成・拡散のリスクに直結するため、実際に運営を始める前に必ず確認すべき最重要項目の一つ。**

### 法務・コンプライアンス
- **特定商取引法に基づく表記(legal.html)**: **一部対応、内容が薄い**。ページ自体は存在し実内容もあるが、事業者名は「Pina Studio」、所在地は「日本」のみ(番地までの住所記載なし)、運営責任者は「Pina Studio 代表」(個人名の記載なし)、電話番号の記載なし。**日本国内で通信販売を行う場合、特定商取引法は住所・電話番号・代表者名などの表示を原則義務付けている。この状態のままの運営は法的リスクがある可能性が高い(最終的な適法性判断は法律専門家に確認要、私からは断定できません)。**
- **利用規約(terms.html)**: 完了(内容は存在)。年齢制限条項あり。
- **プライバシーポリシー(privacy.html)**: ページは存在するが、個人情報保護法(APP)やGDPR相当の要件を満たしているかは行単位で確認しておらず、**確認できません**。
- **コンテンツポリシー(content-policy.html)**: 完了(文面としては存在)。

### インフラ・運用
- **Vercelデプロイ設定**: 完了。`vercel.json` にビルド・ルーティング・cronが正しく設定されている。
- **Supabase DB・RLS**: **一部対応**。実データで確認した結果、RLSは全テーブルで有効。ただし以下のセキュリティ指摘がSupabase Advisorから出ている(実測、2026-07-15時点):
  - ~~`annual_credit_grant_log`, `flowvid_video_history`, `user_subscriptions` の3テーブルはRLSが有効だがポリシーが1つも無い~~ **`annual_credit_grant_log`, `user_subscriptions` は2026-07-15、PR #75の本番適用によりテーブルレベル権限もservice_role限定に確定済み**(`has_table_privilege`実測でanon/authenticated=false)。`flowvid_video_history` はスコープ外で未対応のまま(要確認)。
  - `generated_videos` テーブルに `USING (true) / WITH CHECK (true)` の全許可ポリシーがあり、これはservice_role用の想定だが、意図通りかの再確認が必要。
  - ~~`grant_annual_subscription_credits`, `handle_new_user`, `is_admin`, `set_generation_task_finished_at` の4つの `SECURITY DEFINER` 関数が、未ログインユーザー(anon)からも直接RPC経由で呼び出し可能な状態。~~ **`grant_annual_subscription_credits` は2026-07-15、PR #72の本番適用により解決済み**(DB実測でanon/authenticated実行不可を確認)。残る `handle_new_user`, `is_admin`, `set_generation_task_finished_at` は引数なしのトリガー/チェック用関数で、直接RPC実行しても実害のある副作用が起きない設計であることをコードレビューで確認済み(詳細は本ファイル冒頭の調査ログ外、セッション内のやり取りを参照)。優先度は低い。
  - 漏洩パスワード保護(HaveIBeenPwned連携)が無効。
  - **これらはすべて「一次調査で見つかった実際のSupabase Advisor指摘」であり、放置すると認可バイパスや不正クレジット付与に繋がりうる。運営開始前に必ず精査すべき。**
  - また、リポジトリの `supabase/migrations/` には11ファイルあるのに対し、Supabase側が「適用済み」として認識しているマイグレーションは5件のみ(`20260711`〜`20260714` のもの)。それより前の `20260624`(初期スキーマ)等はSupabase側の管理下に記録されておらず、`supabase/setup-*.sql` 経由で手動適用された可能性が高い。**つまりこのDBのスキーマ管理は「CLI/マイグレーション管理」と「手動SQL適用」の2系統が混在しており、今後のスキーマ変更時に何が本当に当たっているか把握しづらい状態。**
- **Railway(watermark-server)**: **確認できません**。リポジトリ内にRailway設定ファイル(railway.json等)は存在せず、実際に稼働しているインスタンスがあるかどうかは今回の調査環境からは確認不能。ユーザー側でRailwayダッシュボードを直接確認する必要がある。
- **`.env.example` の陳腐化**: **要対応**。README自身が「実態との差分は別途確認が必要」と明記する通り、`.env.example` には現行実装で使われていない旧変数(`SEEDANCE_PROVIDER=mock`, 直接Volcengine接続用の変数等)が並び、実際に使われている `OPENROUTER_API_KEY`, `WATERMARK_SERVER_URL`, `WATERMARK_SECRET`, `CRON_SECRET` 等が載っていない。新しい開発者・AIが環境変数を把握する助けになっておらず、実質使い物にならない状態。
- **エラー監視・ログ収集(Sentry等)**: **未着手**。専用の監視ツール導入は見当たらない。Vercel/Supabase標準ログのみに依存している状態と推測される(確認できません、要ユーザー確認)。
- **CI(継続的インテグレーション)**: **実質未着手**。`.github/workflows/preview-ops-audit.yml` が唯一のワークフローだが、これは特定の過去PR(#37)・特定ブランチにピン留めされた一回限りの監査スクリプトで、今後のPRには発火しない。**通常のlint/test/build確認を行うCIは存在しない。**
- **レート制限**: `api/_lib/seedance-start.js` にそれらしき言及が1箇所あるのみで、専用のレート制限ミドルウェアは見当たらない。悪意あるユーザーによる過剰リクエスト・コスト増大への防御が薄い可能性がある。**確認できません(実装の中身までは未確認)。次に確認すべき箇所。**

---

## 今すぐ運営を始めるにあたって、致命的に足りないもの・ブロックしているもの(優先順位順)

1. **NSFW・違法コンテンツの自動検知の有無が未確認**。ポリシーで禁止と書いてあるだけで技術的な歯止めがあるか不明。動画生成AIサービスは悪用リスクが高く、これが無いまま一般公開するのは最も危険。最優先で確認・対応が必要。
2. ~~未認証で叩けるSECURITY DEFINER関数(特に `grant_annual_subscription_credits`)~~ **2026-07-15、PR #72の本番適用により解決済み**。
3. **特定商取引法の表記が不十分(住所・電話番号・代表者個人名の欠落)**。日本国内で有料サービスとして正式運営するなら法的な穴になりうる。
4. ~~RLSポリシーが1つも無いテーブルが3つ存在(`annual_credit_grant_log`, `flowvid_video_history`, `user_subscriptions`)~~ **`annual_credit_grant_log`, `user_subscriptions` は2026-07-15、PR #75の本番適用により解決済み**(テーブルレベル権限もservice_role限定を実測確認)。`flowvid_video_history` のみ未対応で残存(優先度は他項目より低いが、次に確認すべき箇所)。
5. **Railway watermark-serverの実際の稼働状況が未確認**。無料プランのユーザーに透かし付き動画を渡す設計が本当に機能しているか不明。ここが動いていないと無料/有料の差別化が機能しない。
6. **本番Stripeキーがlive modeになっているか未確認**。テストモードのままだと実際の課金が発生しない(＝収益が入らない)、あるいは逆に思わぬ請求が発生するリスク。
7. **年齢確認が規約の文言だけで技術的な強制がない可能性**。未成年利用の法的リスク。
8. **サインアップフローの詳細が未確認**(メール確認は必須になっているか、等)。なりすまし・大量アカウント作成のリスクに関わる。
9. **CIが実質存在しない**。今後の変更で正常系を壊すリスク(7月に実際に複数回発生した問題)が継続する。少なくともbuild確認だけでも自動化すべき。
10. **`.env.example` が実態と乖離**していて、今後別の担当者・AIが環境構築するときに間違った変数を設定するリスクがある。

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