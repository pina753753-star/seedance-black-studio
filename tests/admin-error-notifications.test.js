'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const script = source.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1] || '';
const logic = script.slice(script.indexOf('function taskFacts'), script.indexOf('function matchesTaskFilter'));
const context = {
  Date,
  esc(value) {
    return String(value ?? '').replace(/[&<>"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    })[character]);
  },
  fmt: (value) => String(value),
  statusLabel: (value) => String(value),
  profilesCache: [],
  creditsCache: []
};
vm.createContext(context);
vm.runInContext(`${logic}\nthis.taskFacts=taskFacts;this.taskLedgerFacts=taskLedgerFacts;this.currentTaskClass=currentTaskClass;this.classifyTaskIssue=classifyTaskIssue;this.issueKey=issueKey;this.handlingState=handlingState;this.automaticHandlingLabel=automaticHandlingLabel;this.buildSupportRequest=buildSupportRequest;this.issueCard=issueCard;`, context);

test('終了済みの失敗を現在異常ではなく過去失敗として扱う', () => {
  assert.equal(context.currentTaskClass({ status: 'failed', credit_cost: 0 }), 'Historical');
  assert.equal(context.currentTaskClass({ status: 'queued', error_message: 'provider failed' }), 'Error');
});

test('完了済みで動画URLがないタスクを状態不整合として扱う', () => {
  const task = { status: 'completed', output_url: '' };
  assert.equal(context.currentTaskClass(task), 'Error');
  assert.equal(context.classifyTaskIssue(task).label, '状態不整合');
});

test('生のエラーを運用向けの8分類へ変換する', () => {
  const cases = [
    ['InputImageSensitiveContentDetected.PrivacyInformation real person', '実在人物・プライバシー判定'],
    ['moderation policy flagged', '安全確認エラー'],
    ['OpenRouter generation failed', '生成元エラー'],
    ['request timeout 503', '通信エラー'],
    ['credit refund failed', 'クレジット・返金エラー'],
    ['watermark storage save failed', '動画保存エラー'],
    ['status mismatch', '状態不整合'],
    ['', '原因未記録']
  ];
  for (const [error_message, expected] of cases) {
    assert.equal(context.classifyTaskIssue({ status: 'failed', error_message }).label, expected);
  }
});

test('同じタスクでも状態更新後は新しい通知として識別できる', () => {
  const before = context.issueKey({ id: 'task-1', status: 'queued', updated_at: '2026-08-04T01:00:00Z' });
  const after = context.issueKey({ id: 'task-1', status: 'failed', updated_at: '2026-08-04T01:01:00Z' });
  assert.notEqual(before, after);
});

test('通知の確認済みキーへ生のエラー文を保存しない', () => {
  const key = context.issueKey({
    id: 'task-1',
    status: 'failed',
    updated_at: '2026-08-04T01:01:00Z',
    error_message: '保存してはいけない詳細'
  });
  assert.doesNotMatch(key, /保存してはいけない詳細/);
});

test('ユーザー識別子と生のエラーをHTMLとして実行できない形にする', () => {
  const html = context.issueCard({
    id: 'task-1',
    user_id: '<img src=x onerror=alert(1)>',
    status: 'failed',
    error_message: '<script>alert(1)</script>'
  }, '現在異常');
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});

test('通知UIと閲覧専用の確認済み保存を備える', () => {
  assert.match(source, /id="notificationBtn"/);
  assert.match(source, /id="notificationCount"/);
  assert.match(source, /pinaAdminAcknowledgedIssuesV1/);
  // moderation_blocksを通知対象へ合算したことに伴い、初回基準化のキーを
  // V2へ更新した(導入前の既存ブロックが一斉に未確認扱いになるのを防ぐため)。
  assert.match(source, /pinaAdminAlertsInitializedV2/);
  assert.match(script, /initializeAlertBaseline\(\)/);
  assert.match(source, /localStorage\.setItem/);
  assert.doesNotMatch(source, /localStorage[\s\S]{0,200}client\.from\([^)]*\)\.(insert|update|delete)/);
});

test('初回以前の失敗を通知対象外にし、新しい失敗だけを通知できる', () => {
  assert.match(script, /writeAcknowledgedIssueKeys\(alertRowsCache\.map\(issueKey\)\)/);
  // 通知対象は「対応が必要な生成エラー + moderation_blocks」の合算。
  assert.match(script, /alertRowsCache=\[\.\.\.opsActionCache,\.\.\.modBlocksCache\]/);
});

test('返金記録と自動再生成なしを過去失敗へ表示する', () => {
  context.creditsCache.push({ related_task_id: 'task-1', amount: -80, credit_type: 'free', reason: 'video_generation' });
  context.creditsCache.push({ related_task_id: 'task-1', amount: 80, credit_type: 'free', reason: 'generation_refund' });
  const task = { id: 'task-1', status: 'failed' };
  assert.match(context.automaticHandlingLabel(task), /自動対応済み/);
  assert.match(context.issueCard(task, '過去の失敗'), /自動再生成：なし/);
});

test('失敗を自動対応済み・対応必要へ安全に分ける', () => {
  context.creditsCache.length = 0;
  assert.equal(context.handlingState({ id: 'free', status: 'failed', credit_cost: 0 }).kind, 'resolved');
  assert.equal(context.handlingState({ id: 'not-charged', status: 'failed', credit_cost: 245 }).kind, 'resolved');
  context.creditsCache.push({ related_task_id: 'paid', amount: -80, credit_type: 'free', reason: 'video_generation' });
  assert.equal(context.handlingState({ id: 'paid', status: 'failed', credit_cost: 80 }).kind, 'action');
  context.creditsCache.push({ related_task_id: 'paid', amount: 80, credit_type: 'free', reason: 'generation_refund' });
  assert.equal(context.handlingState({ id: 'paid', status: 'failed', credit_cost: 80 }).kind, 'resolved');
});

test('返金は合計だけでなくクレジット種類ごとの一致を確認する', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push(
    { related_task_id: 'task-pools', amount: -50, credit_type: 'subscription', reason: 'video_generation' },
    { related_task_id: 'task-pools', amount: -30, credit_type: 'free', reason: 'video_generation' },
    { related_task_id: 'task-pools', amount: 80, credit_type: 'free', reason: 'generation_refund' }
  );
  const ledger = context.taskLedgerFacts({ id: 'task-pools' });
  assert.equal(ledger.charged, 80);
  assert.equal(ledger.refunded, 80);
  assert.equal(ledger.code, 'partial_refund');
  assert.equal(context.handlingState({ id: 'task-pools', status: 'failed' }).kind, 'action');
});

