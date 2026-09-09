'use strict';

// H3 Max Live: Preview-only relaxation of the kill switch for start-session.js
// and info.js, mirroring the same VERCEL_ENV==='preview' gate already used in
// api/h3-director/image-upload-url.js.
//
// All Supabase/fal/credit interaction here is via the same in-memory mocks
// used by tests/h3-director-image-live.test.js and
// tests/h3-director-failure-injection.test.js (startModule._test.createHandler
// dependency injection) — no real Supabase, no real fal API call, no real
// credits are ever touched by this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.FAL_KEY = process.env.FAL_KEY || 'test-fal-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const startModule = require('../api/h3-director/start-session.js');

const repoRoot = path.join(__dirname, '..');
const infoPath = path.join(repoRoot, 'api', 'h3-director', 'info.js');
const confirmedAuthPath = path.join(repoRoot, 'api', '_lib', 'confirmed-auth.js');
const directorStorePath = path.join(repoRoot, 'api', '_lib', 'h3-director-store.js');
const page = fs.readFileSync(path.join(repoRoot, 'h3-director.html'), 'utf8');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDEM_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function withVercelEnv(value, fn) {
  const prev = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = value;
  return Promise.resolve().then(fn).finally(() => { process.env.VERCEL_ENV = prev; });
}

// ---------------------------------------------------------------
// start-session.js — same DI harness as tests/h3-director-image-live.test.js
// ---------------------------------------------------------------
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
        state.order.push('refund');
        return { data: { ok: true, code: 'refunded', refunded: true }, error: null };
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

test('Preview + Director disabled → start-sessionはkill switch理由では拒否されない', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false })
    }));
    const res = responseRecorder();
    await handler(request(), res);
    assert.notEqual(res.body && res.body.error, 'h3_director_disabled');
    assert.equal(res.statusCode, 200);
    assert.equal(db.state.chargeWrites, 1);
  });
});

test('Production + Director disabled → 従来通りreject', async () => {
  await withVercelEnv('production', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false })
    }));
    const res = responseRecorder();
    await handler(request(), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'h3_director_disabled');
    assert.equal(db.state.chargeWrites, 0);
  });
});

test('Previewでも未ログインはreject', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false }),
      requireConfirmedAuth: async () => ({ ok: false, status: 401, body: { ok: false, error: 'unauthorized' } })
    }));
    const res = responseRecorder();
    await handler(request(), res);
    assert.equal(res.statusCode, 401);
    assert.equal(db.state.chargeWrites, 0);
  });
});

test('Previewでも対象外プランはreject', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false }),
      getDirectorEntitlement: async () => ({ ok: true, allowed: false, accountStatus: 'active', balance: 0 })
    }));
    const res = responseRecorder();
    await handler(request(), res);
    assert.notEqual(res.statusCode, 200);
    assert.equal(db.state.chargeWrites, 0);
  });
});

test('Previewでもaccount inactiveはreject', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false }),
      getDirectorEntitlement: async () => ({ ok: true, allowed: true, accountStatus: 'suspended', balance: 1000 })
    }));
    const res = responseRecorder();
    await handler(request(), res);
    assert.notEqual(res.statusCode, 200);
    assert.equal(db.state.chargeWrites, 0);
  });
});

test('Previewでもprompt moderation失敗はreject（課金前）', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false }),
      moderateDirectorPrompt: async () => ({ ok: true, allow: false, categories: ['violence'] })
    }));
    const res = responseRecorder();
    await handler(request(), res);
    assert.notEqual(res.statusCode, 200);
    assert.equal(db.state.chargeWrites, 0);
  });
});

test('Previewでも画像moderation失敗はreject（課金前・画像削除される）', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeDb();
    let deleted = false;
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false }),
      getUploadRow: async () => ({ ok: true, row: { id: '44444444-4444-4444-8444-444444444444', object_path: 'uploads/x', deleted_at: null, moderation_status: 'pending' } }),
      downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' }),
      createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod' }),
      markModeration: async () => true,
      deleteUploadObject: async () => { deleted = true; return true; },
      moderateImageInput: async () => ({ ok: true, allow: false, source: 'image', categories: ['violence'] })
    }));
    const res = responseRecorder();
    await handler(request({ imageUploadId: '44444444-4444-4444-8444-444444444444' }), res);
    assert.notEqual(res.statusCode, 200);
    assert.equal(db.state.chargeWrites, 0);
    assert.equal(deleted, true);
  });
});

// ---------------------------------------------------------------
// info.js — Preview-only enabled override for the UI gate
// ---------------------------------------------------------------
function loadInfoWithMocks({ control, entitlement, auth }) {
  const fakeConfirmedAuth = {
    id: confirmedAuthPath, filename: confirmedAuthPath, loaded: true,
    exports: { requireConfirmedAuth: async () => auth }
  };
  const fakeDirectorStore = {
    id: directorStorePath, filename: directorStorePath, loaded: true,
    exports: {
      checkDirectorEnabled: async () => control,
      getDirectorEntitlement: async () => entitlement
    }
  };
  const prev = {
    confirmedAuth: require.cache[confirmedAuthPath],
    directorStore: require.cache[directorStorePath]
  };
  require.cache[confirmedAuthPath] = fakeConfirmedAuth;
  require.cache[directorStorePath] = fakeDirectorStore;
  delete require.cache[infoPath];
  const handler = require(infoPath);
  return {
    handler,
    restore() {
      require.cache[confirmedAuthPath] = prev.confirmedAuth;
      require.cache[directorStorePath] = prev.directorStore;
      delete require.cache[infoPath];
    }
  };
}

function fakeGetReqRes() {
  const req = { method: 'GET', headers: {} };
  const res = {
    statusCode: 0, payload: null, setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
  return { req, res };
}

test('info.js: Previewでは開始ボタンを塞がないようenabled=trueを返す', async () => {
  await withVercelEnv('preview', async () => {
    const { handler, restore } = loadInfoWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'active', plan: 'premium', balance: 1000 },
      auth: { ok: true, user: { id: USER_ID }, supabase: {} }
    });
    try {
      const { req, res } = fakeGetReqRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.enabled, true);
    } finally {
      restore();
    }
  });
});

test('info.js: productionでは従来通りenabled=falseのままgateされる', async () => {
  await withVercelEnv('production', async () => {
    const { handler, restore } = loadInfoWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'active', plan: 'premium', balance: 1000 },
      auth: { ok: true, user: { id: USER_ID }, supabase: {} }
    });
    try {
      const { req, res } = fakeGetReqRes();
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.enabled, false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------
// h3-director.html — Preview notice text, and unchanged safety-critical bits
// ---------------------------------------------------------------
test('h3-director.html: Preview注意表示が存在する', () => {
  assert.match(page, /Previewテスト中: Live開始で440 creditsを消費します。/);
});

test('h3-director.html: credit 440 / 60秒 / gate blocked ロジックは無変更', () => {
  assert.match(page, /id="timer">60秒<\/span>/);
  assert.match(
    page,
    /if\(renderAccessGate\(info\)\)\{\s*blocked=true;\s*\$\('action'\)\.disabled=true;\s*return;\s*\}/
  );
});
