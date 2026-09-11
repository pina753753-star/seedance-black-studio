'use strict';

// H3 Max Live: DB-side safety boundary for the Preview-only relaxation.
//
// - reserve_h3_director_session_atomic / deduct_h3_director_credits_atomic
//   gained a service-role-only p_preview_test boolean (default false) so the
//   production kill switch (h3_director_controls.enabled) can stay OFF while
//   Preview alone bypasses it. There is no real Postgres available in this
//   test environment, so the migration's SQL text is asserted the same way
//   tests/h3-director.test.js already asserts migration behavior
//   (regex/source checks) rather than executed.
// - start-session.js / heartbeat.js / approve-prompt.js pass this flag (or
//   apply the same gate) using ONLY process.env.VERCEL_ENV, computed
//   server-side — never from request body/query.
//
// All Supabase/fal calls in this file are in-memory mocks; no real Supabase,
// fal, or credits are touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.FAL_KEY = process.env.FAL_KEY || 'test-fal-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const repoRoot = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(repoRoot, 'supabase/migrations/20260906000000_create_h3_director_slice.sql'), 'utf8'
);
const startModule = require('../api/h3-director/start-session.js');

const confirmedAuthPath = path.join(repoRoot, 'api', '_lib', 'confirmed-auth.js');
const directorStorePath = path.join(repoRoot, 'api', '_lib', 'h3-director-store.js');
const directorConfigPath = path.join(repoRoot, 'api', '_lib', 'h3-director-config.js');
const directorFalPath = path.join(repoRoot, 'api', '_lib', 'h3-director-fal.js');
const heartbeatPath = path.join(repoRoot, 'api', 'h3-director', 'heartbeat.js');
const approvePromptPath = path.join(repoRoot, 'api', 'h3-director', 'approve-prompt.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const IDEM_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function withVercelEnv(value, fn) {
  const prev = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = value;
  return Promise.resolve().then(fn).finally(() => { process.env.VERCEL_ENV = prev; });
}

// ---------------------------------------------------------------
// 1-3. migration SQL text: signatures, default, gate logic, grants
// ---------------------------------------------------------------

test('migration: reserve/deduct RPCがp_preview_test boolean default falseを持つ', () => {
  assert.match(migration, /reserve_h3_director_session_atomic\(\s*p_user_id uuid,\s*p_idempotency_key uuid,\s*p_initial_prompt text,\s*p_offer_fingerprint text,\s*p_aspect_ratio text,\s*p_preview_test boolean default false\s*\)/);
  assert.match(migration, /deduct_h3_director_credits_atomic\(\s*p_session_id uuid,\s*p_user_id uuid,\s*p_preview_test boolean default false\s*\)/);
});

test('migration: h3_director_controls.enabledの初期値falseは変更されていない', () => {
  assert.match(migration, /enabled boolean not null default false/);
  assert.match(migration, /values \('h3_director', false,/i);
});

test('migration: reserveは control=false かつ preview=false のときのみservice_disabled', () => {
  const fn = migration.slice(
    migration.indexOf('create or replace function public.reserve_h3_director_session_atomic'),
    migration.indexOf('revoke all on function public.reserve_h3_director_session_atomic')
  );
  assert.match(
    fn,
    /if coalesce\(v_enabled, false\) is not true\s*\n\s*and coalesce\(p_preview_test, false\) is not true then\s*\n\s*return query select null::uuid, 'service_disabled'::text, false;/
  );
});

test('migration: deductは control=false かつ preview=false のときのみservice_disabled', () => {
  const fn = migration.slice(
    migration.indexOf('create or replace function public.deduct_h3_director_credits_atomic'),
    migration.indexOf('revoke all on function public.deduct_h3_director_credits_atomic')
  );
  assert.match(
    fn,
    /if coalesce\(v_enabled, false\) is not true\s*\n\s*and coalesce\(p_preview_test, false\) is not true then\s*\n[\s\S]*?'code', 'service_disabled'\)/
  );
});