test('料金差額返金と失敗返金の合計が消費額と一致すれば返金済みにする', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push(
    { related_task_id: 'task-cost-refund', amount: -100, credit_type: 'free', reason: 'video_generation' },
    { related_task_id: 'task-cost-refund', amount: 20, credit_type: 'free', reason: 'cost_based_refund' },
    { related_task_id: 'task-cost-refund', amount: 80, credit_type: 'free', reason: 'generation_refund' }
  );
  const ledger = context.taskLedgerFacts({ id: 'task-cost-refund' });
  assert.equal(ledger.charged, 100);
  assert.equal(ledger.refunded, 100);
  assert.equal(ledger.code, 'refunded');
  assert.equal(context.handlingState({ id: 'task-cost-refund', status: 'failed' }).kind, 'resolved');
});

test('不明なクレジット種類を消費なしと誤判定しない', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push({ related_task_id: 'task-unknown-pool', amount: -80, credit_type: 'unknown', reason: 'video_generation' });
  const ledger = context.taskLedgerFacts({ id: 'task-unknown-pool' });
  assert.equal(ledger.charged, 80);
  assert.equal(ledger.code, 'inconsistent');
  assert.equal(context.handlingState({ id: 'task-unknown-pool', status: 'failed' }).kind, 'action');
});

test('放置タスクは2時間15分までは自動復旧中、それを超えたら対応必要', () => {
  const now = Date.now();
  assert.equal(context.handlingState({ status: 'processing', updated_at: new Date(now - 60 * 60 * 1000).toISOString() }).kind, 'monitoring');
  assert.equal(context.handlingState({ status: 'processing', updated_at: new Date(now - 136 * 60 * 1000).toISOString() }).kind, 'action');
});

test('対応依頼には調査情報と安全な停止条件をまとめる', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push({ related_task_id: 'task-9', amount: -80, credit_type: 'free', reason: 'video_generation' });
  const request = context.buildSupportRequest({ id: 'task-9', status: 'failed', credit_cost: 80, error_message: 'refund failed' });
  assert.match(request, /タスクID: task-9/);
  assert.match(request, /予定クレジット: 80/);
  assert.match(request, /消費記録: 80クレジット（1件）/);
  assert.match(request, /返金記録: 0クレジット（0件）/);
  assert.match(request, /クレジット判定: 返金記録なし/);
  assert.match(request, /私の承認前に実行しないでください/);
});

test('赤いカードはコピー・確認済みだけを出し、意味が曖昧な個別再確認を出さない', () => {
  context.creditsCache.length = 0;
  context.creditsCache.push({ related_task_id: 'task-10', amount: -80, credit_type: 'free', reason: 'video_generation' });
  const html = context.issueCard({ id: 'task-10', status: 'failed', credit_cost: 80 });
  assert.match(html, /あなたの対応/);
  assert.doesNotMatch(html, /今すぐ再確認/);
  assert.match(html, /対応依頼をコピー/);
  assert.match(html, /通知を確認済みにする/);
});

test('画面表示中だけ60秒ごとに運用データを自動更新する', () => {
  assert.match(script, /OPS_REFRESH_MS=60000/);
  assert.match(script, /document\.visibilityState==='hidden'/);
  assert.match(script, /setInterval\(autoRefreshOps,OPS_REFRESH_MS\)/);
  assert.match(script, /opsRefreshInFlight/);
});

test('一覧に分類・要約・対処・ユーザー・生のエラーを表示する', () => {
  assert.match(script, /type\.label/);
  assert.match(script, /type\.summary/);
  assert.match(script, /確認すること/);
  assert.match(script, /対象ユーザー/);
  assert.match(script, /生のエラー/);
});

