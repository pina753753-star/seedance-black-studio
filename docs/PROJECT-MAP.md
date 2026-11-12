# Pina Studio 資料マップ

入口は [CLAUDE.md](../CLAUDE.md)。本書は所在・責任を整理する目次であり、承認条件やアクセス権限を追加・変更しない。2026-10-25にmain ec9190fを基準として整理し、本番反映後のmain 15896a45へ文書差分のみ載せ直した。その後のPR #259 / 本番main 45a03f8の状態を文書だけ更新。draft PR #258はmain未統合で、最新本番コードはこの文書ブランチへ取り込んでいない。

## 最初に読む順序

1. [CLAUDE.md](../CLAUDE.md)、Codexでは [AGENTS.md](../AGENTS.md)、[マスタールール](../ai-rules/00_master_rule.md)で既存制約を確認。
2. [STATUS.mdの最新節](../STATUS.md)で確定仕様、対象環境、未公開・未適用を確認。
3. 作業内容に応じて下表の原本へ進む。仕様を変える提案と、その実装・公開を別々に記録する。

## 所在と更新責任

| 内容 | 原本・入口 | 更新する内容／重複させない内容 |
|---|---|---|
| サービス概要（profile相当） | [README](../README.md) | 名称、コード構成、ローカル実行。最新の公開完了判定はSTATUSへ |
| 方針・優先順位（strategy相当） | [OPERATIONS-ROADMAP](../OPERATIONS-ROADMAP.md) | 確定方針と長期課題。提案は確定仕様と別記 |
| 現状・証拠・学び（learn相当） | [STATUS](../STATUS.md) | 日付・SHA・環境・検証範囲・未完・再発防止。過去履歴を消さない |
| 業務領域・実装（domain相当） | README、[データ一覧](../DATA-INVENTORY.md)、下記運用手順、対象コード | DBや料金を文章から推定変更しない。モデル能力は `api/_lib/video-models.js`、価格は `api/_lib/video-pricing.js`、実装ブランチを確認 |
| 禁止・作業規約（ng-rules相当） | CLAUDE / AGENTS / [ai-rules](../ai-rules/00_master_rule.md) | 既存安全制約・承認手順。目次整備を理由に緩和しない |
| 参照資料（references相当） | 本書、STATUSの証拠、[運営資産台帳](operations/SERVICE-ASSET-REGISTER.md) | 資料・サービスの所在。秘密値・セッション・署名URLを載せない |
| 専門作業手順 | [PR workflow](../.claude/skills/pr-workflow/SKILL.md)、[help-center workflow](../.claude/skills/help-center-workflow/SKILL.md) | 作業別のチェック。共通規約の代替ではない |

7つの新ファイルへ機械的に分割せず、既存原本を使う。更新者は担当作業者とし、完了記録には対象環境・確認方法・残件を書く。独立レビューが必要な作業は既存ルールに従う。

## 運用・サービス／ドメイン資料

- [SERVICE-ASSET-REGISTER](operations/SERVICE-ASSET-REGISTER.md)：サービス・運営資産の台帳。ライブ設定の保証ではなく、変更時は正規管理画面の対象と照合する。
- [DATA-INVENTORY](../DATA-INVENTORY.md)：保存・送信データと削除時の確認先。全providerの最新網羅性は本整理で再監査していない。
- [日次運営](operations/DAILY-OPERATIONS-CHECKLIST.md)、[障害対応](operations/INCIDENT-RESPONSE-PROCEDURE.md)、[決済・返金](operations/PAYMENT-REFUND-PROCEDURE.md)。
- [アカウント削除](operations/ACCOUNT-DELETION-PROCEDURE.md)、[コンテンツ通報](operations/CONTENT-REPORT-PROCEDURE.md)。
- [参照画像安全設計](operations/REFERENCE-IMAGE-SAFETY-DESIGN.md)、[ベンダー比較](operations/REFERENCE-IMAGE-SAFETY-VENDOR-INQUIRY.md)。設計済みを契約・実装・運用済みとは扱わない。

## 単体購入リリース資料（main統合済み）

次は候補5f804で準備され、PR #257 / main 15896a45へ統合済みの原本。23:54 UTCの本番promote・SQL適用完了は親の確認報告に基づきSTATUSへ記録した。文書内の「未commit」「未実行」は作成時点の履歴であり、最新状態はSTATUSを読む。履歴の原本を完了済みのように書き換えない。

- [統合候補の範囲・検証](integrated-release-candidate.md)
- [基本モデルのリリース手順](basic-models-release-runbook.md)
- [本番メタデータ・反映計画](production-metadata-and-release-plan.md)
- [単体購入のローカル設計・検証](standalone-basic-models-local.md)
- [SQL原本](sql/basic-credit-access-atomic.sql) / [rollback原本](sql/basic-credit-access-rollback.sql)、[ローカルSQL検証](../tests/postgres/README.md)。読むことと実環境へ適用・rollbackすることは別。新しい実行許可は与えない。

## 現行価格と過去資料の読み分け

2026-10-26 00:36 UTCのPR #259反映が最新。1000パック4,000円／3000パック11,800円、Fast最大720p、通常2.0の1080p料金下限と費用前提は[STATUS](../STATUS.md)を参照する。上記PR #257候補資料の古い料金・未実行記述は当時の履歴であり現行仕様ではない。原本は保持し、適用対象のmain SHAと照合する。

## 状態ラベルと再開方法

- **確定仕様**：ユーザーが求めた挙動。実装完了を意味しない。
- **提案／保留**：未採用・縮小・未決。許可済みとして実行しない。
- **ローカルのみ／Previewのみ／本番済み**：成果物の実際の到達先。フロント・worker・DBをそれぞれ記録する。
- **検証済み**：試験名・結果・対象SHA・環境を添える。モック、実基盤、品質評価を区別する。
- **未確認**：不明を推測で埋めない。資料の読取で確認した事実と、親作業者の実ブラウザ確認から引き継いだ事実を区別する。

コード・資料・公開状態に差があれば、過去資料を消して整合したように見せず、STATUSへ日付付きで差と最新証拠を追記する。実行許可は記録の存在から推定しない。