test('migration: 新シグネチャのrevoke/grantがservice_roleのみに限定されている(authenticated/anonへexecuteを与えない)', () => {
  assert.match(
    migration,
    /revoke all on function public\.reserve_h3_director_session_atomic\(uuid, uuid, text, text, text, boolean\)\s*\n\s*from public, anon, authenticated, service_role;\s*\n\s*grant execute on function public\.reserve_h3_director_session_atomic\(uuid, uuid, text, text, text, boolean\)\s*\n\s*to service_role;/
  );
  assert.match(
    migration,
    /revoke all on function public\.deduct_h3_director_credits_atomic\(uuid, uuid, boolean\)\s*\n\s*from public, anon, authenticated, service_role;\s*\n\s*grant execute on function public\.deduct_h3_director_credits_atomic\(uuid, uuid, boolean\)\s*\n\s*to service_role;/
  );
  // No stray grant to anon/authenticated anywhere for these two functions.
  assert.doesNotMatch(migration, /grant execute on function public\.reserve_h3_director_session_atomic[\s\S]*?to (anon|authenticated)/i);
  assert.doesNotMatch(migration, /grant execute on function public\.deduct_h3_director_credits_atomic[\s\S]*?to (anon|authenticated)/i);
});

test('migration: refund_h3_director_session_atomicのシグネチャ・冪等性ロジックは無変更', () => {
  assert.match(migration, /refund_h3_director_session_atomic\(\s*p_session_id uuid,\s*p_error_code text,\s*p_error_message text\s*\)/);
  assert.match(migration, /already_refunded/);
});

// ---------------------------------------------------------------
// 4-5 (partial). start-session.js: p_preview_test is server-computed only
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
    from(table) { assert.equal(table, 'h3_director_sessions'); return query(); },
    async rpc(name, args) {
      if (name === 'reserve_h3_director_session_atomic') {
        state.order.push({ rpc: name, args });
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
        state.order.push({ rpc: name, args });
        state.session.charged_at = new Date().toISOString();
        state.balance -= 440;
        state.chargeWrites += 1;
        return { data: { ok: true, code: 'deducted', new_balance: state.balance }, error: null };
      }
      if (name === 'refund_h3_director_session_atomic') {
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

test('start-session: preview中はreserve/deduct両方のRPCへp_preview_test=trueが渡る', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db, {
      checkDirectorEnabled: async () => ({ ok: false })
    }));
    const res = responseRecorder();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    const reserveCall = db.state.order.find((o) => o.rpc === 'reserve_h3_director_session_atomic');
    const deductCall = db.state.order.find((o) => o.rpc === 'deduct_h3_director_credits_atomic');
    assert.equal(reserveCall.args.p_preview_test, true);
    assert.equal(deductCall.args.p_preview_test, true);
  });
});

test('start-session: productionではreserve/deduct両方のRPCへp_preview_test=falseが渡る', async () => {
  await withVercelEnv('production', async () => {
    const db = makeDb();
    const handler = startModule._test.createHandler(baseDeps(db));
    const res = responseRecorder();
    await handler(request(), res);
    assert.equal(res.statusCode, 200);
    const reserveCall = db.state.order.find((o) => o.rpc === 'reserve_h3_director_session_atomic');
    const deductCall = db.state.order.find((o) => o.rpc === 'deduct_h3_director_credits_atomic');
    assert.equal(reserveCall.args.p_preview_test, false);
    assert.equal(deductCall.args.p_preview_test, false);
  });
});

test('start-session: preview判定はrequest bodyのpreview系フィールドを一切見ない', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'api', 'h3-director', 'start-session.js'), 'utf8');
  assert.doesNotMatch(source, /body\.preview/i);
  assert.doesNotMatch(source, /req\.(query|headers)\.preview/i);
  assert.match(source, /process\.env\.VERCEL_ENV === 'preview'/);
});

// ---------------------------------------------------------------
// 7-8. heartbeat.js
// ---------------------------------------------------------------

