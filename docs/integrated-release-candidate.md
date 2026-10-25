# 公開候補：Preview認証・ダンス＋通常4モデル単体購入

この文書が今回の統合候補の最新状態。過去の調査文書にある「統合未実施」「SQL未検証」は当時の記録。

候補checkout: `/workspace/pina-release-local`
候補branch: `local/release-basic-credits-preview252ebef`
基準main: `ec9190f427c8344de849e3a0587944e7058116bb`
統合したPreview: `252ebef340ec98732408640502579d1e5ee1c790`
未commitのローカル候補。candidate-manifest.jsonとcandidate-id.txtのSHA256で内容を特定し、commit SHAとして扱わない。既存main/Preview/元購入ブランチ・pluginには変更なし。

## 統合結果

- Previewのverified auth、初期session競合対策、一時的503からの回復を保持。
- ダンスは元の上位有効サブスク＋運営管理者条件、asset所有権/検査/同意/保持期限/同時生成/料金/返還を維持。購入のみの管理者は不可。
- seedance-startの2回の条件付きsettings保存で、どちらにも同じサーバー算出watermark_required/purchase_access_requiredを保存する最小修正。2回目は参考ダンス情報も保存。クライアントsettingsを取り込まない。どちらの保存失敗も控除・provider前に停止。
- 通常2.0/Fast/2.5 Standard/Turboのみ購入資格を追加。未加入購入者は透かしあり。有効standard（現行最下位有料、Basicという内部値はなし）も透かしなし。Standard＋購入で通常2.5は使えるが追加機能を昇格しない。
- ダンスworkerはPreview内容を維持し、mainの制限付きHEVC/検査保護も保持。購入対応がworkerへ独自機能を追加したわけではない。
- 別タスクの価格表示「175」テスト修正は取得・混入していない。その差分は今回不要。

## 最終検証

- 統合回帰670件：647成功、mainでも再現する既存失敗3件、skip8、TODO12。
- 既存失敗はgeneration-controlの静的チェック2件と、現環境のinstalled SDK private download500 stallテスト1件。元mainの別checkoutで同じ3件を再現。失敗を無視して全成功とはしていない。今回の製品変更で発生した回帰は検出されなかった。
- 統合のダンス/購入境界34件成功。資格偽装、両settings保存失敗、購入のみadmin拒否、Premium成功を含む。
- 実auth-guardを使うローカルChromium9ケース成功。実API/Auth/Storage/providerはモック・遮断。
- 最終checkoutから実PostgreSQL35ケース成功。一時DBを削除。本番にはSQL未適用。
- 独立レビュー84件成功、新規P1なし。
- 構文・diff-check成功。

以前の本番読み取り照合では関連6RPCが元定義と一致。統合後にダンスregistry列とclaim RPCのメタデータだけも照合し、最新Previewのclaim本文hash/execute権限と一致した。ユーザーレコード・キーは読まず、本番変更なし。

## 承認対象の最小単位

1. この候補内容のcommit/pushと、既存アプリへの反映。変更ファイルの正確な一覧・hashはcandidate-manifest.json。アプリは認証・ダンス・購入・履歴をこの候補として一体反映する。
2. 既存workerをPreview相当へ反映（対象 `watermark-server/server.js` と `watermark-server/reference-dance-inspection.js`）。すでに同一内容なら再反映不要。新worker/キー/インフラは不要。実workerの現在版と対応capabilityは反映前の確認事項。
3. `docs/sql/basic-credit-access-atomic.sql` を対象projectへ適用：新規 `public.check_purchase_credit_access_locked(uuid)` と置換 `public.deduct_generation_credits_atomic(uuid,uuid,integer)` だけ。実データ・価格・商品変更なし。ダンスschemaの3migrationは候補に履歴として含まれるが、既存DBへ無差別再適用しない。

推奨順序は反映直前の対象SHA/DB定義/worker版の再確認→旧RPC・現行deployment参照を記録→必要なら互換worker先行→購入SQL→統合アプリ。購入ボタンだけ先行しない。公開操作の自動hookがworkerも対象にするか確認し、意図しない先行反映を避ける。現在はすべて未実行。

## 影響と戻し方

影響経路は認証→通常/ダンス資格→予約→settings保存→atomic控除→provider→透かし/完了→履歴/保存。失敗は既存atomic返還。cronにはPreviewのダンス掃除が加わり、既存OpenRouter cronが通常透かし一時入力も掃除する。H3等のtierは維持。

問題時は購入者の新規受付を閉じ、受付済みtaskの透かし完了/返還を維持して処理を収束。その後 `docs/sql/basic-credit-access-rollback.sql` で元控除RPCを復元し未参照helperのみ削除する。残高・台帳・成果物を戻したり削除したりしない。認証・ダンスの修正を購入rollbackと一緒に消さないよう、commitは論理差分を分ける。workerを戻す場合は新しいダンス入力を停止し、処理中asset/taskを確認後に旧互換版へ戻す。

## 未実施E2E

実Supabase Auth/Storage、現在の公開worker、Stripe実決済、生成providerの有料生成を一連で通すE2Eは未実施。ブラウザ9ケースとDB35ケースをその代替証明とはしない。実素材/実接続の確認が必要な段階は、対象と課金有無を明示して別の許可範囲で扱う。
