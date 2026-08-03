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
    ['api/_lib/seedance-start.js', 3, 'const preSendControl = await checkGenerationControl(db);', 'fetch(OPENROUTER_VIDEO_ENDPOINT', "db.rpc('refund_unsent_generation_task_atomic'"],
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

test('Seedanceは残高確認後の予約直前に停止状態を再確認する', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api/_lib/seedance-start.js'), 'utf8');
  const balanceMarker = 'if (total < creditCost) {';
  const reservationCheckMarker = 'const preReservationControl = await checkGenerationControl(db);';
  const reservationMarker = 'const taskResult = await createTask(db,';

  const balanceIndex = source.indexOf(balanceMarker);
  const checkIndex = source.indexOf(reservationCheckMarker);
  const reservationIndex = source.indexOf(reservationMarker);
  assert.notEqual(balanceIndex, -1, 'balance check is missing');
  assert.notEqual(checkIndex, -1, 'pre-reservation stop check is missing');
  assert.notEqual(reservationIndex, -1, 'task reservation is missing');
  assert.ok(balanceIndex < checkIndex, 'stop check must run after the read-only balance check');
  assert.ok(checkIndex < reservationIndex, 'stop check must run before task reservation');
});

test('Seedanceの送信前停止は原子的返還を使い、失敗時の復旧対象を残す', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api/_lib/seedance-start.js'), 'utf8');
  const finalCheckIndex = source.indexOf('const preSendControl = await checkGenerationControl(db);');
  const sendIndex = source.indexOf('fetch(OPENROUTER_VIDEO_ENDPOINT', finalCheckIndex);
  const finalBlock = source.slice(finalCheckIndex, sendIndex);

  assert.match(finalBlock, /db\.rpc\('refund_unsent_generation_task_atomic'/, 'atomic refund RPC is missing');
  assert.match(finalBlock, /p_from_subscription: deduction\.fromSub/, 'subscription refund amount is missing');
  assert.match(finalBlock, /p_from_free: deduction\.fromFree/, 'free refund amount is missing');
  assert.match(finalBlock, /p_from_purchased: deduction\.fromPurchased/, 'purchased refund amount is missing');
  assert.match(finalBlock, /refundData\.code === 'refunded'/, 'confirmed refund result is not checked');
  assert.match(finalBlock, /refundData\.code === 'already_refunded'/, 'idempotent refund result is not accepted');
  assert.doesNotMatch(finalBlock, /refundCredits\(/, 'non-atomic JavaScript refund must not be used');
  assert.doesNotMatch(finalBlock, /releaseTask\(/, 'failed refund must not remove the task from reconciliation');
});

test('Seedance送信前の専用RPCは台帳欠落時も控除結果から原子的に返還できる', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'supabase/migrations/20260803081000_add_emergency_generation_refund.sql'),
    'utf8'
  );

  assert.match(source, /security definer/i, 'SECURITY DEFINER is required');
  assert.match(source, /set search_path = ''/i, 'search_path must be fixed');
  assert.match(source, /for update;/i, 'row locks are required');
  assert.match(source, /p_from_subscription \+ p_from_free \+ p_from_purchased <> v_credit_cost/i, 'task cost must match refund total');
  assert.match(source, /subscription_credits = subscription_credits \+ p_from_subscription/i, 'subscription pool restore is missing');
  assert.match(source, /free_credits = free_credits \+ p_from_free/i, 'free pool restore is missing');
  assert.match(source, /purchased_credits = purchased_credits \+ p_from_purchased/i, 'purchased pool restore is missing');
  assert.match(source, /credit_transactions_generation_refund_unique|reason = 'generation_refund'/i, 'idempotent refund ledger is missing');
  assert.match(source, /revoke all on function[\s\S]*from public, anon, authenticated, service_role/i, 'default execute privileges must be revoked');
  assert.match(source, /grant execute on function[\s\S]*to service_role/i, 'only service_role may execute the RPC');
});