function makeSessionDb(initial) {
  let current = { ...initial };
  return {
    get current() { return current; },
    from(table) {
      assert.equal(table, 'h3_director_sessions');
      const filters = [];
      let update = null;
      const q = {
        select() { return q; },
        eq(col, val) { filters.push(['eq', col, val]); return q; },
        in(col, vals) { filters.push(['in', col, vals]); return q; },
        update(data) { update = data; return q; },
        async maybeSingle() {
          const matched = filters.every(([op, col, val]) => (op === 'eq' ? current[col] === val : val.includes(current[col])));
          if (!matched) return { data: null, error: null };
          if (update) Object.assign(current, update);
          return { data: { ...current }, error: null };
        },
        then(resolve, reject) {
          try {
            const matched = filters.every(([op, col, val]) => (op === 'eq' ? current[col] === val : val.includes(current[col])));
            if (matched && update) Object.assign(current, update);
            return Promise.resolve({ data: matched ? [{ ...current }] : [], error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        }
      };
      return q;
    }
  };
}

function loadHeartbeatWithMocks({ control, entitlement, upstream }) {
  const fakeConfirmedAuth = {
    id: confirmedAuthPath, filename: confirmedAuthPath, loaded: true,
    exports: { requireConfirmedAuth: async (req) => req._auth }
  };
  const fakeDirectorStore = {
    id: directorStorePath, filename: directorStorePath, loaded: true,
    exports: {
      jsonBody: (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})),
      isUuid: (v) => /^[0-9a-f-]{36}$/.test(String(v || '')),
      publicSession: (row) => ({ id: row.id, status: row.status }),
      checkDirectorEnabled: async () => control,
      getDirectorEntitlement: async () => entitlement
    }
  };
  const fakeDirectorFal = {
    id: directorFalPath, filename: directorFalPath, loaded: true,
    exports: { heartbeatDirectorSession: async () => upstream }
  };
  const fakeDirectorConfig = {
    id: directorConfigPath, filename: directorConfigPath, loaded: true,
    exports: { ALLOWED_PLANS: ['premium', 'scale', 'team', 'ultimate'] }
  };
  const prev = {
    confirmedAuth: require.cache[confirmedAuthPath],
    directorStore: require.cache[directorStorePath],
    directorFal: require.cache[directorFalPath],
    directorConfig: require.cache[directorConfigPath]
  };
  require.cache[confirmedAuthPath] = fakeConfirmedAuth;
  require.cache[directorStorePath] = fakeDirectorStore;
  require.cache[directorFalPath] = fakeDirectorFal;
  require.cache[directorConfigPath] = fakeDirectorConfig;
  delete require.cache[heartbeatPath];
  const handler = require(heartbeatPath);
  return {
    handler,
    restore() {
      require.cache[confirmedAuthPath] = prev.confirmedAuth;
      require.cache[directorStorePath] = prev.directorStore;
      require.cache[directorFalPath] = prev.directorFal;
      require.cache[directorConfigPath] = prev.directorConfig;
      delete require.cache[heartbeatPath];
    }
  };
}

function heartbeatReqRes(db) {
  const req = {
    method: 'POST', headers: {}, body: JSON.stringify({ sessionId: SESSION_ID }),
    _auth: { ok: true, user: { id: USER_ID }, supabase: db }
  };
  const res = {
    statusCode: 0, payload: null, setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; }
  };
  return { req, res };
}

test('heartbeat: Preview + disabled → kill switchだけを理由にセッション終了しない', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeSessionDb({
      id: SESSION_ID, user_id: USER_ID, status: 'live', provider_session_id: 'fal-1',
      expires_at: new Date(Date.now() + 60000).toISOString(), heartbeat_count: 0
    });
    const { handler, restore } = loadHeartbeatWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'active' },
      upstream: { ok: true, alive: true }
    });
    try {
      const { req, res } = heartbeatReqRes(db);
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.alive, true);
      assert.equal(db.current.status, 'live');
    } finally { restore(); }
  });
});

test('heartbeat: Production + disabled → 従来通り拒否しセッションを終了する', async () => {
  await withVercelEnv('production', async () => {
    const db = makeSessionDb({
      id: SESSION_ID, user_id: USER_ID, status: 'live', provider_session_id: 'fal-1',
      expires_at: new Date(Date.now() + 60000).toISOString(), heartbeat_count: 0
    });
    const { handler, restore } = loadHeartbeatWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'active' },
      upstream: { ok: true, alive: true }
    });
    try {
      const { req, res } = heartbeatReqRes(db);
      await handler(req, res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.error, 'access_revoked');
      assert.equal(db.current.status, 'completed');
    } finally { restore(); }
  });
});

