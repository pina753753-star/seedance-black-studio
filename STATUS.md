# FlowVid Studio 完成までの全体像(最終更新: 2026-08-15)

> このファイルは、リポジトリ・git履歴・Supabase(本番DB実測)・Vercel設定・ai-rules/READMEを一次調査した結果に基づく。確認できなかった点は「確認できません」と明記している。今後のセッションはまずこのファイルを読むこと。

## 2026年8月15日 作業ログ

### 完了した項目

- 参照画像アップロードにOpenAI Moderation(sexual/minorsカテゴリ)による児童保護検査を追加(PR #169)。隔離バケットへのアップロード後、署名付きURL経由で検査し、合格したもののみ公開バケットへコピー。ブロック時はmoderation_blocksテーブルに記録(mode: reference_image_upload)。
- TEST_BYPASS_USER_ID限定だった参照画像アップロード機能を一般ユーザーに解放(PR #170)。対象: api/upload-reference-image.js、api/reference-image-upload-url.js、api/reference-image-confirm-upload.js、api/storyboard-prompt.js、api/seedance-start-priced.js、generate-prod.html。認証チェック・sexual/minors検査・通常の生成時モデレーションは維持。自動テスト140件成功。
- ベータ提供を開始。オープンチャット経由で3人を限定募集し、フィードバックを収集する運用。対象者には新規登録時800クレジットを自動付与、既存の付与済み17人分は変更なし。
- 本番反映・表示確認済み(main SHA: 8cdf7db)。

### 未対応・残タスク・重要な注意点

- CSAM既知ハッシュ照合(PhotoDNA/Thorn Safer Match等)、正確な年齢確認、実在人物・有名人検知は依然として未実装。sexual/minorsという汎用モデレーションカテゴリのみに依存している状態。
- 「URLを知っている人限定」は運用上の案内であり、コード上のアクセス制限ではない。メール確認済みの認証ユーザーであれば技術的には誰でも参照画像機能にアクセス可能。
- moderation_blocksテーブルの記録を定期的に確認し、想定外の利用がないか監視する運用が必要。
- ベータの反応・moderation_blocksの記録傾向を見て、専門の画像モデレーションサービス(Hive Moderation等)導入の要否を今後判断する。

## 2026年8月14日 作業ログ

### 完了した項目

- 動画編集機能に「区間削除」を追加(PR #167)。動画の途中区間だけを削除し、前後をつなげる編集が可能に。UI上は対象クリップを2つのクリップに自動分割する方式(グループ化した表示は見送り)。本体版・VLLO版の両UIに実装。
- 区間削除モードのプレビュー追従バグを修正(ドラッグ中に映像が固定されたまま動かない問題)。
- プレビューシークの40ms間引きをVLLO版にも導入(本体版に既存の仕組みを移植)。導入直後、pointerdown時のシークまで間引かれてしまい「一度も映らない」重大な後退が発生したが、force/commitを分離して即日修正。
- 本番デプロイ・マージ完了(commit `d2d618c`)。

### 未対応・残タスク

- 区間削除機能は初見で分かりにくいという評価(3回操作してようやく理解できたとのフィードバック)。将来的に2クリップをグループ化して1つの編集対象に見せるUI改善の余地あり。
- プレビューのシーク反応は依然「ワンテンポ遅い」体感が残る。動画のシーク処理自体の重さに起因する可能性があり、追加の改善には別途調査が必要。
- 本番実機での区間削除機能の最終確認(ドラッグ追従・確定後の生成結果)は未実施。

## 2026年8月10日 作業ログ

### 完了した項目

- 削除ボタンの実体化(`api/delete-generated-video.js`新規追加)。DB行・Storageファイルを実際に削除する処理に変更。削除件数を検証し、0件の場合はエラー扱いにする修正も追加。本番でDBレコード数の減少を確認済み。
- Stripe決済画面の請求元表示名を「CHANO」から「pina studio」に統一。
- 参照画像アップロードを署名付きURL方式に刷新(`api/reference-image-upload-url.js`、`api/reference-image-confirm-upload.js`新規追加)。Vercelのリクエストボディ上限(約4.5MB)を経由しない設計に変更。上限を10MB→20MBに引き上げ。本番で24MP画像のアップロード→生成→再生まで確認済み。
- content_policy_violationでブロックされたリクエストの記録機能を追加(`moderation_blocks`テーブル新規作成、`api/_lib/seedance-start.js`に記録処理追加、`admin.html`に一覧表示セクション追加)。本番デプロイ済み(commit `fa627f3`)。実機での動作確認(admin.htmlでの表示確認)は未実施。

### 未対応・残タスク

- CAPTCHA(Cloudflare Turnstile)のsite keyは引き続き未設定(空文字)。
- 非公開バケット化(reference-imagesの公開設定)は見送り。既存の公開URL方式のまま運用継続の判断。
- 参照画像アップロード機能は引き続きTEST_BYPASS_USER_ID限定で、一般ユーザーには503のまま無効化されている。
- プロンプトフィルタ(fictional-action-classifier.js)が通常のアニメアクション表現を誤ってブロックする問題は未解決。moderation_blocksの記録が溜まり次第、実際のブロック傾向を分析して調整する予定。
- moderation_blocks機能の本番実機確認(admin.htmlでの表示確認)は未実施。

## 2026-08-03 追加分: 完了・本番適用済み

- **公開向けの新規登録画面を再開(PR #147)**: `login.html`で非表示だった新規登録タブを再表示し、「限定ベータ」の案内を削除した。画面には、18歳以上のみ登録可能であること、登録後に確認メール内のリンクを開いてからログインすること、参照画像を使う動画生成は安全確認完了まで利用できないことを明記した。利用規約・プライバシーポリシーへのリンクも追加した。

- PR #147で新たに年齢確認処理を作ったのではなく、既存の生年月日入力、18歳未満のクライアント側拒否、`birth_date`送信、および年齢確認用SQLが存在する状態で、登録入口を再公開した。PR #147の変更対象は`login.html`1ファイルのみで、Supabaseマイグレーション・認証設定・DB・生成・決済処理は変更していない。

- PR #147をmainへマージし、マージコミットは`04cee3fcfcf5edab4a770144eda1dd25ce3ab665`。対応するVercel Production Deployment `dpl_7Wi4iLBiYdT5YnMRFWsZ5woG3kP1`が`READY`であることを確認した。

- **生成画面の初期表示変更と参照画像タブの準備中表示(PR #148)**: `generate-prod.html`の初期表示を「テキストから動画」へ変更し、一般ユーザー向けのリファレンスタブを「リファレンス（準備中）」として無効化した。URL・下書き・保存済みモードが`reference_to_video`の場合も、一般ユーザーは`text_to_video`へ安全側に戻す。

- 運営テスト用ユーザーだけは、認証済みユーザーIDをサーバー側の`TEST_BYPASS_USER_ID`と比較する`api/reference-image-access.js`を通じてリファレンスタブを有効化する。未認証、APIエラー、設定不足、判定不能時は`isTestBypassUser: false`として一般ユーザー扱いを維持する。クライアントへテスト用ユーザーID自体は返さない。

- PR #148をmainへマージし、マージコミットは`2ef90c045f6196e3b63596204c012726294c6170`。対応するVercel Production Deployment `dpl_8g5BQTXvG7LL9yY91SU2anU85Y43`が`READY`であることを確認した。

- 上記2件について、実動画生成、クレジット消費、実決済、本番DB書き込みは行っていない。本番Supabaseで年齢確認Hookが現在有効か、実登録から確認メール・ログインまで完了するか、18歳未満が本番サーバー側でも拒否されるか、一般ユーザーの実機で参照画像タブが確実に無効かは、確認できません。公開前の実機確認が必要。

## 2026-08-01 追加分: 完了・本番適用済み

- **参照画像の安全検知設計を追加(PR #140)**: `docs/operations/REFERENCE-IMAGE-SAFETY-DESIGN.md`を新規追加し、一般ユーザー向け参照画像生成を再開する前に必要な、実在人物・有名人、年齢リスク、既知・新規CSAMの専用検知候補と安全側停止条件を整理した。

- 現行のOpenAI Moderationだけでは、実在人物判定、正確な年齢確認、既知CSAM照合、本人同意確認を保証できないことを明記した。

- Thorn Safer Match / Safer Predict、Microsoft PhotoDNA、Amazon Rekognition DetectFaces / RecognizeCelebritiesの役割と限界を整理した。

- 現行フローでは`generate-prod.html`が生成開始より前に`/api/upload-reference-image`を呼ぶため、生成開始API側への検知追加だけでは不十分であることを確認した。

- 検査前画像を非公開隔離領域へ一時保存し、全検査合格前は公開URLを発行せず、拒否・障害・途中キャンセル時には隔離画像を削除する設計を明記した。

- 削除失敗の記録・通知、保存期間の最小化、自動削除期限、危険画像を運営者が直接開かない条件を整理した。

- 一般ユーザー向け参照画像生成の停止は継続しており、この文書の追加だけでは再開していない。

- PR #140をmainへマージし、マージコミットは`0e08422094431ded24c40eb3bba66de6acf3997b`。

- 変更対象は新規文書1ファイルのみ。API、Storage設定、DB、認証、決済、環境変数、モデレーション、生成処理は変更していない。

- 実API、実画像判定、動画生成、クレジット消費、本番DB書き込みは行っていない。

- 料金、契約資格、日本からの利用可否、採用サービス、判定しきい値、実装、Preview・本番確認は未完了。

## 2026-07-31 追加分: 完了・本番適用済み

- **管理画面を閲覧専用へ再整備(PR #136)**: `admin.html`を再整備し、管理者以外のアクセスを制限した。ログイン後にSupabaseセッションの管理者メール一致とprofilesテーブルの`role==='admin'`を再確認し、いずれか不一致の場合は`admin-login.html`へリダイレクトする。ユーザー・クレジット残高の全件取得を`fetchAllRows()`で1000件単位のページングへ変更し、生成タスク履歴・ジョブ一覧等の一覧表示は「さらに20件表示」ボタンによる20件ずつの追加表示へ変更した。画面には「この管理画面は閲覧専用です。DB更新・削除、クレジット変更、動画生成、決済操作は行いません。」という案内文を明記した。PR #136をmainへマージし、マージコミットは`ac97baefe218c7c347a316b876bd260520e440aa`。PR #136のVercelデプロイチェックが成功していることを確認した。Railwayのチェックは、このPRのGitHub上のチェック一覧には見当たらず、確認できていない。変更対象は`admin.html`のみで、API、DBスキーマ、Supabase認証設定、決済、生成処理の変更、実API呼び出し、クレジット消費、本番DB書き込みは行っていない。

- **決済・返金・チャージバック対応手順を追加(PR #138)**: 運営者向けの`docs/operations/PAYMENT-REFUND-PROCEDURE.md`を新規追加し、返金依頼・重複請求・身に覚えのない請求・チャージバック発生時の本人確認、二重返金防止、クレジット調整、証拠提出、対応停止条件を整理した。問い合わせフォームへ入力されたメールアドレスは本人確認の証拠として扱わないことを明記した。2026年7月31日時点の`api/stripe-webhook.js`は決済成功・サブスクリプション更新削除・クレジット付与を主に処理しており、返金・チャージバックイベントに連動して付与済みクレジットを自動調整する処理は確認できないことを明記し、Stripeで返金しただけでクレジットや契約状態が自動的に整合すると判断してはならないとした。PR #138をmainへマージし、マージコミットは`2109bbac5dfabd874b71657373a3f33c589a30c6`。変更対象は新規文書1ファイルのみで、実返金、Stripe操作、本番DB書き込み、クレジット変更は行っていない。

## 2026-07-29 追加分: 完了・本番適用済み

- **アカウント削除依頼の運用手順を追加(PR #128)**: 運営者向けの`docs/operations/ACCOUNT-DELETION-PROCEDURE.md`を新規追加し、削除依頼の受付、本人確認、Stripe契約・支払い確認、Supabase Storage・Database確認、Supabase Auth削除、Formspree・外部サービス・ログ・バックアップ確認、利用者への完了連絡までを順序化した。本人確認前に削除しないこと、ユーザーIDで対象を照合すること、Supabase Authを最後に削除すること、未処理の契約・返金・生成タスク・安全調査等がある場合の停止条件、確認できない保存先を「完全削除済み」と断定しないことを明記した。PR #128をmainへマージし、マージコミットは`8a87404a3238193b6ce06f6f63514af944263daf`。変更対象は文書1ファイルのみで、API、DB、認証、決済、生成処理の変更、実削除、実API呼び出し、クレジット消費、本番DB書き込みは行っていない。

- **不適切コンテンツ通報の運用手順を追加(PR #131)**: 運営者向けの`docs/operations/CONTENT-REPORT-PROCEDURE.md`を新規追加し、通報分類、重大度、初動時間、危険画像の確認方法、停止・非公開・削除判断、証拠保存、異議申立て、専門機関への相談基準を整理した。PR #131をmainへマージし、マージコミットは`123cd54fd5897f3c4be21936b0c532f8daa326d6`。変更対象は文書1ファイルのみで、実API、動画生成、クレジット消費、本番DB書き込み、実停止・削除・返金は行っていない。

- **日次・週次運営チェックリストを追加(PR #134)**: 運営者向けの`docs/operations/DAILY-OPERATIONS-CHECKLIST.md`を新規追加し、本番サイト、管理画面、Formspree、Stripe、Vercel、Railway、外部API利用額の確認順と停止条件を整理した。これは継続運用の手順書追加であり、第10段階の定期確認をすべて実施済みという意味にはしない。PR #134をmainへマージし、マージコミットは`83a3b83d50a6f413df78a71b2e33fa6e58e42b75`。変更対象は文書1ファイルのみで、実API、動画生成、クレジット消費、本番DB書き込み、実停止・削除・返金は行っていない。

- **緊急停止・障害対応手順を追加(PR #135)**: 運営者向けの`docs/operations/INCIDENT-RESPONSE-PROCEDURE.md`を新規追加し、緊急度、初動、停止判断、ロールバック、復旧、告知、事後記録を整理した。生成機能全体を即時停止する専用スイッチは未実装であることも明記し、第6段階全体を完了扱いにはしない。PR #135をmainへマージし、マージコミットは`f549bfcd8293343f22686ab049fc6fe447ce0eaa`。変更対象は文書1ファイルのみで、実API、動画生成、クレジット消費、本番DB書き込み、実停止・削除・返金は行っていない。

## 2026-07-28 追加分: 完了・本番適用済み

- **リファレンス画像アップロードの状態表示と最大9枚対応(PR #120)**: リファレンス画像を既存画像を残したまま追加でき、合計最大9枚まで利用できるようにした。各画像にアップロード中、完了、失敗、再試行の状態を表示する。画像から動画、通常リファレンス、絵コンテ確定画像の状態を分離し、タブ切り替え時に画像が混入・消失しないようにした。

- **FileListリセットによる画像選択消失を修正**: 画像選択後にファイル入力を空にする処理で、ブラウザ上のFileListも空になり、リファレンスと画像から動画の両方で画像を1枚も追加できなくなる不具合をPreview確認で発見した。入力を空にする前に選択ファイルを配列へ確定する修正を追加した。

- **確認・本番反映**: 既存123件とFileList再現テスト9件の合計132件が成功。スマートフォンのVercel Previewで、通常リファレンスの1枚・3枚・9枚追加、9枚上限、画像から動画の1枚追加、完了チェック表示を確認した。PR #120をmainへマージし、マージコミットは`1177672f66e5ef89d65b6d31be44e5750df42ea2`。Vercel Productionが`READY`であることを確認済み。実動画生成、動画生成クレジット消費、本番DB書き込みは行っていない。

- **GitHub mainブランチ保護を有効化**: GitHub Ruleset `Protect main branch`を作成し、状態をActive、対象を既定ブランチ`main`に設定した。mainの削除とforce pushを禁止し、変更はPull Request経由を必須化した。未解決のレビュー会話がある場合はmergeできない設定を有効化した。一人運営のため必須承認数は0とし、必須ステータスチェックは実行条件の整理後に設定するため現時点では未設定。Bypass対象は設定していない。

- **ログイン画面を限定ベータ表示に変更(PR #123)**: `login.html`のタブ構成を1カラムへ変更し、新規登録タブを`hidden`属性で非表示にした。あわせて「現在は限定ベータ版です。新規登録は運営者から案内を受けた方のみ利用できます。」という案内文を追加した。この変更はログイン画面上の表示制御のみであり、新規登録処理そのものを停止するサーバー側・DB側の変更は含まれない。変更対象は`login.html`のみ。PR #123をmainへマージし、マージコミットは`3a081015e76ced28f40fa506bd87c5a5a08f6c4d`。実動画生成、動画生成クレジット消費、本番DB書き込みは行っていない。

- **利用規約・プライバシーポリシーを18歳以上の現行仕様に統一(PR #124)**: `terms.html`の年齢条件を18歳以上限定へ統一し、保護者同意による未成年利用に関する記載を削除した。`privacy.html`にメールアドレス・生年月日・パスワード管理方法の取り扱いを追記し、現在使用していないGoogleログインに関する記載を削除、Supabaseの用途説明を現行構成に合わせて更新した。変更対象は`terms.html`と`privacy.html`のみ。PR #124をmainへマージし、マージコミットは`ebb3e073a91a559f9b030d0694ed8c7128347b12`。実動画生成、動画生成クレジット消費、本番DB書き込みは行っていない。

- **保存データ一覧の追加とプライバシーポリシーの現行実装への修正(PR #126)**: 運営確認用の`DATA-INVENTORY.md`を新規追加し、Supabase Auth・Database・Storage、Stripe、OpenAI、OpenRouter、Anthropic、Railway、Formspree、Vercel、利用者ブラウザ等で取り扱うデータ、用途、削除時の確認事項を一覧化した。`privacy.html`には、OpenAIによる生成前モデレーション、OpenRouter・Anthropicによる生成・絵コンテ処理、Railway上の動画処理、Formspreeによるお問い合わせ受付を追記した。根拠を確認できなかった「アクセスログ最大90日」の固定期間を削除し、アカウント削除申請方法をヘルプセンターのお問い合わせフォームへ修正した。DB上のアカウント削除だけでは外部サービス、Storage、ログ、バックアップ等が直ちに自動削除されない場合があることも明記した。レビューで発見されたOpenAIの記載漏れも修正済み。PR #126をmainへマージし、マージコミットは`63a2c03d0b0111ea4ad807e137ddf6ec843b6360`。Vercel・Railwayのチェックは成功。変更対象は`privacy.html`と`DATA-INVENTORY.md`のみで、API、DB、認証、決済、年齢確認、生成処理の変更、実API呼び出し、クレジット消費、本番DB書き込みは行っていない。

## 2026-07-27 追加分: 完了・本番適用済み

- **絵コンテ機能を単一統合プロンプト方式へ全面改修(PR #116)**: 旧方式の「カットごとに複数動画を生成し、ブラウザ内のffmpegで結合する処理」を廃止し、「絵コンテ画像1枚をClaudeで解析して1本の統合プロンプトを作成し、既存のリファレンス動画生成フローで動画を1回だけ生成する方式」へ変更した。新規API`api/storyboard-prompt.js`は認証済みユーザーのみ利用でき、画像形式・容量検証、簡易クールダウン、OpenRouter障害時の安全側停止を実装。プロンプト作成時には動画生成タスクを作成せず、ユーザーの動画生成クレジットも消費しない。

- **絵コンテ画面と既存生成フローの統合**: `generate-prod.html`へ絵コンテタブを統合し、画像アップロード、モデル・秒数・解像度・アスペクト比選択、統合プロンプト作成、プロンプト編集、動画生成までを同じ画面で行えるようにした。動画生成時は新しいDB上のmodeを追加せず、既存の`reference_to_video`を使用する。モデレーション、クレジット控除・返金、ポーリング、履歴保存、ウォーターマーク処理は既存の正常系をそのまま利用する。

- **動画生成予定クレジットの事前表示を追加**: 「プロンプトを作る」前に、選択中のモデル・秒数・解像度に応じた動画生成予定クレジットを表示するようにした。「プロンプト作成時はクレジットを消費しません」と明示し、料金式は通常生成画面と共通化して重複を防止。Standard・5秒・720pは110 credits、Fast・5秒・720pは90 credits、Standard・10秒・1080pは315 credits、Standard・15秒・720pは285 credits、Standard・15秒・1080pは400 creditsとなることを確認した。

- **Fastモデルと1080pの利用不可設定を事前制御**: 絵コンテ画面でFastモデルを選んだ場合は1080pを選択不可にし、1080p選択中にFastへ切り替えた場合は自動的に720pへ戻して予定クレジットを再計算するようにした。Standardモデルでは1080pを利用できる既存仕様を維持した。

- **絵コンテと通常リファレンスの下書きを完全分離**: 絵コンテの画像・統合プロンプト・モデル・秒数・解像度・アスペクト比・準備完了状態を専用下書きとして保存するようにした。通常リファレンスタブの画像・プロンプトへ絵コンテ内容が混入する不具合を修正し、リロード後も絵コンテタブと作成済み内容を復元する。過去のPreviewで共有下書きへ混入したデータは、絵コンテ専用下書きの画像URLとプロンプトが両方完全一致する場合だけ安全に除去し、通常のリファレンス下書きは削除しない。

- **旧絵コンテ画面・旧APIの安全な停止**: 旧画面`generate-cool.html`は`generate-prod.html?mode=storyboard`へ移動する案内ページへ変更。旧`api/seedance-status.js?_r=sb`経路はHTTP 410を返して停止し、古い未認証の解析経路が残らないようにした。

- **実機確認・本番反映完了**: Vercel Previewで、絵コンテ画像からのプロンプト作成、プロンプト完成後の絵コンテタブ維持、予定クレジット表示、Fast＋1080p制限、リロード後の内容復元、通常リファレンスタブとの下書き分離をスマートフォンで確認した。PR #116をmainへマージし、マージコミットは`df3026124fbac007af076defff2344e848cc10ee`。Vercel Production Deployment `dpl_HLmXZWbh8hNqXQmbTQBHXfNeRPBS`が`READY`で、mainの同コミットに対応していることを確認済み。実際の動画生成、動画生成クレジット消費、本番DBへの書き込みを伴うテストは行っていない。

- **サービス資産台帳の追加(PR #118)**: `docs/operations/SERVICE-ASSET-REGISTER.md`を新規追加。マージコミット`75b4d1a4a2348729c84c04219ec05172d6836e0f`。Vercel Production `dpl_9rtp6boAERBGrbHEeiHCjY6NjNS5`がREADYであることを確認済み。コード、API、DB、認証、決済、生成処理の変更はなし。

- **外部サービスのアカウント保護確認**: GitHub、Vercel、Supabase、Stripe、OpenAI、Railway、お名前.comで多要素認証(MFA)または2段階認証(2FA)が有効であることを実画面で確認した。OpenRouterはGitHub連携ログインとGitHub側2FAによる保護を確認した。GitHubの復旧コードは保存済み。Railwayのセッション確認では、現在使用中のiPhone以外に有効な不審セッションはなかった。Supabaseの予備ログイン方法は未設定で、整備は後回しとした。

- **運用通知・契約確認**: OpenRouterの残高不足アラートが有効(通知しきい値10ドル)、自動チャージは無効であることを確認した。Stripeのログイン用メールアドレスの変更を完了した(実際のメールアドレスはここには記載しない)。`pinastudio.jp`はお名前.com管理で、SMS方式の二段階認証が有効、自動更新は設定済み、更新期限日・登録期限日は2027-07-31であることを確認した。

## 2026-07-24 追加分: 完了・本番適用済み

- **動画生成入口APIの古い重複クレジット計算を削除**: `api/seedance-start-priced.js`に残っていた、リファレンス15秒・720p・通常モデルを250クレジットと誤計算する古い料金式、10クレジット単位の丸め、`client estimate mismatch: 285 server: 250`警告、`estimated_credits`を250へ上書きする処理を削除した。実際の残高確認・クレジット控除は従来から`api/_lib/seedance-start.js`が正しい式で再計算しており、画面表示・実消費とも285クレジットの正常動作は変更していない。料金計算の実行元を本体APIへ一本化し、入口APIはモデル確認、参照画像一時停止条件、認証、本体への委譲だけを担当する構造に整理した。
- **セルフレビュー・本番反映完了**: 最初の修正後に不要な正規化関数と呼び出しが残っていることをセルフレビューで検出し、同じ`api/seedance-start-priced.js`内だけで追加整理した。関連commitは`3e3bd43`と`7d2e1f5`。変更対象は同ファイルのみで、`api/_lib/seedance-start.js`、画面側料金表示、モデレーション、クレジット控除・返金、DB、OpenRouter、Stripe、環境変数には触れていない。Vercel Production Deployment `dpl_TN1yVkbC6nTwXZPa6y9RHtZRqXGh`が`READY`で本番反映済み。実動画生成、OpenRouter実API呼び出し、クレジット消費テスト、本番DB書き込みは行っていない。

## 2026-07-23 追加分: 完了・本番適用済み

- **架空アニメ表現に対する二次モデレーション誤判定の改善**: 一般的なアニメーションとして、成人女性キャラクターが蚊とコミカルに戦う非グラフィックな場面が、二次判定で`adult_or_nonhuman_only:false`・`minor_harm:true`と誤判定され、生成開始前にHTTP 422で拒否されていた問題を調査・修正した。残虐表現、重大危害、性的暴力、武器指南等の危険項目はすべて`false`で、`fictional_setting:true`・`non_graphic_action:true`だったため、具体的な未成年の根拠がない架空キャラクターを画風や曖昧な印象だけで未成年扱いしていたことが主因だった。
- **二次判定の矛盾検知と再判定処理の追加**: 二次判定結果の論理的な食い違いを検証し、矛盾を検出した場合に1回だけ再判定する処理を追加。再判定後も矛盾が解消しない場合は、安全上のコンテンツ違反を示す422ではなく、判定システム側の不整合として503で停止する構造にした。関連commitは`13582e7`。当時の回帰テストは48件すべて成功。
- **成人・非人間キャラクター判定基準の明確化**: 明示された成人キャラクターや、精霊・ロボット等の非人間キャラクターを正しく評価できるよう二次判定プロンプトを調整した。具体的な未成年設定がある場合の児童保護基準は維持した。関連commitは`fdbb7c5`。当時の回帰テストは52件すべて成功。
- **二次判定の最終許可判断をコード側へ移行**: LLMに最終的な`decision`を返させる方式を廃止し、11個の個別安全項目をLLMに判定させ、最終許可は`allSafetyConditionsSatisfied`によりコード側で計算するPattern Aへ変更した。これにより、個別項目と最終判断が食い違う問題を防止した。関連commitは`3529e1f`。当時の回帰テストは57件すべて成功。
- **一般的なオリジナルアニメキャラクターの年齢誤判定を改善**: `api/_lib/fictional-action-classifier.js`の判定基準を明確化し、明示的な成人・非人間キャラクターを正しく評価するとともに、一般的なオリジナルのアニメ・漫画・ゲーム風キャラクターを、具体的な未成年の根拠なしに未成年扱いしないよう調整した。「女の子」「男の子」「かわいい」「小柄」「若く見える」「chibi」「大きな目」等の曖昧な表現だけでは未成年と断定しない。一方、具体的な年齢、児童・未成年の明記、学校区分等の明確な情報がある場合は従来どおり慎重に扱う。児童の性的描写、児童搾取、実在人物へのなりすまし、性的暴力、拷問、処刑、切断、重大な残虐表現等の禁止基準は緩和していない。関連commitは`3190417`。
- **回帰テスト・本番反映完了**: 最終修正後、`tests/fictional-action-classifier.test.js`を含む全62テストが成功。commit`3190417cbd80e5b200d1dbd41ba0da7d333ee27a`を`origin/main`へ通常pushし、Vercel Production Deployment `dpl_Asqb5qqJy7YERxLgHncbKohKsSoy`が`READY`、build errorなし、本番トップページがHTTP 200であることを確認した。
- **本番での動画生成確認完了**: 以前拒否されていたものと同系統のプロンプトをユーザー本人が本番環境で再試行し、15秒・910×512・30fpsの動画生成に成功した。内容は夏の夜の室内でアニメキャラクターが蚊とコミカルに格闘する非グラフィックな場面で、流血、残虐表現、性的表現は確認されなかった。これにより、児童搾取や悪意ある重大表現への防止基準を維持しつつ、一般的な非グラフィックのアニメーションを過剰に拒否しないことを本番環境で確認した。
- **生成中の画面復帰時に既存タスクへ再接続する処理を本番反映**: スマートフォンの画面ロック、別アプリへの移動、ブラウザのバックグラウンド化などから生成画面へ戻った際、生成中タスクが存在する場合だけページを安全に再読み込みし、既存タスクへ再接続する`installGenerationResumeRecovery()`を`flowvid-open-inline.js`へ追加した。新規生成APIの再送、クレジットの再消費、定期ポーリングの追加は行っていない。動画編集・絵コンテ中は再読み込みしない。関連commitは`08a06d5`。Vercel Production Deployment `dpl_D6HKoqva7544JWd2e9EW7CMa2M54`が`READY`、build errorなしで本番反映済み。
- **独自ドメイン`pinastudio.jp`の接続完了**: Vercelへ`pinastudio.jp`と`www.pinastudio.jp`を追加し、お名前.comでルートドメインのAレコードを`216.150.1.1`、`www`のCNAMEを`08d3d2e87c62fe01.vercel-dns-017.com`へ設定。ネームサーバーを`01.dnsv.jp`〜`04.dnsv.jp`へ変更後、両ドメインがVercelで`Valid Configuration`になったことを確認した。スマートフォンから`https://pinastudio.jp`へSSL警告なしでアクセスでき、トップページ、ロゴ、生成開始ボタン、サンプル動画、フッターが正常表示されることを実機確認済み。

## 2026-07-22 追加分: 完了・本番適用済み

- **サイトブランドの「FlowVid Studio」→「Pina Studio」変更完了(PR #109)**: `index.html`、`generate-prod.html`、`login.html`、`pricing.html`、`help.html`、`profile.html`、`legal.html`、`privacy.html`、`terms.html`、`content-policy.html`、`credits-info.html`等の画面表示文言、favicon、OGP設定、見出し配色をPina Studio向けに統一。先行して導入済みだったヘッダーロゴ・ブランド画像とあわせて、本番mainへのブランド変更を完了した。関連commitは`9f66a9b`。
- **サブスクリプション解約機能の実装・本番反映(PR #109)**: `cancel-subscription.html`と`api/cancel-subscription.js`を追加し、利用者がサブスクリプション解約手続きを行える導線を実装。本番mainへ反映済み。Stripeの料金・credits計算・既存決済処理そのものは今回変更していない。
- **ヘルプ・法務ページ6ページの配色調整**: ヘルプ、利用規約等の対象6ページで、水色リンクを白文字＋下線へ変更し、グラデーションボタンをグレー(`#3a3a3f`)＋白文字へ変更。Pina Studioの黒基調デザインへ統一した。表示上の配色変更のみで、本番mainへ反映済み。関連commitは`8f00c12`。
- **watermark-serverのブランド表記変更**: `watermark-server/server.js`の無料プラン向けウォーターマーク文字を旧「FlowVid」から「Pina Studio」へ変更し、ヘルスチェック応答のブランド表記もPina Studioへ変更。本番mainへ反映。関連commitは`20d45fa`。
- **「Pina Studio」の空白によるwatermark-server本番障害の修正**: fluent-ffmpegの`outputOptions()`へ配列形式でオプションを渡していたため、スペースを含む`Pina Studio`の`-vf`値が内部で分割され、無料プランの動画生成がウォーターマーク処理で失敗する障害が発生。`watermark-server/server.js`で`outputOptions()`を配列渡しから複数引数渡しへ変更し、`-vf`値を1つの引数として保持するよう修正した。`-c:a copy`、`-movflags +faststart`等の既存設定は維持。関連commitは`81162c8`。
- **Railway反映・無料プランの本番実機確認完了**: commit`81162c8`をmainへpush後、Railwayの本番サービスでGitHub連携によるデプロイが`Deployment successful`、サービス状態が`Active`、port 8080での起動を確認。無料プランで新規動画生成テストを1回だけ実施し、生成・再生に成功。動画右下に`Pina Studio`のウォーターマークが正常表示され、旧`FlowVid`表記、文字切れ、空白での分割がないことを実機確認した。今回の緊急障害は解消済み。

## 2026-07-20〜21 追加分: 完了・本番適用済み

- **お問い合わせフォームへの「コンテンツ通報」カテゴリ追加(PR #98)**: `help.html`のお問い合わせ種別セレクトに、著作権侵害・不適切コンテンツ・児童安全に関する懸念を通報するための「コンテンツ通報」を追加。選択時のみ対象の動画URL・ユーザー名等を入力する任意欄(`#f-target`)を表示し、Formspree送信データに`category`(`normal`/`urgent_content_report`)・`target`フィールドを追加。既存のbug/billing/usage/otherの挙動は変更なし。本番mainへマージ済み。
- **参照画像生成の一時停止に対するテスト用バイパス機能の追加(PR #99)**: `api/seedance-start-priced.js`に、環境変数`TEST_BYPASS_USER_ID`(Supabaseの`user_id`のUUID、Vercelダッシュボードで設定)で指定した単一ユーザーのみ、参照画像を使った動画生成の一時停止(503)をバイパスできる仕組みを実装。バイパス判定は既存の`requireConfirmedAuth()`で取得したユーザーIDとの厳密一致で行い、バイパス時も`api/_lib/seedance-start.js`側の既存のOpenAI Moderation API検査・認証・課金処理は変更なくすべて実行される。テスト用途であり、テスト終了後は本コードと環境変数の削除を検討する前提。本番mainへマージ済み。
- **OpenAI Moderation APIの複数画像対応(PR #100)**: `api/_lib/openai-moderation.js`の`moderateContent()`を修正。OpenAI Moderation APIは1リクエストにつき画像1枚までしか受け付けないため、参照画像が2枚以上のリクエストで`too_many_images`(400)エラーが発生し、安全側の503で生成が停止していた問題に対応。画像URLを1枚ずつ個別のAPIリクエストに分割(プロンプトテキストは1枚目に同梱)し、最大3並列で実行するよう変更。いずれか1枚でもflaggedなら全体をflagged扱いとし、categoriesは全呼び出し分を集約。いずれかの呼び出しでエラーが発生した場合は従来通り安全側の`{ ok: false }`として扱う。呼び出し元(`seedance-start.js`)から見たインターフェース(`moderation.ok`/`moderation.flagged`/`moderation.categories`)は変更なし。これにより参照画像最大9枚までのモデレーション検査に対応可能になった。本番mainへマージ済み。
- **動画編集タブの保存ボタンをBlobダウンロード方式に統一(PR #101)**: `generate-prod.html`の動画編集タブの保存ボタン(`#veResultSave`)を、単純な`<a href>`直リンクから、動画をfetchで取得しBlobとしてダウンロードさせる方式(`veSaveEditedVideo`)に変更。取得失敗・空データ時は`#veError`にエラーメッセージを表示。本番mainへマージ済み。
- **動画編集履歴カードへの個別保存ボタン追加(PR #102)**: `flowvid-video-edit-vllo.js`の編集済み動画履歴カード(`veHistoryCardHtml`)に、カードごとの「保存」ボタンを追加。PR #101と同じBlob取得→ダウンロード方式(`saveVlloHistoryVideo`)を実装し、ファイル名は編集ID付き`flowvid-edited-<editId>.mp4`。履歴リストへのイベント委任でクリックを処理。本番mainへマージ済み。
- **新規登録者向け無料クレジット付与キャンペーンの実装(マイグレーション`20260720000000_add_signup_credit_campaign.sql`)**: `private.signup_credit_campaigns`(キャンペーン設定)・`private.signup_credit_grants`(付与記録)テーブルを新規作成し、`handle_new_user()`トリガー関数を置き換え。設定行を`FOR UPDATE`で排他ロックしたうえで新規登録者へクレジットを付与し、上限到達後は0クレジットで登録を継続する設計。キャンペーン処理部分だけで障害が起きた場合も新規登録自体は止めず0クレジットにフォールバックする。**Supabase本番DBへマイグレーション適用済み**、DB実測で`private.signup_credit_campaigns`・`private.signup_credit_grants`テーブルの作成、`handle_new_user()`の置き換えを確認済み。テストユーザー(`hinaran53+test1@gmail.com`)登録による実付与(`granted_count`0→1、`credits_per_user`100、`credit_transactions`への記録)も実機確認済み。当初`max_grants=10`で適用したが、その後の運用判断により本番DB上で`max_grants=100`へUPDATE済み(`credits_per_user=100`は変更なし)。現在`enabled=true`、`max_grants=100`、`credits_per_user=100`で本番稼働中。
- **旧・先着100人無料クレジットキャンペーンのロジック廃止(PR #103)**: `api/ensure-user-credits.js`から、旧「先着100人・100credits」のハードコードされたロジック(`INITIAL_FREE_CREDITS`/`INITIAL_FREE_USER_LIMIT`定数、`countInitialFreeUsers()`)を削除。上記の新マイグレーションへ移行したことに伴う重複付与ロジックの廃止で、このAPIは`credit_balances`行が欠けている場合の補完専用(常に`free_credits:0`で作成)となった。本番mainへマージ済み。
- **料金ページのFreeプラン表示調整(PR #104、#105)**: PR #104で`pricing.html`のFreeプラン`desc`から「先着100名限定」を一時削除(当時のキャンペーン`max_grants`が10だったため表示と実態が不一致だった)。その後キャンペーンの`max_grants`を100へ変更したことに伴い、PR #105で「先着100名限定」の文言を復活。いずれも表示テキストのみの変更で、価格計算・購入導線には影響なし。
- **ドメイン取得**: `pinastudio.jp`を取得済み。Whois情報公開代行のメール転送オプションを申請中で、登録完了通知はまだ受領していない。
- **サイトブランドの「FlowVid Studio」→「Pina Studio」への変更開始(PR #106、#107)**: 新ロゴ・アイコン等のブランド素材(`pina-logo-header-full.png`、`pina-icon-v1.png`、`pina-icon-v2-favicon.png`、`pina-mockup-black-wall.png`、`pina-ogp-share.png`)を`assets/brand/`ディレクトリへ配置(PR #106)。index.html、generate-prod.html、login.html、pricing.html、help.html、profile.html、legal.html、privacy.html、terms.html、content-policy.html、credits-info.htmlの計11ページのヘッダーロゴ画像・alt属性を新ロゴ(`/assets/brand/pina-logo-header-full.png`、alt="Pina Studio")へ差し替え(PR #107)。favicon・OGPタグ・本文中の「FlowVid Studio」表記・見出しの配色は今回未対応(下記「残タスク」参照)。

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

## 2026-07-19 追加分: 完了・本番適用済み

- **動画編集のトリミング・複数クリップ結合UI完成・本番反映(PR #94)**: `generate-prod.html`の動画編集タブをVLLO風タイムラインUIへ更新し、過去動画から最大6クリップを追加、同じ動画の複数回追加、クリップ単位の並べ替え・削除、各クリップの開始/終了トリミング、選択範囲再生、全クリップ通し再生、再生ヘッド連動を実装。iPhone Safari実機で操作確認済み。本番mainへマージ済み(commit `b5f1817b1761c03afb19dfe498f2a4a12acdb2d7`)、Vercel Productionは`READY`。
- **動画編集内容のリロード復元(PR #94)**: `flowvid-video-edit-vllo.js`で編集途中のクリップ情報を`localStorage`へ保存し、リロード後に過去動画一覧の読込完了後、安全確認を行って復元する仕組みを実装。クリップ数、同一動画の複数追加、並び順、各トリム範囲、選択中クリップを復元する。現在の過去動画一覧に存在しない動画は復元しない。実機で復元動作を確認済み。
- **動画編集の既存仕様を維持**: API送信形式`{clientRequestId, transition:'cut', clips:[{videoId,start,end}]}`、最大6クリップ、1クリップ最大30秒、合計最大180秒、基本10credits/条件により15credits、冪等再送、ポーリング、返金・復旧処理は変更していない。
- **今回の対象外**: 字幕・テロップ、BGM、音量調整・ミックス、トランジション、フィルター、速度変更は未実装で、今後の別工程。字幕・BGM関連の既存骨組みには触れていない。
- **未実施の最終確認**: 実際の「編集する」ボタンによる有料の完成動画生成テストはまだ行っていない。新規動画生成なし、OpenRouter実API呼び出しなし、credits消費なし、本番DB・Supabase Storage・Vercel環境変数の変更なし。

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
5. ~~新規フリーユーザー100人への100クレジット付与施策の実装状況確認(まだ着手していない)~~ **2026-07-20〜21、`private.signup_credit_campaigns`マイグレーションの実装・本番適用、`api/ensure-user-credits.js`の旧ロジック廃止(PR #103)により対応済み。** 現在`max_grants=100`、`credits_per_user=100`で本番稼働中。
6. 絵コンテ機能の残存コード(`?mode=storyboard`で開ける)の削除検討(優先度低)。
7. 動画編集の追加機能(字幕+5credits、BGM+5credits、上限25credits)は将来段階として保留中。
8. サイト内の見出し(h1)に残っている紫系グラデーションを、Pina Studioの配色(白または金の単色)へ変更。
9. favicon・OGPタグの新規設定(素材は`assets/brand/`に準備済み。HTML側の`<link rel="icon">`・OGPメタタグの設定は未着手)。
10. 本文・`<title>`タグ等に残る「FlowVid Studio」表記の洗い出しと置換(今回はヘッダーロゴの画像・alt属性のみ対応、テキスト表記は未対応)。
11. 実際の動画編集有料テストの実施・履歴反映確認(継続中の残タスク)。
12. Thorn Safer Match / Hive CSAM Detection APIへの申請検討(ドメイン`pinastudio.jp`のメールアドレス取得後)。

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
- **年齢確認の技術的な強制**: **未着手の可能性が高い、要確認**。`terms.html` はPR #124により18歳以上限定へ統一され、13〜17歳・保護者同意による利用の記載は削除済み(2026-07-28 追加分を参照)。ただし、サインアップ時に年齢条件を技術的にチェックしているコードは見つかっていません。規約に書いてあるだけで実効性がない状態の可能性がある。

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

---

## 2026-07-25 追加分: 完了・本番適用済み

- **画像由来violenceの安全な二次判定への対応(PR #114)**: 参照画像経由でviolenceのみ検出された場合に限り、該当画像を二次判定(架空アクション判定)へ渡す仕組みを追加。従来は画像由来のviolenceは二次判定を経ずに一律拒否していた。`violence/graphic`は引き続き即座に拒否。判定対象画像の確認用URLを取得できない場合や二次判定の障害・矛盾時は503で安全側停止する。回帰テスト`tests/image-violence-secondary-review.test.js`を新規追加。マージコミット`38e6427`(squash merge)。クレジット計算・DB・認証・OpenRouter送信処理への影響なし。
- **脇役・背景キャラクターの年齢判定ルール明確化**: 主人公が成人と明記されていても、敵兵士・警備員・通行人等の脇役の年齢が明記されていないだけでシーン全体が`adult_or_nonhuman_only:false`と判定され拒否される問題に対応。`api/_lib/fictional-action-classifier.js`のプロンプトへ、年齢未記載・覆面・ヘルメット姿等のみを理由に未成年扱いしないルールを追加。ただし明確な未成年指標(具体的な年齢・少年兵等)がある場合は従来どおり拒否。実在人物保護・性的暴力・重度暴力の基準は変更していない。対応する回帰テスト7件を追加。commit`0b6fb51`。
- **画像アップロード完了待ちの実装(`generate-prod.html`)**: 参照画像アップロード中に「作成する」ボタンを押せてしまい、アップロード中だった画像が生成に含まれない不具合へ対応。`uploadInProgress`/`uploadCompleted`/`uploadTotal`でアップロード状態を管理し、アップロード中はボタンを無効化して「画像アップロード中… X/Y」(枚数は選択した実数、1〜9枚まで可変)を表示。失敗時はボタンを無効のまま失敗メッセージを表示し続け、生成できないようにする。生成開始関数`start()`の先頭にも二重送信防止チェックを追加。生成APIへのペイロード内容・モデレーション処理・クレジット計算式・モデル/解像度設定は変更していない。commit`1b66786`。

### 記録の不足を今回発見・補足

- **サブスクリプション解約機能(PR #109)のフォールバック検索**: `api/cancel-subscription.js`の`findActiveSubscriptionId()`は、`user_subscriptions`テーブルでの検索を優先しつつ、`profiles.stripe_customer_id`が判明している場合は常にStripe側のサブスクリプション一覧とも突き合わせ、DBが古い・未同期の場合でもStripe側を正とする設計になっている実装をコードで確認した(2026-07-22時点でこの詳細はSTATUS.mdに未記載だった)。

### 未解決事項(2026-07-25時点)

- **続きのシーンで最終フレームが厳密固定されていない問題**: 今回のセッションでは調査・確認していません。確認できません。次回、該当機能のコードを直接確認のうえ状況を追記する必要があります。
- **`pinastudio.jp`の反映確認**: 本ファイル2026-07-23の記載では実機確認済み(SSL警告なし・トップページ正常表示)となっているが、今回のセッションでは最新の反映状況を再確認していません。
- **作業ブランチ`codex/image-violence-secondary-review`の削除待ち**: PR #114マージ後、`git push origin --delete codex/image-violence-secondary-review`を試みたがプロキシ経由でHTTP 403エラーとなり削除できず、GitHub MCPツールにもブランチ削除専用の機能がなかったため未削除のまま。手動削除、または削除方法の確認が必要。

### 参照画像モードの現状再確認(2026-07-25)

2026-07-25、参照画像モードの現状を再確認した。一時停止処理(PR #85、`api/seedance-start-priced.js`)は現在も有効で、一般利用者は引き続き503でブロックされる。実在人物なりすまし対策(Amazon Rekognition等)・CSAM専用検知(PhotoDNA、Thorn Safer等)は、コード上確認した結果、依然として未実装。2026-07-23〜25に本番DBで確認された`reference_to_video`モードの完了タスクは、すべて`TEST_BYPASS_USER_ID`(PR #99)による運営者本人のテストアカウント(`hinaran53@gmail.com`、`user_id: 0e9708d6-3c74-41e0-9cc8-944a6f6c939b`)経由のものであり、一般利用者向けの再開ではない。上記2つの検知機能が実装され本番稼働するまで、この状態を維持する。

## 2026年8月7日 作業ログ

### 完了した項目
- 新規登録へのCAPTCHA(Cloudflare Turnstile)実装。site key未設定の間は既存フローと同一動作。
- pricing.htmlに利用規約・返金ポリシーへのリンクを追加。
- 独自SMTP設定(Resend)完了。ドメイン認証(DKIM/SPF/DMARC)済み、実際のメール到達を確認済み。
- Supabase Site URL / Redirect URLsをpinastudio.jp(www統一)に更新。
- 自動ログイン退行の修正:emailRedirectToをwww.pinastudio.jp固定に変更。
- 確認メールの着地をSupabase標準リダイレクトから独自ページ(confirm-signup.html)方式に変更。ボタン押下でトークン検証しマイページへ遷移する設計。
- メールテンプレートのスペルミス(confirm-singup.html → confirm-signup.html)を修正。
- 新規登録→確認メール→マイページ到達までの一連の動作を実機で確認済み(hinaran53+brandnew001@gmail.com)。

### 判明した重要な注意点
- 同一メールアドレスで未確認のまま複数回登録すると、Supabaseは最初に生成した確認メール(古いテンプレート内容のまま)を再送する。テンプレート変更後の動作確認は、必ず未使用の新しいメールアドレスで行うこと。

### 未対応・残タスク
- ブランチfeat/signup-captcha-and-policy-links-20260804のmainへの最終マージ未実施。
- 非公開バケット化+実削除(reference-imagesバケットの公開設定、履歴削除の実体化)は未着手。
- 外部プロバイダ(OpenRouter)に残る生成済み動画の削除手段は依然として存在しない。規約・プライバシーポリシーへの開示が必要。
- reference-images内、過去に生成済みの動画・参照画像は引き続き公開URLでアクセス可能な状態。
- CAPTCHAのsite key(Cloudflare Turnstile)は未設定のまま(空文字)。

※confirm-signup.html、独自SMTP設定、Supabase Site URL変更は、feat/signup-captcha-and-policy-links-20260804ブランチには反映されていない。mainへのマージ前に、mainの最新状態(confirm-signup.html含む)とこのブランチの差分を確認する必要がある。

## 2026年8月10日 作業ログ

### 完了した項目
- 削除ボタンの実体化(api/delete-generated-video.js新規追加)。DB行・Storageファイルを実際に削除する処理に変更。削除件数を検証し、0件の場合はエラー扱いにする修正も追加。本番でDBレコード数の減少を確認済み。
- Stripe決済画面の請求元表示名を「CHANO」から「pina studio」に統一。
- 参照画像アップロードを署名付きURL方式に刷新(api/reference-image-upload-url.js, api/reference-image-confirm-upload.js新規追加)。Vercelのリクエストボディ上限(約4.5MB)を経由しない設計に変更。上限を10MB→20MBに引き上げ。reference-image-quarantineバケットのfile_size_limitも20MBへ変更済み(適用済み)。本番で24MP画像のアップロード→生成→再生まで確認済み。

### 未対応・残タスク
- CAPTCHA(Cloudflare Turnstile)のsite keyは引き続き未設定(空文字)。
- 非公開バケット化(reference-imagesの公開設定)は見送り。既存の公開URL方式のまま運用継続の判断。
- 参照画像アップロード機能は引き続きTEST_BYPASS_USER_ID限定で、一般ユーザーには503のまま無効化されている。一般公開する場合は解放が必要。
- 隔離バケット(reference-image-quarantine)の孤立オブジェクト自動クリーンアップは未実装。
- 絵コンテ機能(sbAnalyzeBtn)の画像アップロードは旧方式(base64直送)のまま。今回の直接アップロード方式への移行対象外。

## 完了: 過去動画・全履歴の件数案内表示(2026-08-19)
- 背景: ベータテスターから「過去動画が古いものから表示されなくなっている」という指摘があり、調査の結果APIの取得上限が最大50件であることが判明。上限の存在をユーザーに知らせる表示がなかったため対応。
- 対応: 生成画面「過去動画」欄・マイページ「全履歴」欄に、以下の件数案内を追加。
  - 50件未満: 「現在○件を表示中(最大50件)」
  - 50件ちょうど: 「最新50件を表示中です。これより古い動画がある場合、この一覧には表示されません。」
  - 実際に画面へ表示される件数(displayedCount)が0件の場合は案内を非表示
- API・DB・課金・認証・生成処理には変更なし(フロント3ファイルのみ: flowvid-history.js、flowvid-open-inline.js、profile.html)
- PR #173でmainへマージ、本番(pinastudio.jp)反映済み(マージコミット: 0cbd5a5)

## 完了: リファレンス/画像から動画タブの説明文追加(2026-08-19)
- 背景: 複数のベータテスターから「リファレンス」と「画像から動画」の違いがUI上でわかりにくいという指摘があった。調査の結果、内部処理(reference_urls vs first_frame_url)は明確に別だが、画面上に説明が一切なかったことが判明。
- 対応: generate-prod.htmlの各タブに説明文・ラベルを追加。
  - 「画像から動画」: 「1枚の画像を最初のフレームとして、その続きの動きを作ります」/ラベル「開始画像を選ぶ」
  - 「リファレンス」: 「最大9枚の画像から、キャラ・服・商品・背景の特徴を参考に新しい動画を作ります」+補足「参考画像と同じ構図から始まるとは限りません」/ラベル「参考画像を追加(最大9枚)」
  - 補足文言は、コード・OpenRouter仕様(input_references vs frame_images)の調査により事実確認済み
- API・DB・料金計算ロジックには変更なし(generate-prod.htmlのみ)
- PR #175でmainへマージ、本番(pinastudio.jp)反映済み(マージコミット: 2a6a7b6)

## 完了: 絵コンテタブの説明文追加(2026-08-19)
- 背景: 複数のベータテスターから「絵コンテの使い方がわからない」というフィードバックがあった。調査の結果、絵コンテタブには機能全体の説明がほぼなく、特に「2段階フロー(プロンプト作成は無料→確認して作成すると課金)」であることが伝わっていなかったことが主因と判明。
- 対応: generate-prod.htmlの絵コンテタブに以下を追加。
  - タブ先頭に3ステップの説明文(画像は1枚のみ、コマ番号を付けて左上から並べる推奨、動画生成時のみクレジット消費、等の補足付き)
  - プロンプト作成完了後、mainCardへ切り替わった直後に「まだ動画生成は始まっていません。内容を確認し、必要なら編集してから『作成する』を押してください。」の案内を追加
  - APIから返されるdetected_cuts(検出カット数)を「◯カットの絵コンテとして認識しました」として表示
- api/storyboard-prompt.js等の生成ロジック、クレジット計算、課金・認証・モデレーション処理には変更なし(generate-prod.htmlのみ)
- PR #178でmainへマージ、本番(pinastudio.jp)反映済み(マージコミット: 24d3e72)

## 完了: 新規登録フォームへのパスワード確認欄追加(2026-08-19)
- 背景: ベータテスターから「確認用にパスワード再入力があると親切」というフィードバックがあった。
- 対応: login.htmlの新規登録フォームに、パスワード確認欄(#passwordConfirmField)を追加。
  - autocomplete="new-password"を設定
  - ログインモード時は非表示・非required(生年月日欄と同じパターン)
  - モード切り替え時に値・エラー表示をクリア
  - signup送信時、パスワードと確認用が不一致ならSupabase Auth呼び出し前に「パスワードが一致しません。」とエラー表示し、送信を止める
  - 貼り付け禁止処理は追加していない(パスワードマネージャー利用者の利便性を優先)
- Supabase Auth呼び出し(signUp/signInWithPassword)、CAPTCHA処理、authMessage()には変更なし(login.htmlのみ変更)
- PR #180でmainへマージ、本番(pinastudio.jp)反映済み(マージコミット: b8671ab)

## 完了: 動画編集タブの「過去動画」欄整理(2026-08-19)
- 背景: 動画編集タブには他タブと共通の「過去動画」欄が表示されていたが、動画編集は生成方式ではないため常に空表示になっていた。既存の非表示処理(setLegacyVisibility())はDOM構造の想定が実態とズレていて機能していなかった。
- 対応: flowvid-open-inline.js・flowvid-video-edit-vllo.jsを修正。
  - 共通履歴(見出し・件数表示・履歴本体)を専用ラッパー#generationHistorySectionで囲む
  - 共有関数syncGenerationHistoryVisibility()を新設(window.flowvidSyncGenerationHistoryVisibilityとして公開)し、タブクリック時・初期復元時・履歴DOM作成直後の3タイミングすべてで呼び出す
  - 動画編集タブでは#generationHistorySectionを非表示にし、同じ位置に#veVlloHistorySection(編集済み動画)を配置
  - 他タブでは通常通り#generationHistorySectionを表示
- flowvid-history.jsの取得・絞り込み処理、api/generated-videos.js、api/video-edit-history.js、veList(編集素材選択)には変更なし
- PR #182でmainへマージ、本番(pinastudio.jp)反映済み(マージコミット: 4ad5e62)

## 完了: Seedance 2.5の1080p・WaveSpeed・参照音源対応(2026-08-21)
- Seedance 2.5の480p/720pは既存のOpenRouter経路を維持し、1080pのみWaveSpeedへ振り分ける構成を本番反映。
  - テキスト/リファレンス/絵コンテ: `bytedance/seedance-2.5/text-to-video-turbo`
  - 画像から動画: `bytedance/seedance-2.5/image-to-video-turbo`
  - WaveSpeedの`created`/`processing`は生成継続、`completed`はSupabase保存後に完了、`failed`/`cancelled`/`timeout`のみ最終失敗として扱う。
  - WaveSpeed送信前に`generation_tasks.api_provider`を`wavespeed`へ更新し、OpenRouterのreconcile対象から分離。ブラウザが閉じた場合に備え、WaveSpeed専用reconcileも追加。
- 1080pの公開記念価格を20クレジット/秒・5単位切り上げに設定(15秒300クレジット、30秒600クレジット)。480p/720pのOpenRouter料金は維持。
- Seedance 2.5・1080p・曲アップロードをPremium/Ultimate/Team/Scaleへ限定。クライアント表示だけでなく開始APIと音源アップロードAPIでも有効期限を含めて検証し、プラン照会失敗時は安全側で開始を停止。
- MP3参照音源(1曲、最大15MB)に対応。
  - 非公開Supabase Storageへ署名付きURLで直接アップロードし、生成時だけ1時間の期限付きURLをWaveSpeedの`reference_audios`へ渡す。
  - 添付解除/差し替え時の即時削除APIと、期限切れ音源を削除するCronを追加。音源を添付しただけではクレジットを消費しない旨と、動画と同じ長さに切り出したMP3を推奨する説明をUIへ追加。
- 失敗時のクレジット返金RPCをWaveSpeedでも利用可能にし、タスク行ロックと返金台帳の一意制約による冪等な1回返金を維持。完成動画のSupabase保存と既存の無料プラン透かし処理も維持。
- `WAVESPEED_API_KEY`はVercelのProduction/Previewへ設定。未設定時はSeedance 2.5の1080pだけを開始せず、720p以下には影響しない。
- 関連するUI回帰を修正。
  - 画像/音源アップロード状態は既存の小さな進捗表示へ集約し、生成ボタンは無効化中も「作成する ✦ クレジット数」を維持。
  - iPhone Safariで遅延した`seeked`イベントが履歴動画のタップ再生を停止していた処理を除去し、動画部分のタップによる再生/停止を復旧。
- 確認結果:
  - 最新`main`との統合後に`node --test tests/*.test.js`を実行し、202/202件成功。
  - JavaScript構文検査、`git diff --check`、Vercel Preview、本番配信ファイルの非課金スモーク確認が成功。
  - Previewで15秒・1080p・参照音源ありの実生成が完了し、WaveSpeed実課金は$2.835だった。
  - 未認証の生成開始/音源アップロードAPIは401、認証なしのWaveSpeed reconcile/音源削除Cronは403を確認。
- PR #184で`main`へマージし、Vercel/Railwayのデプロイ成功後に本番(pinastudio.jp)へ反映済み(マージコミット: `6a89867`)。

## 完了: 音源添付機能の同期モード追加(2026-08-21)
- 背景: Seedance 2.5の参照音源(reference_audios)機能で、音源の反映度にバラつきがあった。原因調査の結果、内部プロンプトが「歌手が歌う映像」専用の指示になっており、ダンス・アクション等リズム同期を狙う用途に対応していなかったことが判明。またWaveSpeed仕様上、参照音源は「ガイド」であり原曲の忠実な保持は保証されないことも確認。
- 対応:
  - MP3添付後に「歌唱に合わせる」(歌手向け、歌詞・メロディ・歌声を保持する指示)と「リズム・雰囲気に合わせる」(ダンス・アクション向け、ビート・強拍・展開に動き・カメラを同期させる指示)の2択を追加
  - 各選択肢にⓘ説明アイコンを追加(タップで用途の説明を表示)
  - 初期値は「歌唱に合わせる」、不正値時もこちらにフォールバック
- WaveSpeedへの送信処理本体、クレジット計算、認証・モデレーション処理には変更なし
- PR #186(2択・プロンプト分岐)、PR #187(ⓘ説明文)でmainへマージ、本番(pinastudio.jp)反映済み(最終マージコミット: 8d9ce16)
- 今後の課題: 音源のBPM・強拍を自動解析してプロンプトへ反映する改善(案B)は未着手

## 完了: 招待コード制の実装+クレジット付与条件の追加(2026-08-23)
- 背景: SNSでの一般公開に向けて、招待コード制(発行・検証・使用履歴管理)を実装。当初は登録した全員に無料クレジットが付与される仕様だったが、「招待コードを使った人だけに100クレジットを付与したい」という意図に合わせ、追加でクレジット付与条件を変更した。
- 対応1(招待コード制MVP、PR #190): private.invite_codes/invite_code_uses/invite_access_settingsテーブル、on_auth_00_invite_codeトリガー、管理画面(admin-invite-codes.html)、login.htmlへの入力欄を追加。invite_requiredはfalseのまま(必須化は別途判断)。
- 対応2(クレジット付与条件、PR #192): handle_new_user()のキャンペーン付与条件に、invite_code_usesへの存在チェックを追加。招待コードなしで登録した場合は0クレジット、招待コードありの場合のみ100クレジット付与に変更。既存の付与済み22人(招待コードなし20人含む)への遡及変更は行っていない。
- 4ケース(招待コードなし/あり/無効コード/invite_required=false時)を本番Supabaseで実機検証済み、全て想定通り。
- Supabase Auth設定、CAPTCHA、年齢確認、既存クレジット付与済みユーザーのデータには変更なし。
- PR #190(マージコミット764c7fa)、PR #192(マージコミットfa9937b)で本番反映済み。

## 確認: 一般公開前の確認メール送信設定(2026-08-23)
- 背景: SNS告知に向けて、確認メールの送信上限を確認した。標準のSupabaseメール送信機能だと1時間あたり2通という制限があり、SNS告知時のアクセス集中でボトルネックになる懸念があった。
- 確認結果: 本番Supabase(Authentication → Emails → SMTP Settings)で、既にカスタムSMTP(Resend、smtp.resend.com:465)が設定・有効化済みであることを確認した。送信元アドレスはnoreply@pinastudio.jp、Minimum interval per userは60秒。
- 結論: 標準SMTPの制限(1時間2通)は該当せず、SNS告知時の確認メール遅延リスクは低いと判断。設定変更は行っていない(既存設定の確認のみ)。

## 完了: 絵コンテからの動画プロンプト生成を汎用化(2026-08-24)
- 背景: 1枚の絵コンテ画像と任意の補足入力から生成される動画プロンプトが短く、絵コンテごとに異なる人物・動物・小道具・状態変化・結末を十分に反映できていなかった。特定の黒豹・スズメ・9コマ構成だけでなく、利用者ごとに異なる絵コンテへ対応する必要があった。
- 対応:
  - 絵コンテ画像の解析と完成プロンプト作成をClaudeの二段階処理へ変更。
  - 題材、ジャンル、画風、コマ数を固定せず、登場主体・小道具・背景・読み順・各カット・状態変化・不確実事項を構造化してから完成文を作成。
  - 検出した全コマを1コマ1区間で扱い、0秒から指定尺までの時間の空白・重複、必須見出し、最低情報量を自動検証。不備がある場合だけ修復処理を1回実行。
  - 黒豹、スズメ、おやつ袋、9コマ、アニメ調など、今回の例に固有の内容はハードコードしていない。
  - 外部通信が停止し続けないよう、Claudeへの各通信に45秒のタイムアウトを追加。通常は最大2回、構造修復時のみ最大3回呼び出す。
- 変更範囲: `api/storyboard-prompt.js`と`tests/storyboard-prompt-fidelity.test.js`のみ。絵コンテUI、通常生成、認証、課金、DB、Supabase、動画生成API、`vercel.json`は変更していない。
- 確認結果:
  - JavaScript構文検査成功。
  - 専用テスト7/7件成功。
  - 通常2回呼び出しと、構造違反時のみ3回目の修復を行うモック統合確認に成功。
  - PRの変更ファイルが2ファイルだけであること、main上の内容が検証済み内容と完全一致することを確認。
  - VercelとRailwayの本番デプロイ成功を確認。
- 未確認: Preview環境はアクセスがブロックされるため使用していない。実際の絵コンテ画像を使うClaude/OpenRouterの本番出力品質は、外部API通信を伴うため未実行。
- PR #201で`main`へSquash mergeし、本番へ反映済み(マージコミット: `493d8096`)。


## 完了: 絵コンテ生成状態・履歴分類・UI表示の修正(2026-08-24)
- 背景: 絵コンテから「作成する」を押したあと、入力初期化で生成中表示が消え、DB上のモードが`reference_to_video`のため完成動画もリファレンス履歴へ分類されていた。
- 対応:
  - 絵コンテ生成受付後も生成中カード・進捗・タスクIDを表示し、入力初期化後とリロード後も生成状態を復元。
  - `generation_tasks.settings.ui_origin = "storyboard"`を課金・外部生成前に保存し、DB上の`mode`が`reference_to_video`でもUI上は「絵コンテ」として表示。
  - 完了動画を絵コンテタブの履歴へ分類し、履歴カードへ使用モデル(Seedance 2.0 / 2.0 Fast / 2.5)を表示。
  - 失敗内容・返金状態を生成カードへ表示。生成IDがない場合は入力を消さず、二重押下も防止。
- 絵コンテの画像仕様:
  - 絵コンテ機能でアップロード・動画生成へ送信する参照画像は1枚のみ。複数画像はリファレンスタブの機能として維持。
  - 絵コンテ確定画面ではリファレンス用の「最大9枚」案内と追加画像枠を非表示。
- UI修正:
  - 不要な「動画が完成しました。下の動画から確認できます。」を削除。
  - 受付・完了カードを残す処理を絵コンテ由来タスクだけに限定し、通常のテキスト・画像・リファレンス生成を従来動作へ復元。
  - 絵コンテの確認案内・設定固定案内・受付案内の文字色を白へ統一。
- 本番データ確認:
  - 新規絵コンテタスク`bda90bd7-dd3f-4467-aea6-0aad78bd8b1b`が`ui_origin=storyboard`、`model=bytedance/seedance-2.5`、`status=completed`として保存されることを確認。
  - 修正前の既存タスク`a9dbbf0b-f91b-4fdc-8d99-a894dabc22ce`は、既存設定を保持して`ui_origin=storyboard`を追加し、絵コンテ履歴へ補正。DBスキーマ変更なし。
- 確認結果: 最終状態で全335テスト成功、失敗0件。ビルド、HTML内JavaScript構文検査、`git diff --check`も成功。
- PR #198(マージコミット`80b7179`)、PR #199(`0ea8e5d`)、PR #200(`d7ca136`)で`main`へマージ。Vercel/Railwayのデプロイ成功後、本番(pinastudio.jp)へ反映済み。

## 完了: 年額サブスクリプション期間限定10%OFFキャンペーン(2026-08-24)
- 背景: Standard/Premium/Ultimateの年額プランに、2026年9月30日23:59:59(JST)までの期間限定10%OFFキャンペーンを追加する依頼。
- 対応:
  - `api/stripe-checkout.js`: 既存の年額Price ID(`STRIPE_PRICE_*_YEARLY`)は変更せず、Stripe Coupon(`discounts:[{coupon}]`)を`STRIPE_COUPON_ANNUAL_10_OFF_202609`環境変数経由で自動適用。期間判定は固定UTCタイムスタンプ(`2026-09-30T15:00:00Z`)で行いサーバーのローカルタイムゾーンに依存しない。月額プランは無変更。
  - fail-closed設計: キャンペーン期間中にCoupon環境変数が未設定の場合、通常価格へフォールバックせずCheckout Session作成自体を拒否し503(`ANNUAL_CAMPAIGN_CONFIG_MISSING`)を返す。
  - pricing.html: クリック時点でも`isAnnualCampaignActive()`を再判定し、表示後に期間が終了していた場合は通常価格へ再描画してCheckoutを開始しない(期限跨ぎクリック対策)。
  - GET `/api/stripe-checkout`で`annualCampaignAvailable`(boolean、Coupon IDは含まない)を返し、pricing.html側の表示をサーバー側の実態と同期。
- Vercel Preview環境変数(`STRIPE_COUPON_ANNUAL_10_OFF_202609`)が繰り返し反映されないトラブルがあったが、最終的に「一度削除してSensitiveなしで再作成」することで解消(原因はVercel Dashboard側の保存状態にあり、コード側の不具合ではなかった)。
- 本番Stripe Coupon(Live mode、ID: `mmncIa5Q`、10%、期限9月30日)を作成し、Vercel Production環境変数へ設定。
- PR #205(マージコミット`d17ce97`)で`main`へマージ、本番(pinastudio.jp)へ反映済み。

## 完了: Teamプランの誤購入防止と年額表示修正(2026-08-24)
- 背景: Teamプラン(¥298,000/月)は「準備中」ラベル表示だったが、実際にはボタンのdisabled属性・クリックガードが一切なく、ボタンを押すと実際にStripe Checkoutが開始されてしまう不具合が発覚(Codex調査により発見)。また年額タブを選んでもTeamだけ月額表示(¥298,000/月)のまま切り替わらない別の不具合もあった。
- 対応(PR #206): `pricing.html`に`isPurchaseDisabledPlan(p)`を追加しTeamボタンへdisabled属性・aria-disabled・クリックガードの二重無効化を実装。`api/stripe-checkout.js`の月額分岐にも`id==='team'`を拒否するサーバー側ガードを追加(`STRIPE_PRICE_TEAM_MONTHLY`未設定時の動的price_dataフォールバックを禁止)。
- 対応(PR #207): 年額タブでTeamが月額表示のまま残る原因(`renderPlans()`の年額分岐に「p.annualを持たないプラン」向けの分岐がなく月額用表示へ落ちていた)を特定し、「年額プランは準備中」の専用表示へ変更。
- PR #206(マージコミット`76721e7`)、PR #207(マージコミット`e018cfe`)で`main`へマージ、本番反映済み。

## 完了: Teamプランを月額・年額とも購入可能に変更(2026-08-25)
- 背景: Teamプラン(月額¥298,000/90,000credits)を「大容量クレジットを使いたい個人向けプラン」として正式に購入可能にする依頼。複数アカウント・共有クレジット・共有アセット・チーム管理は未実装のため宣伝しない方針。
- 対応(`api/stripe-checkout.js`):
  - `SUBSCRIPTION_PLANS_ANNUAL`にteamを追加(年額¥3,576,000、`monthly_credits:90000`、`env:'STRIPE_PRICE_TEAM_YEARLY'`)。年間合計1,080,000クレジットは毎月90,000ずつ既存Cronで付与し、12か月分の一括付与は行わない。
  - 月額・年額それぞれにあった`id==='team'`の拒否ガードを削除。既存の`buildAnnualSubscriptionSessionParams`をそのまま使うため、Team年額にも年額10%OFFキャンペーンCoupon(`STRIPE_COUPON_ANNUAL_10_OFF_202609`)が自動適用され、fail-closed(Coupon未設定時503)も同様に効く。Production環境でPrice ID未設定時に動的price_dataへフォールバックしない既存の安全設計は無変更。
- 対応(`pricing.html`):
  - Teamに`annual:'3,576,000'`/`campaignAnnual:'3,218,400'`/`annualCredits:'1,080,000'`を追加。既存の年額表示分岐(Standard/Premium/Ultimateと共通)にそのまま乗せた。
  - ボタンラベルを「準備中」→「Teamにする」に変更。`isPurchaseDisabledPlan(p)`をハードコード判定から`p.purchaseDisabled`フラグ方式に変更し、Teamにはフラグを立てず購入可能にした。`.team .btn`の旧グレー配色を削除し、新色は追加せずFreeと同じ既存のbase `.btn`スタイルを流用。
  - Teamのfeaturesから未実装4項目(複数アカウント/共有クレジット/共有アセット/チーム管理)を削除。
- Codexレビューで2回の指摘(APIテストのモック強化、年額テストの日時依存排除)を受け対応済み。テストはStripe SDK/Supabaseをrequire.cache注入でモックし、実Stripe・実Supabaseへ一切通信せずにCheckout Sessionパラメータ(line_items・metadata・discounts)を実行ベースで検証。
- マージ前に外部設定(Vercel Production環境変数`STRIPE_PRICE_TEAM_MONTHLY`/`STRIPE_PRICE_TEAM_YEARLY`、Stripe LiveのTeam月額・年額Price、Coupon`STRIPE_COUPON_ANNUAL_10_OFF_202609`のTeam商品への適用有無)をユーザー側で確認済み(確認日2026-08-25)。
- マージ後の本番確認:
  - Vercel Production最新デプロイ(`dpl_83VL8cJnU28V64tH1QbKao7fm5Kq`)が`READY`であることを確認。
  - `pinastudio.jp/pricing.html`の配信内容(`plans`配列)で、Team月額¥298,000・年額通常¥3,576,000・年額10%OFF後¥3,218,400・ボタンラベル「Teamにする」(disabled属性なし)を確認。
  - GET `/api/stripe-checkout`が`annualCampaignAvailable:true`を返すことを確認(サーバー側でキャンペーンCouponが有効であることの傍証)。
  - 2026-08-25、上記GET `/api/stripe-checkout`の`annualCampaignAvailable:true`を再確認(キャッシュMISS)。
  - **未確認(実ユーザーCheckout画面)**: 実際に認証済みユーザーとしてTeamボタンをクリックし`POST /api/stripe-checkout`がCheckout Session作成まで到達し、Stripe Checkout画面(月額¥298,000・年額通常¥3,576,000・年額10%OFF後¥3,218,400)が実際に開くことは、実ユーザーのログイン認証情報が必要なため確認できていない。私(Claude)は実ユーザーの認証情報を持たず、確認のためだけに新規実アカウントを作成する対応も、ユーザーへ確認のうえ「コード・GETレスポンスの範囲に留める」方針を選択したため実施していない。
  - 確認済みの範囲: pricing.html配信内容(`plans`配列の金額・ボタン状態)とGET `/api/stripe-checkout`のサーバー応答、およびローカル自動テスト(Stripe SDK/Supabaseをモックした実行ベーステスト。Team月額・年額とも正しいPrice ID・metadata・Couponで`stripe.checkout.sessions.create`が呼ばれることを検証済み)。POSTでの実際のCheckout Session作成・Checkout画面表示そのものは本番環境では未検証。
- テスト: 全382件中380件成功。残り2件(`tests/generation-control.test.js`、`api/storyboard-prompt.js`関連)は本変更と無関係の既存事象。
- Supabase schema・migration、`api/stripe-webhook.js`のクレジット付与仕様、Cronの毎月付与仕様、Standard/Premium/Ultimate/Freeの価格・credits・Checkout、キャンペーン期限には変更なし。
- PR #208(マージコミット`8ba1c8a`)で`main`へマージ、本番(pinastudio.jp)へ反映済み。

## 対応: Teamの表示名変更・購入ボタン統一・年額Checkout復旧(2026-08-25)
- 完了した表示修正:
  - 料金画面上のTeam表示名だけを「Creator Pro」へ変更。内部プランID`team`、Stripe商品名、DB・Webhook・credits・価格は変更していない。
  - Standard/Premium/Ultimate/Creator Proの購入ボタンを「購入する」に統一。Freeの「無料で試す」は維持。
  - 表示名変更後もCreator Proの月額・年額クリックが内部ID`team`と正しい`interval`を送ることをテストで確認。
- 年額Checkout調査:
  - Creator Pro年額だけ本番で「決済の開始に失敗しました」となる事象を確認。
  - コード上は他の年額プランと共通経路で、モックテストでは`STRIPE_PRICE_TEAM_YEARLY`と年額10%OFF Couponを指定してCheckout Session作成まで成功。
  - Stripe Workbenchの失敗ログ(2026-08-25 22:59:00 UTC、request ID `req_3JrmbyQm3aowm4`)で原因を確定。Checkoutへ送られたPrice IDが`price_1U8DxZLdBCVYotQeRS3lsh`で、Stripe上の正しいTeam年額Price ID`price_1U8DxZLdBCVYotQeRS3lshfK`より末尾`fK`が欠けていたため、`resource_missing`(HTTP 400)になっていた。
  - 原因はVercel環境変数`STRIPE_PRICE_TEAM_YEARLY`の値の入力不足。CouponやCheckoutコードの不具合ではないため、決済API・価格・割引処理は変更していない。
  - VercelのProduction/Previewにある`STRIPE_PRICE_TEAM_YEARLY`を完全なPrice IDへ修正し、Productionを再デプロイ。
  - 本番でCreator Pro年額Checkoutが正常に開き、初年度¥3,218,400、翌年以降¥3,576,000/年と表示されることを確認。実購入は行っていない。
- テスト結果:
  - 対象テスト45/45件成功。
  - 全体383件中381件成功。失敗2件は既知の`tests/generation-control.test.js`(`api/storyboard-prompt.js`関連)で今回の変更対象外。

## 対応: 料金ページからFreeプランカードを削除(2026-08-26)
- `pricing.html`のFreeプラン定義を削除し、月額・年額のどちらのタブにもFreeカードを表示しないように変更。
- Standard/Premium/Ultimate/Creator Proの価格・credits・購入ボタン・Checkout処理は変更していない。
- 無料登録や動画生成側の機能は変更しておらず、料金ページ上のFreeカード表示だけを削除。
- 対象テスト46/46件成功。全体384件中382件成功。失敗2件は既知の`tests/generation-control.test.js`(`api/storyboard-prompt.js`関連)で今回の変更対象外。

## 対応: Seedance 2.5・720p生成のcompleted-no-url-timeout事象と、720pのWaveSpeed振り分け(2026-08-27〜28)
- 事象: 2026年8月27〜28日、Seedance 2.5・720p生成が2件、生成完了後に動画URLが取得できず`completed-no-url-timeout`で失敗した(Supabase `generation_tasks`テーブルで実測確認、タスクID`1d413dd7-e4de-4625-8b0a-a11b9719480e`・`be16fef0-bf5c-4287-b6c3-46abb898d571`、いずれも同一ユーザー)。ユーザーへは550クレジット×2を自動返金済みであることを`credit_transactions`テーブルで実測確認済み。
- OpenRouterへの実費$13.88については、ユーザー側から回収不可と判断・確定した旨の報告を受けたが、Claude Code側ではOpenRouterの請求画面・APIを直接確認できていないため、この金額自体は確認できません。
- 原因: 2026年8月21日のcommit(Seedance 2.5・1080pのWaveSpeed対応、PR #184)で、`api/_lib/seedance-start.js`のprovider振り分け条件が`model === 'bytedance/seedance-2.5' && resolution === '1080p'`のままだったため、720p・480pは引き続きOpenRouterへ送られる設定になっていた。
- 対応(PR #213、2026-08-28):
  - `api/_lib/seedance-start.js`のprovider振り分け条件を`resolution === '1080p' || resolution === '720p'`に変更し、Seedance 2.5・720pをWaveSpeedへ送るようにした。
  - 参照音源ガードの判定基準を`provider === 'wavespeed'`から`resolution === '1080p'`へ変更し、振り分け変更に伴う参照音源対象の意図しない拡大(720pでも通ってしまう状態)を防止。既存仕様(1080p限定)を維持。
  - `generate-prod.html`で、Seedance 2.5選択時に解像度セレクトの480pを非活性・非表示化(WaveSpeed Turboモデルが480p非対応のため)。バックエンドの480p(OpenRouter)経路自体は変更していない。
  - 全384件中337件成功、失敗6件は本変更前から存在する既知の失敗で変更前後同一であることを確認済み。実際の動画生成・追加課金は行っていない。
  - 2026-08-28、`main`へマージ(マージコミット`b4d4abab500be2254e4688e0538925a7374ee99a`)、Vercel Production Deployment(`dpl_BFxmQcnE96z33XsgVhS68nwLNSVQ`)が`READY`であることを確認済み。GitHub main上のファイル内容を直接取得し、振り分け条件が意図通りであることをコードそのもので確認済み。
- 再発監視(PR #214、2026-08-28): `docs/operations/DAILY-OPERATIONS-CHECKLIST.md`の「2. 管理画面」セクションに、`completed-no-url-timeout`再発確認用のチェック項目とSupabase確認用SQL、`api_provider`列による新旧事象の見分け方を追記。マージコミット`e87b3f3294bfc761e634d490cf3eccfac12a801b`。
  - 追記後、過去7日分のデータで再確認したところ、該当するのは上記の既存2件(いずれも`api_provider = 'openrouter'`、PR #213適用前に発生)のみで、適用後の新規発生は確認できなかった(2026-08-28時点)。
- 未対応・今後の検討事項: クレジット返金とAPI課金(OpenRouter・WaveSpeed等)のズレを自動検知する仕組み(いわゆる「火災報知器」的な監視)は、現時点で確認できる範囲では作られていない。