test('通知は対応が必要な項目とブロック記録だけを数え、開くだけでは確認済みにしない', () => {
  assert.match(script, /alertRowsCache=\[\.\.\.opsActionCache,\.\.\.modBlocksCache\]/);
  assert.doesNotMatch(script, /if\(name==='ops'\)acknowledgeCurrentErrors/);
  assert.match(script, /function acknowledgeIssue/);
});

test('再確認は既存の読み取り処理だけを呼び、書き込み処理を追加しない', () => {
  assert.match(script, /async function recheckOpsNow[\s\S]*await loadOps\(\)/);
  assert.doesNotMatch(script, /recheckOpsNow[\s\S]{0,500}client\.from\([^)]*\)\.(insert|update|delete)/);
  assert.match(source, /最新状態に更新/);
});

test('返金照合は全体最新50件ではなく最新100タスクのIDへ絞って読み取る', () => {
  assert.match(script, /fetchTaskCreditRows\(opsRowsCache\.map\(t=>t\.id\)\.filter\(Boolean\)\)/);
  assert.match(script, /\.in\('related_task_id',ids\)/);
  assert.match(script, /\.in\('reason',reasons\)/);
  assert.match(script, /cost_based_refund/);
  assert.doesNotMatch(script, /credit_transactions'[\s\S]{0,220}\.limit\(50\)/);
  assert.doesNotMatch(script, /fetchTaskCreditRows[\s\S]{0,900}\.(insert|update|delete)\(/);
});

test('スマホ幅では通知追加後もヘッダーを縮める指定がある', () => {
  const mobileCss = source.match(/@media\(max-width:430px\)\{([^}]|\}(?!\s*<\/style>))*\}/)?.[0] || '';
  assert.match(mobileCss, /\.brand small\{display:none\}/);
  assert.match(mobileCss, /\.logo\{width:36px;height:36px;min-width:36px/);
  assert.match(mobileCss, /\.notificationBtn\{min-width:39px;height:39px\}/);
  assert.match(mobileCss, /\.logoutBtn\{padding:9px;font-size:11px\}/);
});

// ---- ここから: moderation_blocksの通知統合・classification詳細・
// 過剰ブロック検出・フィルター・件数案内の追加分 ----

test('classification(11項目)がfictional-action-classifier.jsのREQUIRED_BOOLEAN_FIELDSと一致する', () => {
  const classifierSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', '_lib', 'fictional-action-classifier.js'),
    'utf8'
  );
  const fieldsMatch = classifierSource.match(/const REQUIRED_BOOLEAN_FIELDS = \[([\s\S]*?)\];/);
  assert.ok(fieldsMatch, 'REQUIRED_BOOLEAN_FIELDSが見つかりません');
  const expectedFields = fieldsMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.equal(expectedFields.length, 11);
  const adminFieldsMatch = script.match(/CLASSIFICATION_FIELDS=\[([\s\S]*?)\];/);
  assert.ok(adminFieldsMatch, 'admin.htmlにCLASSIFICATION_FIELDSが見つかりません');
  const adminFields = adminFieldsMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.deepEqual(adminFields, expectedFields);
});

test('classification詳細をブロックカードのdetailsに表示する', () => {
  assert.match(script, /function classificationDetail\(c\)/);
  assert.match(script, /classification詳細を表示（11項目）/);
  assert.match(script, /classification,prompt,created_at/);
});

test('同一カテゴリが30分以内に2件以上発生した場合を過剰ブロックの疑いとして検出する', () => {
  assert.match(script, /EXCESSIVE_BLOCK_WINDOW_MS=30\*60\*1000/);
  assert.match(script, /function detectExcessiveCategories\(rows\)/);
  assert.match(script, /過剰ブロックの疑い/);
  assert.match(script, /modExcessiveCategories=detectExcessiveCategories\(modBlocksCache\)/);
});

test('ブロック理由・モード・ユーザーで絞り込める', () => {
  assert.match(script, /function matchesModFilter\(r\)/);
  assert.match(script, /modReasonFilter/);
  assert.match(script, /modModeFilter/);
  assert.match(source, /id="modUserFilterInput"/);
  assert.match(script, /data-mod-reason-filter/);
  assert.match(script, /data-mod-mode-filter/);
});

test('生成エラー一覧・ブロック一覧の両方に最新100件表示中の案内を出す', () => {
  assert.match(source, /id="opsActionCountNote"/);
  assert.match(source, /id="modBlockCountNote"/);
  assert.match(script, /opsRowsCache\.length>=100\?'最新100件を表示中です/);
  assert.match(script, /modBlocksCache\.length>=100\?`最新100件を表示中です/);
});

test('新規追加分もDBへのinsert/update/deleteを一切行わない(読み取り専用を維持)', () => {
  const newLogicStart = script.indexOf('function tallyModBlockCategories');
  const newLogicEnd = script.indexOf('async function loadOps');
  const newLogic = script.slice(newLogicStart, newLogicEnd);
  assert.ok(newLogic.length > 0);
  assert.doesNotMatch(newLogic, /\.(insert|update|delete)\(/);
});