test('heartbeat: Previewでもaccount inactiveは拒否される', async () => {
  await withVercelEnv('preview', async () => {
    const db = makeSessionDb({
      id: SESSION_ID, user_id: USER_ID, status: 'live', provider_session_id: 'fal-1',
      expires_at: new Date(Date.now() + 60000).toISOString(), heartbeat_count: 0
    });
    const { handler, restore } = loadHeartbeatWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'suspended' },
      upstream: { ok: true, alive: true }
    });
    try {
      const { req, res } = heartbeatReqRes(db);
      await handler(req, res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.error, 'account_restricted');
    } finally { restore(); }
  });
});

// ---------------------------------------------------------------
// 9-10. approve-prompt.js
// ---------------------------------------------------------------

function loadApprovePromptWithMocks({ control, entitlement, moderation }) {
  const fakeConfirmedAuth = {
    id: confirmedAuthPath, filename: confirmedAuthPath, loaded: true,
    exports: { requireConfirmedAuth: async (req) => req._auth }
  };
  const fakeDirectorStore = {
    id: directorStorePath, filename: directorStorePath, loaded: true,
    exports: {
      jsonBody: (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})),
      isUuid: (v) => /^[0-9a-f-]{36}$/.test(String(v || '')),
      checkDirectorEnabled: async () => control,
      getDirectorEntitlement: async () => entitlement
    }
  };
  const moderationPath = path.join(repoRoot, 'api', '_lib', 'h3-director-moderation.js');
  const fakeModeration = {
    id: moderationPath, filename: moderationPath, loaded: true,
    exports: { moderateDirectorPrompt: async () => moderation }
  };
  const fakeDirectorConfig = {
    id: directorConfigPath, filename: directorConfigPath, loaded: true,
    exports: { PROMPT_MAX_CHARS: 2000, ALLOWED_PLANS: ['premium', 'scale', 'team', 'ultimate'] }
  };
  const prev = {
    confirmedAuth: require.cache[confirmedAuthPath],
    directorStore: require.cache[directorStorePath],
    moderation: require.cache[moderationPath],
    directorConfig: require.cache[directorConfigPath]
  };
  require.cache[confirmedAuthPath] = fakeConfirmedAuth;
  require.cache[directorStorePath] = fakeDirectorStore;
  require.cache[moderationPath] = fakeModeration;
  require.cache[directorConfigPath] = fakeDirectorConfig;
  delete require.cache[approvePromptPath];
  const handler = require(approvePromptPath);
  return {
    handler,
    restore() {
      require.cache[confirmedAuthPath] = prev.confirmedAuth;
      require.cache[directorStorePath] = prev.directorStore;
      require.cache[moderationPath] = prev.moderation;
      require.cache[directorConfigPath] = prev.directorConfig;
      delete require.cache[approvePromptPath];
    }
  };
}

function approvePromptDb(session) {
  return {
    from(table) {
      assert.equal(table, 'h3_director_sessions');
      const filters = [];
      let update = null;
      let selectCols = null;
      const q = {
        select(cols) { selectCols = cols; return q; },
        eq(col, val) { filters.push(['eq', col, val]); return q; },
        in(col, vals) { filters.push(['in', col, vals]); return q; },
        update(data) { update = data; return q; },
        async maybeSingle() {
          const matched = filters.every(([op, col, val]) => (op === 'eq' ? session[col] === val : val.includes(session[col])));
          if (!matched) return { data: null, error: null };
          return { data: { ...session }, error: null };
        },
        then(resolve, reject) {
          try {
            const matched = filters.every(([op, col, val]) => (op === 'eq' ? session[col] === val : val.includes(session[col])));
            if (matched && update) Object.assign(session, update);
            return Promise.resolve({ data: matched ? [{ prompt_version: session.prompt_version }] : [], error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        }
      };
      return q;
    }
  };
}

function approvePromptReqRes(db, body) {
  const req = {
    method: 'POST', headers: {}, body: JSON.stringify(Object.assign({ sessionId: SESSION_ID, prompt: 'next scene' }, body || {})),
    _auth: { ok: true, user: { id: USER_ID }, supabase: db }
  };
  const res = {
    statusCode: 0, payload: null, setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; }
  };
  return { req, res };
}

test('approve-prompt: Preview + disabled → kill switchだけを理由に拒否しない', async () => {
  await withVercelEnv('preview', async () => {
    const session = { id: SESSION_ID, user_id: USER_ID, status: 'live', prompt_version: 1, expires_at: new Date(Date.now() + 60000).toISOString() };
    const db = approvePromptDb(session);
    const { handler, restore } = loadApprovePromptWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'active' },
      moderation: { ok: true, allow: true }
    });
    try {
      const { req, res } = approvePromptReqRes(db);
      await handler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.payload.promptVersion, 2);
    } finally { restore(); }
  });
});

