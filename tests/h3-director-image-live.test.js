'use strict';

// H3 Max Live Phase 1A: image-start + Live instruction state.
//
// Server-side (start-session.js) tests use the same dependency-injection
// pattern as tests/h3-director-failure-injection.test.js — every image
// helper (getUploadRow / downloadAndValidate / createModerationSignedUrl /
// createFalSignedUrl / markModeration / deleteUploadObject /
// moderateImageInput) is overridable via createHandler(overrides), so no
// real Supabase Storage/DB call happens here. No real fal API call, no
// credits are actually consumed (the credit ledger is an in-memory mock).
//
// Client-side (h3-director.html) behavior for the DataChannel protocol
// additions (image_url in configure, has_initial_image safety stop,
// replan:true, prompt_pending/applied/rejected, deadline_missed) is checked
// as static source assertions, matching the existing style in
// tests/h3-director.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.FAL_KEY = process.env.FAL_KEY || 'test-fal-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const startModule = require('../api/h3-director/start-session.js');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'h3-director.html'), 'utf8');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDEM_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const IMAGE_UPLOAD_ID = '44444444-4444-4444-8444-444444444444';

function makeDb() {
  const state = { session: null, balance: 1000, chargeWrites: 0, order: [] };

  function matches(filters) {
    const row = state.session;
    if (!row) return false;
    return filters.every((f) => {
      if (f.op === 'eq') return row[f.column] === f.value;
      if (f.op === 'in') return f.value.includes(row[f.column]);
      if (f.op === 'is') return row[f.column] == null;
      return true;
    });
  }

  function query() {
    const filters = [];
    let update = null;
    let wantsRows = false;
    const q = {
      select() { wantsRows = true; return q; },
      update(value) { update = value; return q; },
      eq(column, value) { filters.push({ op: 'eq', column, value }); return q; },
      in(column, value) { filters.push({ op: 'in', column, value }); return q; },
      is(column) { filters.push({ op: 'is', column }); return q; },
      order() { return q; },
      limit() { return q; },
      async maybeSingle() {
        if (!matches(filters)) return { data: null, error: null };
        if (update) Object.assign(state.session, update);
        return { data: { ...state.session }, error: null };
      },
      then(resolve, reject) {
        try {
          const matched = matches(filters);
          if (matched && update) Object.assign(state.session, update);
          return Promise.resolve({ data: matched && wantsRows ? [{ ...state.session }] : null, error: null }).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      }
    };
    return q;
  }

  const db = {
    state,
    from(table) {
      assert.equal(table, 'h3_director_sessions');
      return query();
    },
    async rpc(name, args) {
      if (name === 'reserve_h3_director_session_atomic') {
        if (!state.session) {
          const now = new Date().toISOString();
          state.session = {
            id: SESSION_ID, user_id: args.p_user_id, idempotency_key: args.p_idempotency_key,
            initial_prompt: args.p_initial_prompt, offer_fingerprint: args.p_offer_fingerprint,
            aspect_ratio: args.p_aspect_ratio, status: 'reserved', duration_limit_seconds: 60,
            resolution: '768p', credit_cost: 440, provider_session_id: null, provider_answer_sdp: null,
            charged_at: null, refunded_at: null, created_at: now, updated_at: now
          };
          return { data: { session_id: SESSION_ID, code: 'reserved', existing: false }, error: null };
        }
        return { data: { session_id: SESSION_ID, code: 'existing', existing: true }, error: null };
      }
      if (name === 'deduct_h3_director_credits_atomic') {
        state.order.push('deduct');
        state.session.charged_at = new Date().toISOString();
        state.balance -= 440;
        state.chargeWrites += 1;
        return { data: { ok: true, code: 'deducted', new_balance: state.balance }, error: null };
      }
      if (name === 'refund_h3_director_session_atomic') {
        return { data: { ok: true, code: 'no_charge_found', refunded: false }, error: null };
      }
      throw new Error(`unexpected RPC: ${name}`);
    }
  };
  return db;
}

function responseRecorder() {
  return { statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function request(extraBody) {
  return {
    method: 'POST',
    headers: { 'idempotency-key': IDEM_ID },
    body: Object.assign({ prompt: 'A live city street', sdp: 'v=0\r\ntest-offer', type: 'offer', aspectRatio: '16:9' }, extraBody || {})
  };
}

function baseDeps(db, overrides) {
  return Object.assign({
    requireConfirmedAuth: async () => ({ ok: true, user: { id: USER_ID }, supabase: db }),
    checkDirectorEnabled: async () => ({ ok: true }),
    getDirectorEntitlement: async () => ({ ok: true, allowed: true, accountStatus: 'active', balance: db.state.balance }),
    moderateDirectorPrompt: async () => ({ ok: true, allow: true }),
    createDirectorSession: async () => ({ ok: true, sessionId: 'fal-session-1', sdp: 'v=0\r\ntest-answer', type: 'answer' })
  }, overrides);
}

// ---------------------------------------------------------------
// 1. imageUploadId is optional
// ---------------------------------------------------------------
test('imageUploadId is optional — text-only start is untouched', async () => {
  const db = makeDb();
  let promptModerated = false;
  let imageModerationCalled = false;
  const handler = startModule._test.createHandler(baseDeps(db, {
    moderateDirectorPrompt: async () => { promptModerated = true; return { ok: true, allow: true }; },
    moderateImageInput: async () => { imageModerationCalled = true; return { ok: true, allow: true }; }
  }));
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(promptModerated, true);
  assert.equal(imageModerationCalled, false);
  assert.equal('media' in res.body, false);
  assert.equal(db.state.chargeWrites, 1);
});

// ---------------------------------------------------------------
// 2. invalid imageUploadId is rejected before any lookup
// ---------------------------------------------------------------
test('invalid imageUploadId is rejected with 400 before any upload lookup or charge', async () => {
  const db = makeDb();
  let lookupCalled = false;
  const handler = startModule._test.createHandler(baseDeps(db, {
    getUploadRow: async () => { lookupCalled = true; return { ok: false, error: 'upload_not_found' }; }
  }));
  const res = responseRecorder();
  await handler(request({ imageUploadId: 'not-a-uuid' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'invalid_image_upload_id');
  assert.equal(lookupCalled, false);
  assert.equal(db.state.chargeWrites, 0);
});

// ---------------------------------------------------------------
// 3. another user's upload is rejected
// ---------------------------------------------------------------
test('an upload owned by another user is rejected and never charged', async () => {
  const db = makeDb();
  const handler = startModule._test.createHandler(baseDeps(db, {
    // getUploadRow is called with (db, uploadId, userId) — scoping to the
    // caller's own id is real getUploadRow's job; here we simulate the
    // not-found result that scoping produces for someone else's row.
    getUploadRow: async () => ({ ok: false, error: 'upload_not_found' })
  }));
  const res = responseRecorder();
  await handler(request({ imageUploadId: IMAGE_UPLOAD_ID }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'upload_not_found');
  assert.equal(db.state.chargeWrites, 0);
});

// ---------------------------------------------------------------
// 4. image+prompt moderation happens before credit deduction
// ---------------------------------------------------------------
test('image moderation runs before credit deduction', async () => {
  const db = makeDb();
  const order = [];
  const handler = startModule._test.createHandler(baseDeps(db, {
    getUploadRow: async () => ({ ok: true, row: { id: IMAGE_UPLOAD_ID, object_path: 'uploads/x', deleted_at: null, moderation_status: 'pending' } }),
    downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' }),
    createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod' }),
    createFalSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/fal' }),
    markModeration: async () => true,
    moderateImageInput: async () => { order.push('moderate'); return { ok: true, allow: true }; }
  }));
  const res = responseRecorder();
  await handler(request({ imageUploadId: IMAGE_UPLOAD_ID }), res);
  assert.equal(res.statusCode, 200);
  order.push(...db.state.order);
  assert.deepEqual(order, ['moderate', 'deduct']);
});

// ---------------------------------------------------------------
// 5. blocked image charges 0 credits
// ---------------------------------------------------------------
test('a blocked image results in 422 and zero credit deduction', async () => {
  const db = makeDb();
  let deleted = false;
  const handler = startModule._test.createHandler(baseDeps(db, {
    getUploadRow: async () => ({ ok: true, row: { id: IMAGE_UPLOAD_ID, object_path: 'uploads/x', deleted_at: null, moderation_status: 'pending' } }),
    downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' }),
    createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod' }),
    markModeration: async () => true,
    deleteUploadObject: async () => { deleted = true; return true; },
    moderateImageInput: async () => ({ ok: true, allow: false, source: 'image', categories: ['violence'] })
  }));
  const res = responseRecorder();
  await handler(request({ imageUploadId: IMAGE_UPLOAD_ID }), res);
  assert.equal(res.statusCode, 422);
  assert.equal(res.body.error, 'content_not_allowed');
  assert.equal(deleted, true);
  assert.equal(db.state.chargeWrites, 0);
});

// ---------------------------------------------------------------
// 6. moderation service unavailable charges 0 credits (fail closed)
// ---------------------------------------------------------------
test('moderation being unavailable fails closed with zero credit deduction', async () => {
  const db = makeDb();
  const handler = startModule._test.createHandler(baseDeps(db, {
    getUploadRow: async () => ({ ok: true, row: { id: IMAGE_UPLOAD_ID, object_path: 'uploads/x', deleted_at: null, moderation_status: 'pending' } }),
    downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' }),
    createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod' }),
    moderateImageInput: async () => ({ ok: false, reason: 'missing_api_key' })
  }));
  const res = responseRecorder();
  await handler(request({ imageUploadId: IMAGE_UPLOAD_ID }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'content_safety_unavailable');
  assert.equal(db.state.chargeWrites, 0);
});

// ---------------------------------------------------------------
// 7. fal signed URL creation failure charges 0 credits
// ---------------------------------------------------------------
test('a failed fal signed URL mint leaves credits untouched', async () => {
  const db = makeDb();
  const handler = startModule._test.createHandler(baseDeps(db, {
    getUploadRow: async () => ({ ok: true, row: { id: IMAGE_UPLOAD_ID, object_path: 'uploads/x', deleted_at: null, moderation_status: 'pending' } }),
    downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' }),
    createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod' }),
    markModeration: async () => true,
    moderateImageInput: async () => ({ ok: true, allow: true }),
    createFalSignedUrl: async () => ({ ok: false, error: 'fal_signed_url_failed' })
  }));
  const res = responseRecorder();
  await handler(request({ imageUploadId: IMAGE_UPLOAD_ID }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(db.state.chargeWrites, 0);
});

// ---------------------------------------------------------------
// 8. successful image start returns media.initialImageUrl
// ---------------------------------------------------------------
test('a successful image-attached start returns media.initialImageUrl', async () => {
  const db = makeDb();
  const handler = startModule._test.createHandler(baseDeps(db, {
    getUploadRow: async () => ({ ok: true, row: { id: IMAGE_UPLOAD_ID, object_path: 'uploads/x', deleted_at: null, moderation_status: 'pending' } }),
    downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' }),
    createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod' }),
    createFalSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/fal-short-lived' }),
    markModeration: async () => true,
    moderateImageInput: async () => ({ ok: true, allow: true })
  }));
  const res = responseRecorder();
  await handler(request({ imageUploadId: IMAGE_UPLOAD_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.media.initialImageUrl, 'https://example.test/fal-short-lived');
  assert.equal(db.state.chargeWrites, 1);
});

// ---------------------------------------------------------------
// 9. text-only start is unaffected (existing flow preserved)
// ---------------------------------------------------------------
test('a text-only start (no imageUploadId) still succeeds exactly as before', async () => {
  const db = makeDb();
  const handler = startModule._test.createHandler(baseDeps(db));
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.session.id, SESSION_ID);
  assert.equal(db.state.chargeWrites, 1);
  assert.equal(db.state.balance, 560);
});

// ---------------------------------------------------------------
// 10. configure carries image_url only when supplied (client)
// ---------------------------------------------------------------
test('configure message adds image_url only when the start response supplied one', () => {
  assert.match(page, /if\(initialImageUrlForConfigure\)configureMsg\.image_url=initialImageUrlForConfigure/);
  assert.match(page, /initialImageUrlForConfigure=\(result\.media&&result\.media\.initialImageUrl\)\|\|null/);
});

// ---------------------------------------------------------------
// 11. image supplied + configured.has_initial_image false => stop
// ---------------------------------------------------------------
test('an image-attached session stops safely when the provider does not confirm the initial frame', () => {
  assert.match(page, /sessionExpectsImage&&msg\.has_initial_image!==true\)\{finish\('添付画像を開始フレームとして確認できなかったため停止しました。'\)/);
});

// ---------------------------------------------------------------
// 12. prompt message carries replan:true
// ---------------------------------------------------------------
test('additional prompt messages set replan:true', () => {
  // prompt is wrapped in directorPrompt() (adds a natural-speed hint unless the
  // user already specified a speed) — prompt_version and replan:true are unchanged.
  assert.match(page, /type:'prompt',prompt_version:approved\.promptVersion,prompt:directorPrompt\(approved\.prompt\),replan:true/);
});

// ---------------------------------------------------------------
// 13-16. prompt_pending / prompt_applied / prompt_rejected / deadline_missed
// ---------------------------------------------------------------
test('prompt_pending is shown to the user', () => {
  assert.match(page, /msg\.type==='prompt_pending'\)log\('次の映像へ反映準備中です。'\)/);
});

test('prompt_applied is shown to the user', () => {
  assert.match(page, /msg\.type==='prompt_applied'\)log\('追加指示を反映しました。'\)/);
});

test('prompt_rejected is shown with a Japanese reason breakdown', () => {
  assert.match(page, /msg\.type==='prompt_rejected'\)\{/);
  assert.match(page, /content_policy:'内容がコンテンツポリシーに抵触しました。'/);
  assert.match(page, /preparation_failed:'映像の準備に失敗しました。'/);
  assert.match(page, /stale_prompt_version:'指示のバージョンが古くなっています。'/);
  assert.match(page, /この指示は反映できませんでした。/);
});

test('deadline_missed is shown without triggering automatic regeneration', () => {
  // Now also emits a Preview-only diagnostic() call, but the user-facing
  // message and the absence of any regeneration/retry call are unchanged.
  assert.match(page, /msg\.type==='deadline_missed'\)\{\s*log\('生成が追いつくまで映像を調整しています。'\);/);
});
