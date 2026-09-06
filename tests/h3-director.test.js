'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../api/_lib/h3-director-config.js');
const { createDirectorSession } = require('../api/_lib/h3-director-fal.js');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'h3-director.html'), 'utf8');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260906000000_create_h3_director_slice.sql'),
  'utf8'
);

test('Director product settings stay fixed and isolated', () => {
  assert.equal(config.DURATION_SECONDS, 60);
  assert.equal(config.RESOLUTION, '768p');
  assert.equal(config.CREDIT_COST, 440);
  assert.deepEqual(config.ALLOWED_ASPECT_RATIOS, ['16:9', '9:16']);
  assert.equal(config.FAL_DIRECTOR_APP_ID, 'minimax/h3-max/director');
});

test('browser uses the official WMA channel and a STUN server', () => {
  assert.match(page, /createDataChannel\('fal'/);
  assert.match(page, /stun:stun\.l\.google\.com:19302/);
  assert.doesNotMatch(page, /createDataChannel\('control'/);
});

test('recording upload failure is handled before completion is requested', () => {
  const upload = page.indexOf('uploadToSignedUrl');
  const uploadFailure = page.indexOf("if(up&&up.error)throw new Error", upload);
  const complete = page.indexOf("'/api/h3-director/recording-complete'", upload);
  assert.ok(upload >= 0, 'signed upload call is missing');
  assert.ok(uploadFailure > upload, 'signed upload error is not rejected');
  assert.ok(complete > uploadFailure, 'recording must not be finalized after a failed upload');
  assert.match(page, /uploadToSignedUrl\([^\n]+upsert:true/);
  const uploadApi = fs.readFileSync(path.join(root, 'api/h3-director/recording-upload-url.js'), 'utf8');
  assert.match(uploadApi, /createSignedUploadUrl\(path, \{ upsert: true \}\)/);
});

test('Director migration defaults to OFF and limits RPC execution to service role', () => {
  assert.match(migration, /values \('h3_director', false,/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on function public\.reserve_h3_director_session_atomic[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.reserve_h3_director_session_atomic[\s\S]*?to service_role/i);
  assert.match(migration, /grant execute on function public\.deduct_h3_director_credits_atomic[\s\S]*?to service_role/i);
  assert.match(migration, /grant execute on function public\.refund_h3_director_session_atomic[\s\S]*?to service_role/i);
});

test('Director migration enforces one active session and idempotent charge/refund ledgers', () => {
  assert.match(migration, /h3_director_sessions_one_active_user_idx[\s\S]*?where status in \('reserved', 'connecting', 'live'\)/i);
  assert.match(migration, /h3_director_sessions_user_idempotency_idx[\s\S]*?\(user_id, idempotency_key\)/i);
  assert.match(migration, /credit_transactions_h3_director_charge_unique/i);
  assert.match(migration, /credit_transactions_h3_director_refund_unique/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
});

test('fal session response is validated before it is accepted', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key';
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Key test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.app_id, 'minimax/h3-max/director');
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ session_id: 'provider-session', sdp: 'v=0\r\nanswer', type: 'answer' })
    };
  };
  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = previousKey;
  });

  const result = await createDirectorSession({ sdp: 'v=0\r\noffer', type: 'offer' });
  assert.deepEqual(result, {
    ok: true,
    sessionId: 'provider-session',
    sdp: 'v=0\r\nanswer',
    type: 'answer'
  });
});

test('ambiguous provider failures are never treated as safe retries', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.FAL_KEY;
  process.env.FAL_KEY = 'test-key';
  global.fetch = async () => ({
    ok: false,
    status: 503,
    text: async () => 'temporarily unavailable'
  });
  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = previousKey;
  });

  const result = await createDirectorSession({ sdp: 'v=0\r\noffer', type: 'offer' });
  assert.equal(result.ok, false);
  assert.equal(result.ambiguous, true);
});
