# 本番メタデータ照合と反映構成（読み取り専用調査）

対象project: jflpjsdjmlkmkqfahxwy。実施した本番操作はpg_catalog/information_schemaのSELECTだけ。ユーザーレコード、決済行、auth秘密値、キーは取得していない。DDL/DML/RPC実行・migration適用・push・公開なし。

## DB照合結果

- 本番PostgreSQL17.6、隔離試験17.11。同じmajorだが実行binaryは異なる。
- 既存6関数のprosrc MD5がリポジトリの検証済み定義とすべて完全一致。予約、控除、返還、Stripe付与、ledger付き付与、risk記録を確認。
- 各関数ownerはpostgres、anon/authenticated EXECUTEなし、service_role EXECUTEあり。補助関数check_purchase_credit_access_lockedは未作成。
- 必要6テーブルと列、非負残高CHECK、返還/Stripe reasonの一意index、同時active task一意index、ledger決済ID一意indexが存在。
- generation_tasks.settingsは本番ではnullable/defaultなし。今回の開始APIが控除前に設定するので前提を満たす。旧taskのnullは従来経路として扱う。
- 6テーブルともRLS有効。generation_tasksは表権限としてUPDATEがあるが、UPDATE policyはis_admin()だけ。一般本人向けはSELECTだけ。profiles.plan/role/account_statusはanon/authenticatedの列UPDATE権限なし。is_adminはDB内profiles.roleを使い、ユーザー編集可能なJWTメタデータを使わない。
- is_adminとfinished_atトリガー本文は改行CRLF/LFのみの差で正規化後一致。
- postgresの新規関数default ACLはanon/authenticated EXECUTEあり。草案がtransaction内で両関数のPUBLIC/anon/authenticatedを明示REVOKEするため、このdefaultを残さない。

証拠: `/workspace/pina-deliverables/production-rpc-comparison.json`、`production-schema-metadata.json`、`production-privilege-metadata.json`。実際のSELECTは `production-metadata-readonly.sql` と `production-privilege-readonly.sql`。本番の対象関数を呼んでテストする行為はしていない。

## ユーザー仕様との一致

DBのplan CHECKはfree/standard/premium/ultimate/scale/team。`basic`という内部値は存在せず、価格画面も最下位有料はStandard。ユーザーの「Basic」が最下位有料会員を指すなら、実装はstandardを有効サブスクとして扱い透かしなしにする。別plan aliasを推測で追加していない。

未加入の有効購入者は通常Seedance2.0/Fast/2.5 Standard/Turboのみ透かし付き。期限切れ会員も購入資格があれば同じ。Standard会員が別途購入資格で2.5を使っても透かし免除を維持し、Premiumへ昇格しない。H3/LIVE/Director/編集/独立音声/2.5絵コンテの追加解放はしない。既存の2.0無料経路と追加機能のtierを維持。

## 反映するSQL（承認後のみ）

`docs/sql/basic-credit-access-atomic.sql`：
1. 新規 `public.check_purchase_credit_access_locked(p_user_id uuid)`。
2. 置換 `public.deduct_generation_credits_atomic(p_task_id uuid,p_user_id uuid,p_credit_cost integer)`。

それ以外の関数、残高・台帳行、schema列、worker、Stripe商品、キーは変更しない。旧RPCの既存会計を維持した内部gate追加。これはローカル草案で本番には未適用。

rollback草案: `docs/sql/basic-credit-access-rollback.sql`。本番本文hashと一致した旧deductだけを復元し、未参照になったhelperをDROP（CASCADEなし）。先に新購入者受付を止めて受付済みtaskを完了/返還させる。残高・台帳・成果物は巻き戻さず、透かし前URLへ戻す配信rollbackもしない。

## 購入対応の正確な実装ファイル（17個）

```
api/_lib/credit-access.js
api/_lib/watermark-input-cleanup.js
api/_lib/seedance-start.js
api/_lib/video-plan-entitlements.js
api/credit-access.js
api/generated-videos.js
api/openrouter-reconcile.js
api/reference-audio-upload-url.js
api/seedance-status.js
api/stripe-checkout.js
api/wavespeed-reconcile.js
credits-info.html
flowvid-history.js
generate-prod.html
help.html
pricing.html
profile.html
```

テスト・説明書・SQLを含む全ローカル成果物はbasic-models-manifest.jsonに別記。plugin/MCPと除外した追加機能パッチは含めない。

## ブランチ構成と最小公開順序

現行main ec9190f427c8344de849e3a0587944e7058116bbとPreview252ebef340ec98732408640502579d1e5ee1c790は分岐している。Previewは共通祖先から13commit、mainは6commit。GitHub compareのtriple-dot一覧は2つの最新treeの直接差分ではない。

1. 現行mainから新しいローカル統合ブランチを切る案。既存Previewとlocal/standalone-basic-modelsは保持する。mainにある修正を消すPreview直置換はしない。
2. Previewの認証・ダンス差分をmainに統合し、両側の修正を保持。その上へ購入対応を別コミット可能な差分として載せる。まだcommit/merge/pushを実行していない。
3. 特にseedance-start.js、generate-prod.html、profile.htmlを意味で統合する。PreviewのdanceSettings更新はsettings全体を置換するため、購入対応のwatermark_required/purchase_access_requiredと共存させる修正が必要。クライアント値でサーバー判定を上書きしないこと。さらにreference_video_asset_idを伴うダンスは従来の有効上位サブスク＋管理者条件を明示的に維持する。通常2.5の購入gateを共用したままだと購入のみの管理者へダンスが広がるため、統合時に必ず分離する。生成画面/profileのPreview認証待機・verified token/一時503回復を保持する。
4. 統合後に認証・ダンス・通常4モデル・透かし・返還を再検証。いまの35DB/81関連/8画面テスト成功は統合前の購入対応に対する結果であり、統合版合格とは扱わない。
5. 外部反映が承認されたら対象定義が調査時から変わっていないことを再確認し、旧関数定義を保存→互換SQL適用→検証済み統合アプリの反映。購入だけ先行しない。プレビュー反映も現在は未許可。
6. 認証/ダンス修正・購入変更を分離したコミット単位を保ち、購入機能のrollbackで認証/ダンスを戻さない。旧workerを今回差し替える必要はないが、Preview側独自worker変更の公開状態は別のダンス反映管理で確認する。

最終的な未完了点は、指定Previewとの実統合・統合回帰、および外部反映の承認。DB metadata上で購入草案の適用を阻む不一致は今回の対象範囲では見つからなかった。


独立した小さい公開単位を選ぶなら、mainを基点にPreviewの認証改善（関連呼出し側も含む）＋購入対応の候補ブランチと、その候補へダンスPreviewを統合する検証ブランチを分ける。既存ダンスPreviewはそのまま維持できる。複合Previewを置き換える場合だけ後者の統合回帰を必須にする。どちらも現時点でブランチ作成・commit・公開はしていない。詳しい差分は `/workspace/pina-deliverables/branch-integration-review.md`。
