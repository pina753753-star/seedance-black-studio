'use strict';

// H3/Seedanceとは無関係の追加仕様: generate-prod.html の pending-task
// (未完了カード) UIのうち、failedカードの保持ルールだけを変更する。
//
// failedカードは
//   1. failed表示になってから3分(180000ms)経過
//   2. ユーザーが「閉じる」ボタンを押す
// のどちらか早い方でのみ削除される。loadPendingTasks()の再読込では
// 即時削除されない。
//
// この repo の既存の generate-prod.html 向けテスト
// (tests/generation-button-status.test.js 等)と同じ方式で、実DOM/jsdomを
// 使わず、対象関数のソース文字列を抽出して静的に検証する。加えて、
// タイマー管理ロジック(_ptFailTimers / _ptClearFailTimer)はDOM依存が無いため
// 実際に抽出・評価し、node:testのmock.timersで実行して振る舞いも確認する。
//
// 実API・実生成・credits消費・本番DB/Storage書き込みは一切行わない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'generate-prod.html'), 'utf8');

function sliceFn(name, source_ = source) {
  const start = source_.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  // Slice up to the next top-level `function ` or `setTimeout(loadPendingTasks` marker,
  // whichever comes first after start — matches the one-function-per-line style of
  // this file's minified pending-task block.
  const rest = source_.slice(start + 1);
  const nextFn = rest.search(/\nfunction |\nsetTimeout\(loadPendingTasks/);
  return nextFn === -1 ? source_.slice(start) : source_.slice(start, start + 1 + nextFn);
}

const ptFail = sliceFn('_ptFail');
const ptRemove = sliceFn('_ptRemove');
const loadPendingTasks = sliceFn('loadPendingTasks');
const ptComplete = sliceFn('_ptComplete');
const ptStartPoll = sliceFn('_ptStartPoll');
const ptInsertCard = sliceFn('_ptInsertCard');
const ptProgressStart = sliceFn('_ptProgressStart');

// ---------------------------------------------------------------
// 1. _ptFail() 実行後、failedカードが残る
// ---------------------------------------------------------------

test('1. _ptFail()はカードを即時削除しない(_ptRemoveはユーザー操作またはsetTimeoutの中でのみ呼ばれる)', () => {
  // _ptFail()本体が同期的に_ptRemoveを呼ぶ箇所が無いこと。
  // _ptRemove(taskId)への参照は「閉じるボタンのonclick」と「180000ms後のsetTimeout」
  // の2箇所だけであり、いずれも即時実行ではない(ユーザー操作 or タイマー経由)。
  const removeCalls = [...ptFail.matchAll(/_ptRemove\(taskId\)/g)];
  assert.equal(removeCalls.length, 2, '_ptRemove(taskId)の参照は「閉じるボタン」と「setTimeout」の2箇所のはず');

  for (const m of removeCalls) {
    const before = ptFail.slice(Math.max(0, m.index - 60), m.index);
    const isFromOnclick = /onclick=\(\)=>$/.test(before);
    const isFromSetTimeout = /setTimeout\(\(\)=>\{$/.test(before);
    assert.ok(
      isFromOnclick || isFromSetTimeout,
      `_ptRemove呼び出しは即時実行コードパスにあってはならない: ...${before}`
    );
  }
});

// ---------------------------------------------------------------
// 2. loadPendingTasks() 再読込でもfailedカードが即時削除されない
// ---------------------------------------------------------------

test('2. loadPendingTasks()はfailedカードを削除しない(_ptRemove/.remove()を呼ばない)', () => {
  assert.doesNotMatch(loadPendingTasks, /_ptRemove/);
  assert.doesNotMatch(loadPendingTasks, /\.remove\(\)/);
  // 新規タスクの追加は既存カードに無いものだけ(freshTasks)に限定されている
  assert.match(loadPendingTasks, /freshTasks=activeTasks\.filter\(t=>t\.id!==_activePtId&&!document\.querySelector/);
  assert.match(loadPendingTasks, /insertAdjacentHTML\('beforeend'/);
});

// ---------------------------------------------------------------
// 3. failedカードに手動削除UIがある
// ---------------------------------------------------------------

test('3. failedカードのHTMLに閉じるボタン(data-pt-close)が含まれる', () => {
  assert.match(ptFail, /data-pt-close/);
  assert.match(ptFail, />閉じる<\/button>/);
});

// ---------------------------------------------------------------
// 4. 手動削除でカードが消える
// ---------------------------------------------------------------

test('4. 閉じるボタンのonclickは_ptRemove(taskId)を呼ぶ', () => {
  assert.match(
    ptFail,
    /btnClose=f\.querySelector\('\[data-pt-close\]'\);if\(btnClose\)btnClose\.onclick=\(\)=>_ptRemove\(taskId\)/
  );
});

test('_ptRemove自体はDOMからカードを削除する(既存挙動、無変更であることの確認)', () => {
  assert.match(ptRemove, /if\(c\)c\.remove\(\)/);
});

// ---------------------------------------------------------------
// 5. 手動削除時にtimerが解除される
// ---------------------------------------------------------------

test('5. _ptRemove()は_ptClearFailTimer(taskId)を呼び、failタイマーを解除する', () => {
  assert.match(ptRemove, /_ptClearFailTimer\(taskId\)/);
});

// ---------------------------------------------------------------
// 6. 180000ms後にfailedカードが自動削除される
// ---------------------------------------------------------------

test('6. _ptFail()はPT_FAIL_RETENTION_MS(=180000)後にsetTimeoutで_ptRemoveを予約する', () => {
  assert.match(source, /const PT_FAIL_RETENTION_MS=180000;/);
  assert.match(
    ptFail,
    /_ptFailTimers\[taskId\]=setTimeout\(\(\)=>\{_ptRemove\(taskId\)\},PT_FAIL_RETENTION_MS\);/
  );
});

// ---------------------------------------------------------------
// 7. 同一カードに重複timerを作らない
// ---------------------------------------------------------------

test('7. _ptFail()は新しいタイマーを登録する前に既存タイマーを解除する', () => {
  const clearIdx = ptFail.lastIndexOf('_ptClearFailTimer(taskId);');
  const setIdx = ptFail.indexOf('_ptFailTimers[taskId]=setTimeout(');
  assert.notEqual(clearIdx, -1);
  assert.notEqual(setIdx, -1);
  assert.ok(clearIdx < setIdx, '_ptClearFailTimerは新規setTimeout登録より前に呼ばれるべき');
});

test('7b. _ptClearFailTimer()は実際にclearTimeoutしてから登録を削除する(振る舞いテスト)', () => {
  // DOM依存の無いタイマー管理ブロックだけを実際に抽出・評価して確認する。
  const start = source.indexOf('const _pendingPollers={};');
  const end = source.indexOf('function _ptProgressStart');
  const block = source.slice(start, end);

  assert.match(block, /const _ptFailTimers=\{\};/);
  assert.match(block, /function _ptClearFailTimer\(taskId\)\{if\(_ptFailTimers\[taskId\]\)\{clearTimeout\(_ptFailTimers\[taskId\]\);delete _ptFailTimers\[taskId\];\}\}/);

  const sandbox = new Function(`
    ${block}
    return { _ptFailTimers, _ptClearFailTimer, PT_FAIL_RETENTION_MS };
  `)();

  assert.equal(sandbox.PT_FAIL_RETENTION_MS, 180000);

  // タイマーを1つ登録し、clearFailTimerで解除できることを確認する。
  let fired = false;
  sandbox._ptFailTimers.taskA = setTimeout(() => { fired = true; }, 1000);
  assert.ok(sandbox._ptFailTimers.taskA);

  sandbox._ptClearFailTimer('taskA');
  assert.equal(sandbox._ptFailTimers.taskA, undefined);

  // 未登録のtaskIdに対して呼んでも例外を投げない(no-op)。
  assert.doesNotThrow(() => sandbox._ptClearFailTimer('taskB'));
});

test('7c. 同じtaskIdへ再登録する前にclearすれば、タイマーは常に1個だけになる(振る舞いテスト)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const start = source.indexOf('const _pendingPollers={};');
  const end = source.indexOf('function _ptProgressStart');
  const block = source.slice(start, end);

  const sandbox = new Function(`
    ${block}
    return { _ptFailTimers, _ptClearFailTimer };
  `)();

  let fireCount = 0;
  const register = () => {
    sandbox._ptClearFailTimer('taskX');
    sandbox._ptFailTimers.taskX = setTimeout(() => { fireCount += 1; }, 180000);
  };

  register();
  register();
  register();

  t.mock.timers.tick(180000);

  assert.equal(fireCount, 1, '重複登録を避けていれば1回しか発火しない');
});

// ---------------------------------------------------------------
// 8. queued / processing / completedの既存挙動は変更しない
// ---------------------------------------------------------------

test('8. _ptComplete(): 完了後1500msでの自動削除(非絵コンテ)は無変更', () => {
  assert.match(
    ptComplete,
    /setTimeout\(\(\)=>\{_ptRemove\(taskId\);if\(typeof window\.flowvidLoadHistory==='function'\)window\.flowvidLoadHistory\(mode\)\},1500\)/
  );
});

test('8. _ptStartPoll(): 12000msごとのポーリング間隔は無変更', () => {
  assert.match(ptStartPoll, /\},12000\)/);
});

test('8. _ptProgressStart(): 2000msごとの進捗更新間隔は無変更', () => {
  assert.match(ptProgressStart, /\},2000\);/);
});

test('8. _ptInsertCard(): queued/processing新規カード挿入ロジックは無変更', () => {
  assert.match(ptInsertCard, /insertAdjacentHTML\('afterbegin',_ptCard\(task,false\)\);_ptProgressStart\(task\.id,4\);/);
});

test('8. loadPendingTasks(): STALE_MS/MAX_AGE_MSしきい値は無変更', () => {
  assert.match(loadPendingTasks, /const STALE_MS=30\*60\*1000;const MAX_AGE_MS=24\*60\*60\*1000;/);
});
