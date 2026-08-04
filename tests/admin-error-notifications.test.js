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
vm.runInContext(`${logic}\nthis.taskFacts=taskFacts;this.currentTaskClass=currentTaskClass;this.classifyTaskIssue=classifyTaskIssue;this.issueKey=issueKey;this.handlingState=handlingState;this.automaticHandlingLabel=automaticHandlingLabel;this.buildSupportRequest=buildSupportRequest;this.issueCard=issueCard;`, context);

test('終了済みの失敗を現在異常ではなく過去失敗として扱う', () => {
  assert.equal(context.currentTaskClass({ status: 'failed', credit_cost: 0 }), 'Historical');
  assert.equal(context.currentTaskClass({ status: 'queued', error_message: 'provider failed' }), 'Error');
});

test('完了済みで動画URLがないタスクを状態不整合として扱う', () => {
  const task = { status: 'completed', output_url: '' };
  assert.equal(context.currentTaskClass(task), 'Error');
  assert.equal(context.classifyTaskIssue(task).label, '状態不整合');
});

test('生のエラーを運用向けの7分類へ変換する', () => {
  const cases = [
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
  assert.match(source, /pinaAdminAlertsInitializedV1/);
  assert.match(script, /initializeAlertBaseline\(\)/);
  assert.match(source, /localStorage\.setItem/);
  assert.doesNotMatch(source, /localStorage[\s\S]{0,200}client\.from\([^)]*\)\.(insert|update|delete)/);
});

test('初回以前の失敗を通知対象外にし、新しい失敗だけを通知できる', () => {
  assert.match(script, /writeAcknowledgedIssueKeys\(alertRowsCache\.map\(issueKey\)\)/);
  assert.match(script, /alertRowsCache=opsActionCache/);
});

test('返金記録と自動再生成なしを過去失敗へ表示する', () => {
  context.creditsCache.push({ related_task_id: 'task-1', amount: 80, reason: 'generation_refund' });
  const task = { id: 'task-1', status: 'failed' };
  assert.match(context.automaticHandlingLabel(task), /自動対応済み/);
  assert.match(context.issueCard(task, '過去の失敗'), /自動再生成：なし/);
});

test('失敗を自動対応済み・対応必要へ安全に分ける', () => {
  context.creditsCache.length = 0;
  assert.equal(context.handlingState({ id: 'free', status: 'failed', credit_cost: 0 }).kind, 'resolved');
  assert.equal(context.handlingState({ id: 'paid', status: 'failed', credit_cost: 80 }).kind, 'action');
  assert.equal(context.handlingState({ id: 'unknown', status: 'failed' }).kind, 'action');
  context.creditsCache.push({ related_task_id: 'paid', amount: 80, reason: 'generation_refund' });
  assert.equal(context.handlingState({ id: 'paid', status: 'failed', credit_cost: 80 }).kind, 'resolved');
});

test('放置タスクは2時間15分までは自動復旧中、それを超えたら対応必要', () => {
  const now = Date.now();
  assert.equal(context.handlingState({ status: 'processing', updated_at: new Date(now - 60 * 60 * 1000).toISOString() }).kind, 'monitoring');
  assert.equal(context.handlingState({ status: 'processing', updated_at: new Date(now - 136 * 60 * 1000).toISOString() }).kind, 'action');
});

test('対応依頼には調査情報と安全な停止条件をまとめる', () => {
  const request = context.buildSupportRequest({ id: 'task-9', status: 'failed', credit_cost: 80, error_message: 'refund failed' });
  assert.match(request, /タスクID: task-9/);
  assert.match(request, /使用クレジット: 80/);
  assert.match(request, /私の承認前に実行しないでください/);
});

test('赤いカードに再確認・コピー・確認済み操作と具体的な案内を出す', () => {
  const html = context.issueCard({ id: 'task-10', status: 'failed', credit_cost: 80 });
  assert.match(html, /あなたの対応/);
  assert.match(html, /今すぐ再確認/);
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

test('通知は対応が必要な項目だけを数え、開くだけでは確認済みにしない', () => {
  assert.match(script, /alertRowsCache=opsActionCache/);
  assert.doesNotMatch(script, /if\(name==='ops'\)acknowledgeCurrentErrors/);
  assert.match(script, /function acknowledgeIssue/);
});

test('再確認は既存の読み取り処理だけを呼び、書き込み処理を追加しない', () => {
  assert.match(script, /async function recheckOpsNow[\s\S]*await loadOps\(\)/);
  assert.doesNotMatch(script, /recheckOpsNow[\s\S]{0,500}client\.from\([^)]*\)\.(insert|update|delete)/);
});

test('スマホ幅では通知追加後もヘッダーを縮める指定がある', () => {
  const mobileCss = source.match(/@media\(max-width:430px\)\{([^}]|\}(?!\s*<\/style>))*\}/)?.[0] || '';
  assert.match(mobileCss, /\.brand small\{display:none\}/);
  assert.match(mobileCss, /\.logo\{width:36px;height:36px;min-width:36px/);
  assert.match(mobileCss, /\.notificationBtn\{min-width:39px;height:39px\}/);
  assert.match(mobileCss, /\.logoutBtn\{padding:9px;font-size:11px\}/);
});
