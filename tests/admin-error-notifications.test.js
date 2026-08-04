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
  profilesCache: []
};
vm.createContext(context);
vm.runInContext(`${logic}\nthis.taskFacts=taskFacts;this.currentTaskClass=currentTaskClass;this.classifyTaskIssue=classifyTaskIssue;this.issueKey=issueKey;this.issueCard=issueCard;`, context);

test('失敗状態とエラー記録を現在異常として扱う', () => {
  assert.equal(context.currentTaskClass({ status: 'failed' }), 'Error');
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
  assert.match(source, /localStorage\.setItem/);
  assert.doesNotMatch(source, /localStorage[\s\S]{0,200}client\.from\([^)]*\)\.(insert|update|delete)/);
});

test('一覧に分類・要約・対処・ユーザー・生のエラーを表示する', () => {
  assert.match(script, /type\.label/);
  assert.match(script, /type\.summary/);
  assert.match(script, /対処の目安/);
  assert.match(script, /対象ユーザー/);
  assert.match(script, /生のエラー/);
});

test('スマホ幅では通知追加後もヘッダーを縮める指定がある', () => {
  const mobileCss = source.match(/@media\(max-width:430px\)\{([^}]|\}(?!\s*<\/style>))*\}/)?.[0] || '';
  assert.match(mobileCss, /\.brand small\{display:none\}/);
  assert.match(mobileCss, /\.logo\{width:36px;height:36px;min-width:36px/);
  assert.match(mobileCss, /\.notificationBtn\{min-width:39px;height:39px\}/);
  assert.match(mobileCss, /\.logoutBtn\{padding:9px;font-size:11px\}/);
});
