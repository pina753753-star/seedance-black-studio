'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONTROL_KEY,
  STOP_MESSAGE,
  REFUND_UNCONFIRMED_MESSAGE,
  checkGenerationControl
} = require('../api/_lib/generation-control.js');

function mockDb(result) {
  return {
    from(table) {
      assert.equal(table, 'service_controls');
      return {
        select(columns) {
          assert.equal(columns, 'enabled');
          return {
            eq(column, value) {
              assert.equal(column, 'control_key');
              assert.equal(value, CONTROL_KEY);
              return {
                maybeSingle: async () => result
              };
            }
          };
        }
      };
    }
  };
}

test('enabled=trueだけが新規処理を許可する', async () => {
  assert.deepEqual(await checkGenerationControl(mockDb({ data: { enabled: true }, error: null })), { ok: true });
});

test('enabled=falseは503で停止する', async () => {
  const result = await checkGenerationControl(mockDb({ data: { enabled: false }, error: null }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'video_generation_temporarily_disabled');
  assert.equal(result.body.message, STOP_MESSAGE);
  assert.match(REFUND_UNCONFIRMED_MESSAGE, /返還を確認できません/);
});

test('制御行が無い場合も安全側で停止する', async () => {
  const result = await checkGenerationControl(mockDb({ data: null, error: null }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test('DB読取エラーは安全側で停止する', async () => {
  const result = await checkGenerationControl(mockDb({ data: null, error: { message: 'read failed' } }));
  assert.equal(result.ok, false);
  assert.equal(result.body.error, 'generation_control_unavailable');
});

test('DB例外は安全側で停止する', async () => {
  const db = { from() { throw new Error('boom'); } };
  const result = await checkGenerationControl(db);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test('DBクライアントが無い場合も安全側で停止する', async () => {
  const result = await checkGenerationControl(null);
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test('3つの開始経路すべてが外部処理より前に停止判定する', () => {
  const root = path.join(__dirname, '..');
  const checks = [
    [
      'api/_lib/seedance-start.js',
      'const generationControl = await checkGenerationControl(db);',
      ['const moderation = await moderateContent', 'const taskResult = await createTask', 'deduction = await checkAndDeduct', 'fetch(OPENROUTER_VIDEO_ENDPOINT']
    ],
    [
      'api/video-edit.js',
      'const generationControl = await checkGenerationControl(db);',
      [".from('credit_balances')", "db.rpc('reserve_video_edit_task'", 'fetch(`${railwayBaseUrl']
    ],
    [
      'api/storyboard-prompt.js',
      'const generationControl = await checkGenerationControl(auth.supabase);',
      ['lastCallAt.set(userId, now)', 'fetch(OPENROUTER_CHAT_ENDPOINT']
    ]
  ];

  for (const [relativePath, controlMarker, externalWorkMarkers] of checks) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const controlIndex = source.indexOf(controlMarker);
    assert.notEqual(controlIndex, -1, `${relativePath}: stop check is missing`);
    for (const externalWorkMarker of externalWorkMarkers) {
      const externalIndex = source.indexOf(externalWorkMarker);
      assert.notEqual(externalIndex, -1, `${relativePath}: external-work marker is missing`);
      assert.ok(controlIndex < externalIndex, `${relativePath}: stop check must run before ${externalWorkMarker}`);
    }
  }
});

test('時間のかかる処理後と外部送信直前にも停止状態を再確認する', () => {
  const root = path.join(__dirname, '..');
  const checks = [
    ['api/_lib/seedance-start.js', 3, 'const preSendControl = await checkGenerationControl(db);', 'fetch(OPENROUTER_VIDEO_ENDPOINT', 'refundCredits(db, user.id, deduction, taskId)'],
    ['api/video-edit.js', 3, 'const preSendControl = await checkGenerationControl(db);', 'fetch(`${railwayBaseUrl', "db.rpc('refund_video_edit_task'"],
    ['api/storyboard-prompt.js', 2, 'const preSendControl = await checkGenerationControl(auth.supabase);', 'fetch(OPENROUTER_CHAT_ENDPOINT', null]
  ];

  for (const [relativePath, expectedChecks, finalCheckMarker, sendMarker, refundMarker] of checks) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const actualChecks = (source.match(/await checkGenerationControl\(/g) || []).length;
    assert.equal(actualChecks, expectedChecks, `${relativePath}: unexpected stop-check count`);

    const finalCheckIndex = source.indexOf(finalCheckMarker);
    const sendIndex = source.indexOf(sendMarker);
    assert.notEqual(finalCheckIndex, -1, `${relativePath}: final stop check is missing`);
    assert.notEqual(sendIndex, -1, `${relativePath}: send marker is missing`);
    assert.ok(finalCheckIndex < sendIndex, `${relativePath}: final stop check must run before provider send`);

    if (refundMarker) {
      const refundIndex = source.indexOf(refundMarker, finalCheckIndex);
      assert.notEqual(refundIndex, -1, `${relativePath}: emergency refund is missing`);
      assert.ok(refundIndex < sendIndex, `${relativePath}: emergency refund must run before provider send`);
    }
  }
});
