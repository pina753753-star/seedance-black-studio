# Pina ChatGPT接続：ローカル公開候補と承認対象

2026-10-26。基準main `45a03f899f4cf0a37b082cc6bf55cc7bd853c6c9`、作業branch `local/chatgpt-mcp-main45a03f`。未commit/push/公開。過去のSupabase OAuth直結案・SQLite配置案に代わる現行資料。

## 完成したローカル経路

既存Pina本人確認 → first-party専用短命cookie → broker同意 → opaque token → SDK MCP → 既存料金の署名見積 → 本人UIでCSRF/予算/設定確認 → Postgres単回claim → 共有した既存生成API本体 → 既存予約・控除SQL → 状態/保存/透かし/返還 → 本人成果物。

Supabase access/refreshをChatGPTへ渡さない。first-party cookieには短命accessのみ暗号化して保持し、本人UIの各requestで既存requireConfirmedAuthを再実行する。refreshはコピーしない。brokerは別issuerでopaque access/refreshを発行する。Supabase OAuthは無効のまま、既存hook/署名鍵に変更なし。

実Auth応答・外部生成/保存/workerはmock。broker、CSRF、署名見積、SDK、Postgres broker保存、既存予約/控除/返還RPCは実処理。テスト用DBはDocker network=none、host portなし。通常サイトの認証を経由する既定handlerは維持し、内部MCP handlerだけWeakMapで本人を渡す。HTTP header/bodyからこの本人情報を作れない。

## 正確なコード対象

既存変更：`api/_lib/seedance-start.js`、`api/seedance-start-priced.js`、`api/seedance-status.js`（認証後本体を共有するfactory抽出のみ）、`package.json`、`vercel.json`。

新規入口：`api/mcp.js`、`mcp-session.html`、`mcp-session.js`、`package-lock.json`。

新規runtime：`local-mcp/release-app.mjs`、`broker.mjs`、`broker-postgres.mjs`、`broker-interaction.mjs`、`browser-session.js`、`principal-backend.js`、`existing-api-backend.js`、`core.js`、`quote-integrity.js`、`postgres-store.js`、`approval-ui.js`、`sdk-transport.js`。

依存：`oidc-provider=9.13.0`、`@modelcontextprotocol/server=2.4.0`。root lock固定。SQLite adapter・旧JWT adapter・mock fixtureはローカル検証用で、release-appはそれらを使わない。生成料金・プラン・Stripe/worker設定を変更しない。

## SQL対象（未適用）

`local-mcp/release/migration.sql`を1transactionで適用する案。既存本番read-only metadata確認では`pina_mcp`なし、public RPC名衝突0。

- 新schema `pina_mcp`。
- 新table `proposals`, `requests`, `broker_state`, `revoked_grants`。RLS有効。PUBLIC/anon/authenticated/service_roleのprivate直接権限は剥奪。
- private関数 `pina_mcp.dispatch(text,jsonb)`、`pina_mcp.oauth_store(text,jsonb)`。
- public関数 `public.pina_mcp_dispatch(text,jsonb)`、`public.pina_mcp_oauth_store(text,jsonb)`。固定search_pathのSECURITY DEFINER、EXECUTEはservice_roleだけ。migrationは既存のDB管理ownerで実行する前提。
- 既存のcredit_balances/credit_transactions/generation_tasks/Stripe台帳定義とデータは変更しない。通常の生成が後日承認されて実行されたときだけ既存RPCが通常どおり更新する。
- brokerはgrant→stateの順でlock、失効tombstoneを保持。新generation台帳はowner→proposal→requestの順。外部API呼出前にclaimをcommitし、不明結果を自動再送しない。

## 環境変数と登録

新規server-only値（未生成・未設定）：

|名前|内容|
|---|---|
|PINA_MCP_QUOTE_SECRET|32-byte base64、見積HMAC|
|PINA_MCP_CSRF_SECRET|32-byte base64、同意/生成承認CSRF|
|PINA_MCP_BROWSER_KEY|32-byte base64、first-party短命cookie暗号化|
|PINA_MCP_OAUTH_STORAGE_KEY|32-byte base64、broker保存payload暗号化|
|PINA_MCP_OAUTH_COOKIE_KEY|32-byte base64、broker cookie署名|
|PINA_MCP_OAUTH_JWKS|broker独立のprivate JWKS。Supabaseの鍵を再利用しない|

保管先は既存Vercel `flowvid-studio` のserver-only環境変数。Previewには別のテスト材料を用いる。NEXT_PUBLIC/HTML/ログ/ChatGPT/提出ZIPに秘密値を入れない。既存Supabase/provider/Stripeキーは再発行・移動しない。

