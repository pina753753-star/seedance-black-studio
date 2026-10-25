# 通常モデルのクレジット単体購入対応（ローカル限定）

基準 main: ec9190f427c8344de849e3a0587944e7058116bb。ブランチ: local/standalone-basic-models。commit/push/公開/実決済/DB適用/キー操作なし。

## 対象と資格

|範囲|購入資格|有効サブスク|透かし|
|---|---|---|---|
|通常 Seedance 2.0 / Fast|既存利用経路を維持|既存条件|非加入はあり、加入はなし|
|通常 Seedance 2.5 Standard / Turbo|期限内の正の購入残高＋本人の確定credit_pack台帳＋リスク保留なし|従来Premium/Ultimate/Team/Scale。Standardは別途購入資格が必要|同上|
|H3/LIVE/Director/編集/独立音声/2.5絵コンテ|今回追加しない|既存の各プラン条件を維持|既存実装維持|

通常生成はtext_to_video/image_to_video/reference_to_video。無料付与だけで2.5は解放しない。購入資格とプランを分離し、Premium自動昇格なし。期限切れサブスク＋購入残高は透かし付き。有効サブスク＋追加購入は透かしなし。料金・クレジット消費単価は変更なし。

絵コンテは明示modeまたはui_originに対してサーバーでも既存高位サブスクを要求。通常の参照動画入力を利用者が自ら絵コンテ風に構成することまで禁止・識別する仕組みではない。独立音声はアップロードAPIと生成APIの両方で高位サブスクを維持。

## 最小変更と維持する条件

- Checkoutのcredit_packに限りsubscription_requiredを除去。既存認証、価格、Stripe metadata、サブスク購入処理を維持。
- generation_tasks.settingsへサーバー側でwatermark_required/purchase_access_requiredを控除前に保存。所有者・未送信・queuedの条件付き更新失敗は控除せず停止。
- 既存透かしworkerを利用。通常出力/履歴/ダウンロードへ安全なURLのみを返し、透かし未完了や完了権取得失敗で生URLへフォールバックしない。旧履歴は明示操作で仕上げ再試行。保存済み透かし方針を後の残高変化で書き換えない。
- 一時入力はUUID、upsert:false、cacheControl:0。通常のfinally削除に加え、遅延成功・プロセス終了後の残留を既存OpenRouter cronから24時間後に回収。対象は設定済み動画bucket内watermark-inputsのみ、最終出力やユーザー入力は対象外。最大500件/回、タイムアウトあり。走査位置だけをwatermark-cleanup-state/watermark-inputs.jsonへ保存。失敗は返還処理を妨げず専用エラーログとwatermarkCleanup.okで観測。
- 所有権確認、メール確認、moderation、生成予約と同時実行制限、残高不足、既存控除順、失敗時のatomic返還、Webhook冪等性は保持。返還不可への変更なし。

## SQL / worker / 互換性

`docs/sql/basic-credit-access-atomic.sql`は本番未適用の草案（隔離DBのみ適用・検証済み）。新規列・テーブル・bucket・worker改修・認証設定は不要。補助関数1個と既存deduct_generation_credits_atomicの内部資格再検査だけ。関数の引数・成功応答・既存控除会計は維持。購入資格が控除前に取り消された場合だけ新しい失敗コードを返す。購入ゲートを除いたRPC本文は既存migrationとbyte一致する構造テストあり。

資格確認→控除間の失効/リスク更新競合に備え、task→ledger→balanceのロックを使って控除時に再検証する。SQLなしでアプリだけ公開するとこの再検証は有効にならないため、単独公開は不可。追加許可後に隔離PostgreSQL17.11で実SQL適用・権限拒否・ロック待機を伴う控除/返還/risk/grant競合を検証済み（postgres-results.json参照）。本番への適用は未実施で、実環境schema/ACLとの差分確認は別途必要。

APIの既存route/requestを維持し、新規GET /api/credit-accessに能力flagsを追加。完了応答で透かし待ちは安全側に未完了として返る。履歴のwatermarkPendingとcronのwatermarkCleanupは追加フィールド。既存workerの/watermarkと既存キーを使う設計で、キー交換は前提にしない。

## ロールバック案（未実行）

1. 新規の購入者向け2.5開始許可を閉じるアプリ差分を戻す。受付済みタスクの透かし完了処理と安全な履歴配信は維持して処理完了させる。
2. 処理中タスクが解消した後、元migration定義へdeduct_generation_credits_atomicを戻し、未参照の補助関数を削除する。残高・台帳・返還履歴・生成成果物を戻したり消したりしない。
3. 一時掃除は最終出力に触れない。停止する場合は残留一時入力を別途確認する。購入自体のロールバックと既購入残高の扱いを混同しない。

## 保存済み別差分と検証限界

H3/LIVE/Director/編集の拡張作業は `/workspace/pina-deferred-full-features` にファイルとSHA256付きで保存し、今回のactive差分から除外した。ChatGPT Apps/MCP scaffoldは停止したまま別成果物として保持。

ローカル試験はモック/静的検証に加え、隔離PostgreSQLの実SQL/並行性35ケースを実施。実Stripe/生成API/Storage/外部DBへの送信なし。動画を実生成したブラウザE2E、実worker合成、Storage bucketのJSON MIME許可は未確認。TTL掃除は既存cronが実行される環境を前提とする。透かしは製品の表示・保存方針であり、過去に取得されたraw URLの取り消しやDRMの保証ではない。
