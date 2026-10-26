# Pina 公開提出草案 — 未提出・接続不可

2026-10-26。公式形式に沿うローカル草案であり、提出可能な完成ZIPではない。実在しないclient IDのplaceholderを含む。自動登録・接続・公開スクリプトは付けない。

`plugin.json` は表示文とpositive 5 / negative 3の計画、`mcp.json` はpublic client/PKCE向け設定案。reviewケースは実サービスで未実行。審査通過や収益の保証をしない。

未記入：検証済publisher名、support URL、公開案内専用ページURL、privacy/terms URLの最終確認、配布国、正当なlogo/screenshots、walkthrough、専用審査アカウントとサンプル。実アカウントを審査資格情報にしない。専用アカウント作成・生成予算・提出は未承認。秘密値はZIPに含めない。

## 実施計画

5正常例はmanifestの順で同一専用ownerの一連の体験を検証する。P1/P2は控除ゼロ、P3は署名・所有者・期限・予算の一致と一度だけの控除、P4は既存処理のみ、P5は生成時透かし条件を確認する。P3の実生成は別途予算承認が必要。現状はローカルmockのみ。

3拒否例は各記載の攻撃を個別に実行する。N1はCSRF・Origin・他owner・設定改変・期限・予算、N2は残高不足/権限不足/購入要求/エラーの各応答、N3は別owner取得・timeout・再起動・同時開始・新request IDを含む。N2ではtool本文/structuredContent/承認UI/認可UI/メタデータ/リンク先を検査し、checkoutリンクや購入開始ページへの誘導、upgrade勧誘がないことを確認する。生成promptに含まれるユーザー入力は販売案内のシステム出力と区別する。

DesktopとiOSで同じ8例を確認し、外部本人承認ページからChatGPTへの復帰・成果物表示も検証する。現在はChatGPT実機/審査実行とも未実施。ローカルの拒否テスト成功をその代わりにしない。

## 旧Supabase直結案からの更新

最新版は `../chatgpt-release-approval.md`。別issuerのbrokerへ移行し、Supabase OAuthは有効化しない。manifestのscopeはbroker専用scope。以下は旧案を採用しない理由として保持する。

## 旧案の必須未完了

実Supabase OAuth JWTの専用audience/role、固定client、session/consent/grant失効確認、通常API/DB/Storage/Authへの直接使用拒否は未実装・未検証。現行local mockのカスタムscopeを実Supabaseへ登録できない。metadataはopenidへ、内部capabilityはDB grantへ分離する必要がある。通常Pina tokenへの交換/コピーはしない。これが閉じるまで生成toolを公開しない。

## プライバシー差分案（公開HTML未変更）

現行privacy.htmlのOpenAI説明は安全確認・moderationが中心。公開前に次の用途を追記する案：

「ChatGPT連携を許可した場合、連携専用の認可情報、残高、指定した生成入力・設定、見積、承認・生成状態、成果物URLをChatGPTとの間で送受信します。Pinaのパスワードや通常ログイン用セッションはChatGPTへ渡しません。認可トークンにはアカウント識別情報や標準claimsが含まれる場合があります。生成入力は既存の生成・安全確認・保存処理でも利用されます。成果物URLが会話に残り、共有されたURLから閲覧できる場合があります。接続解除だけで既存会話・生成履歴・成果物がすべて削除されるものではありません。」

同意/提案/実行台帳は重複生成防止・障害調査のため保持する。正確な保持期間・削除運用・OpenAI側の取扱いへの参照は実運用確定後に追記し、未実装の削除機能を約束しない。一般Web購入機能は変更しない。

公式根拠（形式は現行例に照合、オンラインschema validator/提出scanは未実施）：
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/plugin-guidelines

今回の影響：docs追加とローカル契約テスト追加のみ。通常Web→既存認証→料金/控除→provider→保存/返還のproduction経路は変更しない。
