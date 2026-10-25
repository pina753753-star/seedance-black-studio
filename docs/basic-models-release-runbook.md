# 通常モデル単体購入: 検証・反映手順（未実行）

## 現状

local/standalone-basic-models。公開、本番DB変更、実決済、有料生成、キー操作は行っていない。
ユーザーの追加許可後、Docker公式postgres:17.11-bookwormを取得し、network none・ポート非公開・tmpfsの隔離DBで実SQL/権限/並行性試験を実施した。結果は `/workspace/pina-deliverables/postgres-results.json` と `postgres-tests.log`。以前の環境不足報告は取得前の記録。

## 実DB試験の再実行と範囲

`python tests/postgres/run.py` で再実行する。取得済み公式イメージを利用し自動pullはしない。外部DBや本番複製を使わず、合成UUID/残高/台帳だけの隔離DBを使う。Dockerならローカルsocket・network none・ホストポート公開なし・新規一時データ領域・実credentialなしとし、試験後はその一時領域だけを破棄する。

既存migrationから対象テーブル/制約/旧deduct/refund/risk/grant関数を準備し、旧関数の結果を記録後に草案を適用。anon/authenticated/service_roleの実行権限も試す。今回の試験は実PostgreSQLで実関数を実行しているが、Supabase全体や本番schemaの同一性を証明するものではない。独立詳細レビューは `/workspace/pina-deliverables/sql-followup-review.md`。既存の返還は元poolへ戻すが期限を延長しない。受付後の会員失効・決済保留を既完了控除へ遡及適用する変更は行わない。

## 必須の実SQL試験マトリクス

|条件/並行スケジュール|確認すべき結果|
|---|---|
|markerなしの旧利用者|旧RPCと残高・台帳・応答が一致|
|期限内購入残高＋granted credit_pack|控除成功、subscription→free→purchased順|
|購入残高0/不足、期限切れ/null、grantedなし|資格または残高不足で失敗、余分な控除なし|
|他人のtask/購入台帳|本人資格として利用されない|
|held/reversed、open/reviewing、user_id未紐付けだが決済ID一致risk|購入資格拒否、残高を没収しない|
|同一taskを2セッションで控除|合計1回のみ、再実行はalready_deducted|
|同一userの別taskを同時控除|balance lockで直列化、負残高/過剰控除なし|
|riskがledger lock先取→commit→控除|購入資格拒否|
|控除がledger lock先取→commit→risk|先行控除だけ成立、後続購入資格は拒否|
|grant/risk/debitを逆順・同時投入|deadlock/timeout/不整合を観測し、失敗時ロールバックと再試行を確認|
|失敗返還を2セッションで重複実行|元poolへ正確に1回返還、次回新taskの資格と残高が一致|
|返還と別task控除を並行|どちらの直列化順でも残高/台帳の保存則を満たす|
|ロック待機中に購入期限が到来|DBのnow()はtransaction開始時刻。採用する資格判定時点と一致するか確認|
|有効/期限切れの会員＋追加購入、Standard＋購入|会員優遇と購入資格が別。上位add-onを解放しない|

会員期限は現在のアプリが資格取得時に評価しtask.settingsへ透かし方針を保存する。SQL草案は購入資格を再確認するだけで会員資格を再判定しない。受付直後に期限が来た既受付taskの透かし方針は維持される。購入者の期限判定にはDBのtransaction時刻を使う。時計差/長いロック待ちを実DBで境界試験する。

## 将来外部反映する際の最小手順

現時点で実施許可はない。下記は承認後の手順案。

1. 隔離DBの実行済み結果を確認し、現在の対象DB関数/schemaが比較基準migrationと一致することを権限のある担当者が確認する。差異があれば草案適用を止める。
2. 対象の旧関数定義をロールバック用に保存する。草案の補助関数＋deduct_generation_credits_atomicだけをtransactionで適用。新規table/column/bucket・worker・Stripe商品・キー変更は不要。旧アプリはmarkerを付けないので旧会計処理が継続する。
3. 購入資格/開始/状態/履歴/UI/Checkout/一時掃除を同じアプリreleaseに含める。購入ボタンだけ先行して使えない状態を作らない。既存worker /watermark応答と既存Storageの一時入力・cursor JSON保存を許可済み環境で確認する。
4. 実課金なしのmockテストと、既存テスト資材による透かし完了/履歴/保存を確認。独立レビュー後に承認された公開手順へ進む。新しい実動画生成が必要になった場合は未実施として別途扱う。
5. 観測する項目: generation_policy_save_failed、purchase_access_revoked/payment_risk_hold、控除/返還失敗、watermarkPending滞留、watermark_cleanup_failedログとwatermarkCleanup.ok。cleanup失敗は旧refundのHTTP200を変更しないためHTTPコードだけで監視しない。

影響する正常系はCheckout→資格取得→生成予約→settings保存→既存atomic控除→既存provider→状態取得/worker透かし→完了保存→履歴/保存。失敗時は既存atomic返還へ進む。H3/LIVE/Director/編集の実装とworkerは今回変更しない。

## 戻し方

まず新しい購入者向け2.5受付を閉じる。受付済みtaskは保存済み透かし方針に従って完了/返還させ、生URLへ戻すrollbackはしない。未処理task解消後、保存した旧deduct関数へ戻し未参照helperを削除。残高・Stripe台帳・返還記録・成果物は戻さず保持する。アプリだけ先に旧版へ戻す場合も旧履歴の安全な透かし配信を維持する。SQLを先に旧版へ戻した状態で新購入者の受付を続けない。