test('approve-prompt: Production + disabled → 従来通り拒否', async () => {
  await withVercelEnv('production', async () => {
    const session = { id: SESSION_ID, user_id: USER_ID, status: 'live', prompt_version: 1, expires_at: new Date(Date.now() + 60000).toISOString() };
    const db = approvePromptDb(session);
    const { handler, restore } = loadApprovePromptWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'active' },
      moderation: { ok: true, allow: true }
    });
    try {
      const { req, res } = approvePromptReqRes(db);
      await handler(req, res);
      assert.equal(res.statusCode, 403);
      assert.equal(res.payload.error, 'access_revoked');
    } finally { restore(); }
  });
});

test('approve-prompt: Previewでもprompt moderation拒否は維持される', async () => {
  await withVercelEnv('preview', async () => {
    const session = { id: SESSION_ID, user_id: USER_ID, status: 'live', prompt_version: 1, expires_at: new Date(Date.now() + 60000).toISOString() };
    const db = approvePromptDb(session);
    const { handler, restore } = loadApprovePromptWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: true, accountStatus: 'active' },
      moderation: { ok: true, allow: false }
    });
    try {
      const { req, res } = approvePromptReqRes(db);
      await handler(req, res);
      assert.equal(res.statusCode, 422);
      assert.equal(res.payload.error, 'content_not_allowed');
      assert.equal(session.prompt_version, 1);
    } finally { restore(); }
  });
});

test('approve-prompt: Previewでも対象外プラン・account inactiveは拒否される', async () => {
  await withVercelEnv('preview', async () => {
    const session = { id: SESSION_ID, user_id: USER_ID, status: 'live', prompt_version: 1, expires_at: new Date(Date.now() + 60000).toISOString() };
    const db = approvePromptDb(session);
    const { handler, restore } = loadApprovePromptWithMocks({
      control: { ok: false },
      entitlement: { ok: true, allowed: false, accountStatus: 'active' },
      moderation: { ok: true, allow: true }
    });
    try {
      const { req, res } = approvePromptReqRes(db);
      await handler(req, res);
      assert.notEqual(res.statusCode, 200);
    } finally { restore(); }
  });
});

// ---------------------------------------------------------------
// Fixed constants / moderation ordering unaffected
// ---------------------------------------------------------------

test('440 credits / 60秒 / moderation順序は今回の変更で無変更', () => {
  const configSource = fs.readFileSync(path.join(repoRoot, 'api', '_lib', 'h3-director-config.js'), 'utf8');
  assert.match(configSource, /CREDIT_COST = 440/);
  assert.match(configSource, /DURATION_SECONDS = 60/);
  const startSource = fs.readFileSync(path.join(repoRoot, 'api', 'h3-director', 'start-session.js'), 'utf8');
  // moderation (image or prompt) must still appear strictly before the reserve RPC call.
  const moderationIdx = Math.max(
    startSource.indexOf('deps.moderateImageInput('),
    startSource.indexOf('deps.moderateDirectorPrompt(')
  );
  const reserveIdx = startSource.indexOf("db.rpc('reserve_h3_director_session_atomic'");
  assert.ok(moderationIdx > 0 && reserveIdx > moderationIdx, 'moderation must run before the reserve RPC');
});