非秘密設定：`PINA_MCP_ORIGIN=https://www.pinastudio.jp`、`PINA_MCP_CLIENT_ID`（固定public client1件）、`PINA_MCP_REDIRECT_URI`（ChatGPT管理画面の完全一致callback）、`PINA_MCP_ARTIFACT_HOSTS`（既存成果物保存hostだけのJSON配列）。`PINA_MCP_ENABLED`は未設定/falseで入口停止、`PINA_MCP_ALLOW_GENERATION`は未設定/falseでclaim/控除前に開始拒否。最初の公開確認では後者falseを維持。

public clientはbrokerの設定に登録。Supabase側でOAuth client登録しない。DCRなし、client secret不要、PKCE S256必須。callbackは実管理画面から取得し、推測・wildcard登録しない。書込みscopeは既存本人UI承認を省略するものではない。

## 公開route案と配置確認

- MCP `https://www.pinastudio.jp/api/mcp`
- 独立issuer `https://www.pinastudio.jp/mcp/oauth`
- authorize `/mcp/oauth/auth`、token `/mcp/oauth/token`、revocation `/mcp/oauth/token/revocation`
- metadata `/.well-known/oauth-authorization-server/mcp/oauth` と `/.well-known/oauth-protected-resource`（`/api/mcp` suffixも対応）
- broker同意 `/interaction/{uid}`、本人確認入口 `/mcp-session.html`、cookie設定POST `/mcp/browser-session`、生成承認 `/mcp/approve`

既存Vercel project `prj_vuiMAkfC0shY9waPwKUvUiABVcwH`、Node24.x/Preview-only protectionをread確認。新サービス不要。ただし同一app deploymentを更新するため、既存Webも対象になる。

Vercelのrewrite後のoriginal path/host、Node requestのraw body、保護Previewの認証、実ブラウザのcookie・復帰はローカルUnix socket試験では証明できない。**公開前の非課金配置ゲート**として確認する。保護PreviewをChatGPTから秘密の迂回URLで開放しない。通常Web回帰も確認し、問題があればpromoteしない。

## 一括承認後の最小順序案

1. 最新mainとの差を再確認しPR作成・保護Previewへ保存。入口はdefault off。既存Webの回帰、route/Node/raw bodyを非課金確認。
2. 新schema/2 RPCのmigration適用、権限readback。新規broker材料を設定、callbackを完全一致で登録。
3. production自動割当を一時停止して元値記録、PR統合→staged build→既存Web確認→明示promote。Preview保護は維持。設定復元は従来runbookどおり確認後。
4. `PINA_MCP_ENABLED=true`、`PINA_MCP_ALLOW_GENERATION=false`のpilotで、実Pina本人認可・残高・見積・承認UI・拒否・失効を確認。MCP/通常tokenの相互拒否を実環境で非課金確認。進行中taskのpollは副作用があり得るため行わない。
5. 実生成のE2E予算と生成有効化は別承認。Directory提出/審査アカウント作成/Publish/iOS実機も未実施。個人custom接続だけで一般公開完成とはしない。

現在はこの順序の実行承認をまだ受けていない。入口の開放・新秘密値・SQL・client登録・pushのいずれも行っていない。

## データ共有・復帰

ChatGPTとの共有：broker認可情報、生成入力/設定、見積/残高/透かし条件、承認URL、状態、成果物URL。対話全文や通常Pinaログインsessionを渡さない。成果物URLは取得後に共有可能な場合があり、DRMや会話からの自動削除を約束しない。公開privacy追記案は提出草案にある。ChatGPT内でcredits販売・checkout・購入ページ直接誘導を行わない。

復帰は入口/開始停止→broker grant/token失効→必要なら旧deploymentへ戻す。新規schemaと未確定requestは保持し、既存進行taskは従来Web/status/reconcileで処理する。既存残高・返還・台帳を巻き戻さない。private RPCのEXECUTE取消は受付停止後に行う。SQL schema削除は未確定task解消・監査保管判断後であり自動実行しない。

## 検証記録

全ローカル70件成功。SQL権限強化後のrelease8件は別記の最終ログ参照。既存API回帰95/97、2失敗はstoryboardの静的marker判定で、変更前HEADでも同じ2件を再現。料金表示175別修正やdocsPRは混ぜていない。

証拠：`/workspace/pina-deliverables/mcp-release-final-tests.txt`、`mcp-release-final-sql-tests.txt`、`mcp-release-independent-final.txt`、`mcp-existing-api-regression.txt`、`mcp-baseline-generation-control.txt`。実決済・有料生成・実ChatGPT接続・Hosted拒否試験は未実施。
