# API提供元残高一覧 — ローカル再構成 2026-11-06

基準: main 4a57955b6065b5b8f0e31363b3302efdfb63a37b。
旧Library ZIPは存在確認済みだが正規転送が通信失敗。旧パッチ復元ではなく、親が確認した仕様から独立再構成した版。
原本 /workspace/seedance-black-studio は変更していない。本候補は /workspace/pina-provider-balances-20261106。

## 変更と正常系への影響
- admin.html: 経営状況リンクの直後にAPI残高リンク1行だけ追加。既存モデレーションや運営操作は不変。
- admin-provider-balances.html / .js: 新しい閲覧ページ。Supabase既存セッション→新API→カード表示。認可判断はサーバーが担当。ログアウト/アカウント変更で値消去、遅延応答をepochで破棄。pagehide消去、BFCache復帰で再確認。
- api/admin-provider-balances.js: GETだけ。既存requireConfirmedAuth→設定ADMIN_EMAILとの一致→profilesの本人ID/email/admin一致を毎回検証後、キャッシュ参照。ADMIN_EMAIL未設定は拒否。既存APIにあるハードコードメールfallbackは新APIに導入しない。
- WaveSpeed WAVESPEED_API_KEY、fal FAL_KEY（既存fallback FAL_API_KEY）をサーバー内のみで利用。固定2URL、GET、redirect:error、5秒timeout、16KiB上限。取得は今回モックのみ。
- OpenRouter/OpenAIは公式画面リンクのみ。提供元アカウント名、キー、レスポンス原文、例外本文は返却/ログ出力しない。
- 30秒キャッシュは成功/失敗双方。同時取得Promise共有。userID/キーの指紋が異なれば再取得。古いin-flight結果は新しいキャッシュを上書きしない。
- 未取得/未設定/失敗はnull、実ゼロは0。最後の成功値は失敗時staleで保持。画面上の成功値も30秒を過ぎれば古い値表示。金額は通貨別、合算しない。
- 残高<=0は警告。正の低残高の閾値はモデル原価等の根拠が未確定なので設定しない。生成前ブロック、チャージ、返金、決済、クレジット操作は一切追加しない。
- 画面は320px 1列、390/768px 2列、1280px 3列。日時/影響モデル/公式チャージ先はdetails内。Vercel/Supabase/Railwayは前払残高カードと分離。

## 今回実行した確認
- node --test tests/admin-provider-balances.test.js tests/admin-finance.test.js tests/admin-operating-costs.test.js: 98/98成功（新API28 + 既存70）。
- node tests/browser/provider-balances-local.cjs: 10/10成功。上記4幅、横はみ出しなし、details Enter開閉、ゼロ/stale/unknown、ログアウト、遅延応答破棄、別アカウント403、取得値の経時表示、連打抑制。外部通信はすべてroute mock/abort、unexpectedExternalRequests=[]。
- node --check: 新API/JS成功。
- npm run build: 成功。認証設定に架空のテスト値を明示指定、出力HTML/JSとソースのバイト一致確認。本番API呼出しなし。
- 自己レビュー: UI以外にサーバー認可あり、認証毎回、元admin差分1行、固定URL/エラー/キャッシュ分離確認。独立エージェントレビューは今回は未実施。

## 未検証・公開前の条件
- 本番のADMIN_EMAIL設定存在/一致、fal billing:usage:read権限、キーの所属、実残高GET成功は未確認。鍵の取得/追加/権限変更はしない。
- fal権限不足はaccess_unavailableとし、正常/0にしない。現行inferenceキーで取得できるとは保証しない。
- キャッシュ/同時取得抑制は1インスタンス内のみ。コールドスタート/複数インスタンスを通じた全体rate limitや永続last-successはない。大量並列リクエスト全体の厳密な上限が必要なら既存集中制御の有無を別途確認する。本候補のためDB/Redis等を新設していない。
- 実iOS、実Auth、保護付きPreview、本番は未検証。実provider GETの費用・rate limitも保証しない。
- 生成機能・課金・SQL・既存残高・認証設定・モデレーションは変更なし。自動残高不足ブロックを実装済みとしない。
- 公開時は最新main再確認→独立差分レビュー→モック/関連テスト→保護付きPreview。共有Previewが本番認証を向く場合は未承認の実ログイン/実APIテストを行わない。
- rollbackはこの差分だけrevert。DB/キー/残高の巻戻しは不要。旧全体ZIPの他機能パッチと一括適用しない。

## 公式資料照合（2026-11-06、公表仕様のみ）
- https://wavespeed.ai/docs/check-balance : GET /api/v3/balance、USD、code200/data.balance。
- https://fal.ai/docs/platform-apis/v1/account/billing : expand=credits、Key認証、credits.current_balance/currency、billing:usage:read。
- https://supabase.com/docs/reference/javascript/auth-onauthstatechange : 既存セッションイベントを利用。新Auth仕様/DB変更なし。
- Supabase changelog.mdの取得は閲覧ツールがtext/markdownを扱えず未確認。認証ライブラリ更新なし。

## 独立レビュー後の補強（2026-11-06）
- 製品コードは変更なし。テスト2ファイルとこの記録のみ追加更新。
- 認証mockが未確認メール403/認証障害503を返す各ケースについて、初回・成功キャッシュ保持後の計4件追加。失敗時にはprofiles読取もprovider呼出しも増えず、キャッシュ残高を返さない。
- 画面5ケース追加: persisted pagehide/pageshowを明示発火し、旧表示消去→session再取得→新結果表示、ログアウト、別アカウント、サーバー403を確認。さらにChromiumの実履歴back/forward/back操作で再取得と権限失効後の非表示を確認。
- 関連nodeテスト最終102/102成功、新APIは32件。画面最終15/15成功、unexpectedExternalRequests=[]。旧98/10と合算しない。
- BFCache persistedイベント試験は模擬。実履歴操作はChromiumで実施したが、BFCacheへの実格納やiOS/Safariの動作を証明しない。実Supabase Authは未接続。既存requireConfirmedAuth内部を丸ごと結合した試験ではない。
- ビルドは製品コード不変の前回成功を保持、今回再実行していない。
- 原本・旧パッチは保持。最終候補はadmin-provider-balances-v2.patchへ別名保存。v1とv2を重ねて適用しない。
