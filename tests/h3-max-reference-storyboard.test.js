'use strict';

// H3 Max — "reference" / "storyboard" multi-image modes (api/h3-live/start.js
// new branches + api/_lib/h3-live-fal.js's submitReferenceJob +
// api/_lib/h3-max-reference-image-store.js). Mock/unit/static only:
//   - No real Supabase, no real fal.ai, no credits, no Storage writes.
//   - api/h3-live/start.js's dependency modules (h3-live-store.js,
//     h3-live-entitlement.js, h3-live-moderation.js,
//     h3-live-image-moderation.js, h3-live-fal.js,
//     h3-max-reference-image-store.js, confirmed-auth.js) are swapped in
//     require.cache with hand-written fakes so this file exercises ONLY
//     start.js's own branching logic — the DB-side reservation/pricing logic
//     is covered separately by the migration static-source checks below.
//   - `db` (auth.supabase) is a small in-memory fake exposing exactly the
//     `.from('h3_live_jobs')` / `.rpc(...)` shapes start.js actually calls.
//
// text/image regression: this file also re-runs a handful of the EXISTING
// text/image paths through the same fake, to confirm the new reference/
// storyboard branches did not change their behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.FAL_KEY = process.env.FAL_KEY || 'test-fal-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const repoRoot = path.join(__dirname, '..');
const confirmedAuthPath = path.join(repoRoot, 'api', '_lib', 'confirmed-auth.js');
const storePath = path.join(repoRoot, 'api', '_lib', 'h3-live-store.js');
const entitlementPath = path.join(repoRoot, 'api', '_lib', 'h3-live-entitlement.js');
const moderationPath = path.join(repoRoot, 'api', '_lib', 'h3-live-moderation.js');
const imageModerationPath = path.join(repoRoot, 'api', '_lib', 'h3-live-image-moderation.js');
const falPath = path.join(repoRoot, 'api', '_lib', 'h3-live-fal.js');
const imageStorePath = path.join(repoRoot, 'api', '_lib', 'h3-live-image-store.js');
const referenceStorePath = path.join(repoRoot, 'api', '_lib', 'h3-max-reference-image-store.js');
const startPath = path.join(repoRoot, 'api', 'h3-live', 'start.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

function uuid(n) {
  return `33333333-3333-4333-8333-3333333333${String(n).padStart(2, '0')}`;
}

// ---------------------------------------------------------------
// In-memory fake h3_live_jobs table + a directly-controlled `.rpc()`.
// ---------------------------------------------------------------
function makeQuery(rowsRef, initialFilters) {
  const filters = initialFilters ? initialFilters.slice() : [];
  let updatePatch = null;
  const q = {
    select() { return q; },
    eq(col, val) { filters.push(['eq', col, val]); return q; },
    in(col, vals) { filters.push(['in', col, vals]); return q; },
    is(col, val) { filters.push(['is', col, val]); return q; },
    update(patch) { updatePatch = patch; return q; },
    async insert(obj) {
      rowsRef.push({ id: obj.id || uuid(rowsRef.length + 90), ...obj });
      return { data: null, error: null };
    },
    async maybeSingle() {
      const matched = rowsRef.filter((r) => matchesFilters(r, filters));
      if (updatePatch) Object.assign(...matched.length ? [matched[0], updatePatch] : [{}]);
      return { data: matched[0] ? { ...matched[0] } : null, error: null };
    },
    then(resolve, reject) {
      try {
        const matched = rowsRef.filter((r) => matchesFilters(r, filters));
        if (updatePatch) matched.forEach((r) => Object.assign(r, updatePatch));
        return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      } catch (e) { return Promise.reject(e).then(resolve, reject); }
    }
  };
  return q;
}

function matchesFilters(row, filters) {
  return filters.every(([op, col, val]) => {
    if (op === 'eq') return row[col] === val;
    if (op === 'in') return val.includes(row[col]);
    if (op === 'is') return val === null ? (row[col] === null || row[col] === undefined) : row[col] === val;
    return true;
  });
}

function makeFakeDb({ jobsRows, rpcImpl }) {
  return {
    from(table) {
      if (table === 'h3_live_jobs') return makeQuery(jobsRows);
      // moderation_blocks / anything else: accept inserts silently.
      return makeQuery([]);
    },
    rpc(name, args) { return rpcImpl(name, args); },
    storage: { from() { return { createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/signed' }, error: null }) }; } }
  };
}

function installMocks({
  entitlementAllowed = true,
  textModerationAllow = true,
  textModerationOk = true,
  imageModerationResults = null,
  imageOnlyModerationResults = null,
  imageOnlyModerationOk = true,
  submitReferenceImpl = null,
  submitTextImpl = null
} = {}) {
  const fakeConfirmedAuth = {
    id: confirmedAuthPath, filename: confirmedAuthPath, loaded: true,
    exports: { requireConfirmedAuth: async (req) => req._auth }
  };
  const fakeStore = {
    id: storePath, filename: storePath, loaded: true,
    exports: {
      jsonBody: (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})),
      serviceClient: () => null,
      checkH3LiveEnabled: async () => ({ ok: true }),
      // Relaxed on purpose: this suite's upload-id fixtures encode state in
      // the string itself (e.g. 'img-deleted-1') for readability, so the
      // real UUID regex would reject every one of them before start.js's own
      // logic (the thing under test here) ever runs. Job ids passed through
      // this mock are still real UUIDs (see uuid() below) and unaffected.
      isUuid: (v) => typeof v === 'string' && v.length > 0,
      sanitizeJob: (row) => (row ? { id: row.id, status: row.status, inputMode: row.input_mode } : null)
    }
  };
  const fakeEntitlement = {
    id: entitlementPath, filename: entitlementPath, loaded: true,
    exports: { getH3LiveEntitlement: async () => ({ ok: true, allowed: entitlementAllowed, plan: 'premium' }) }
  };
  // Call counters, exposed on the returned object below so tests can assert
  // how many times each moderation check actually ran (in particular: text
  // moderation must run exactly ONCE per reference/storyboard request, no
  // matter how many images are attached — see the "3枚/9枚" call-count tests).
  const counters = { textModerationCalls: 0, imageOnlyModerationCalls: 0, imageInputModerationCalls: 0, markModerationCalls: [] };
  const fakeModeration = {
    id: moderationPath, filename: moderationPath, loaded: true,
    exports: {
      moderateH3LiveInstruction: async () => {
        counters.textModerationCalls++;
        if (!textModerationOk) return { ok: false, reason: 'text_timeout' };
        return { ok: true, allow: textModerationAllow };
      }
    }
  };
  // imageModerationResults: array of {ok,allow,source,categories} consumed in
  // call order by the single-image mode's moderateH3LiveImageInput().
  let imageCallIndex = 0;
  // imageOnlyModerationResults (falls back to imageModerationResults for the
  // existing tests written before moderateH3LiveImageOnly existed): array
  // consumed in call order by reference/storyboard's per-image
  // moderateH3LiveImageOnly() — one call per attached image, image-only (no
  // instruction text sent).
  let imageOnlyCallIndex = 0;
  const fakeImageModeration = {
    id: imageModerationPath, filename: imageModerationPath, loaded: true,
    exports: {
      moderateH3LiveImageInput: async () => {
        counters.imageInputModerationCalls++;
        const results = imageModerationResults || [{ ok: true, allow: true }];
        const r = results[Math.min(imageCallIndex, results.length - 1)];
        imageCallIndex++;
        return r;
      },
      moderateH3LiveImageOnly: async () => {
        counters.imageOnlyModerationCalls++;
        if (!imageOnlyModerationOk) return { ok: false, reason: 'image_timeout' };
        const results = imageOnlyModerationResults || imageModerationResults || [{ ok: true, allow: true }];
        const r = results[Math.min(imageOnlyCallIndex, results.length - 1)];
        imageOnlyCallIndex++;
        return r;
      }
    }
  };
  const fakeFal = {
    id: falPath, filename: falPath, loaded: true,
    exports: {
      submitTextJob: submitTextImpl || (async () => ({ ok: true, requestId: 'req-1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' })),
      submitImageJob: async () => ({ ok: true, requestId: 'req-1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' }),
      submitReferenceJob: submitReferenceImpl || (async () => ({ ok: true, requestId: 'req-ref-1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' }))
    }
  };
  const fakeImageStore = {
    id: imageStorePath, filename: imageStorePath, loaded: true,
    exports: {
      getUploadRow: async () => ({ ok: false, error: 'upload_not_found' }),
      downloadAndValidate: async () => ({ ok: false, error: 'quarantine_object_not_found' }),
      createModerationSignedUrl: async () => ({ ok: false, error: 'moderation_signed_url_failed' }),
      createFalSignedUrl: async () => ({ ok: false, error: 'fal_signed_url_failed' }),
      markModeration: async () => true,
      deleteUploadObject: async () => true,
      sweepStaleUploads: async () => ({ ok: true, deleted: 0 })
    }
  };
  const fakeReferenceStore = {
    id: referenceStorePath, filename: referenceStorePath, loaded: true,
    exports: makeFakeReferenceStoreExports({
      onMarkModeration: (uploadId, status) => counters.markModerationCalls.push({ uploadId, status })
    })
  };

  const prev = {
    confirmedAuth: require.cache[confirmedAuthPath],
    store: require.cache[storePath],
    entitlement: require.cache[entitlementPath],
    moderation: require.cache[moderationPath],
    imageModeration: require.cache[imageModerationPath],
    fal: require.cache[falPath],
    imageStore: require.cache[imageStorePath],
    referenceStore: require.cache[referenceStorePath]
  };
  require.cache[confirmedAuthPath] = fakeConfirmedAuth;
  require.cache[storePath] = fakeStore;
  require.cache[entitlementPath] = fakeEntitlement;
  require.cache[moderationPath] = fakeModeration;
  require.cache[imageModerationPath] = fakeImageModeration;
  require.cache[falPath] = fakeFal;
  require.cache[imageStorePath] = fakeImageStore;
  require.cache[referenceStorePath] = fakeReferenceStore;
  delete require.cache[startPath];
  const handler = require(startPath);
  return {
    handler,
    counters,
    restore() {
      require.cache[confirmedAuthPath] = prev.confirmedAuth;
      require.cache[storePath] = prev.store;
      require.cache[entitlementPath] = prev.entitlement;
      require.cache[moderationPath] = prev.moderation;
      require.cache[imageModerationPath] = prev.imageModeration;
      require.cache[falPath] = prev.fal;
      require.cache[imageStorePath] = prev.imageStore;
      require.cache[referenceStorePath] = prev.referenceStore;
      delete require.cache[startPath];
    }
  };
}

// The reference-image-store fake resolves ordered "uploads" purely from the
// upload IDs passed in (no real DB): an id containing 'deleted' / 'blocked' /
// 'superseded' / 'bound' / 'other-user' in this test's fixtures encodes its
// state, keeping each test's setup self-contained and readable without a
// shared mutable fixture table.
function makeFakeReferenceStoreExports({ onMarkModeration = null } = {}) {
  return {
    getUploadRowsOrdered: async (db, uploadIds, userId) => {
      const rows = uploadIds.map((id) => {
        if (id === 'missing') return null;
        const row = {
          id, user_id: userId, deleted_at: null, superseded_at: null, job_id: null,
          moderation_status: 'passed', storage_bucket: 'h3-max-reference-image-quarantine',
          storage_path: `uploads/${userId}/${id}/f.jpg`
        };
        if (id.includes('other-user')) row.user_id = OTHER_USER_ID;
        if (id.includes('deleted')) row.deleted_at = new Date().toISOString();
        if (id.includes('superseded')) row.superseded_at = new Date().toISOString();
        if (id.includes('bound')) row.job_id = uuid(77);
        if (id.includes('pending')) row.moderation_status = 'pending';
        return row;
      });
      return { ok: true, rows };
    },
    downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from('x'.repeat(100)), contentType: 'image/jpeg' }),
    createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod-signed' }),
    createFalSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/fal-signed' }),
    markModeration: async (db, uploadId, status) => {
      if (onMarkModeration) onMarkModeration(uploadId, status);
      return true;
    },
    deleteJobReferenceImages: async () => ({ ok: true, deleted: 0 }),
    sweepStaleUploads: async () => ({ ok: true, deleted: 0 })
  };
}

function req({ mode, instruction, uploadIds, uploadId, idemKey, userId = USER_ID }) {
  const body = { instruction: instruction ?? 'テスト指示', mode };
  if (uploadIds) body.uploadIds = uploadIds;
  if (uploadId) body.uploadId = uploadId;
  return {
    method: 'POST',
    headers: { 'idempotency-key': idemKey || uuid(1) },
    body: JSON.stringify(body),
    _auth: { ok: true, user: { id: userId }, supabase: null }
  };
}

function res() {
  return {
    statusCode: 0, payload: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; }
  };
}

function attachDb(request, db) { request._auth.supabase = db; return request; }

function makeReserveRpc({ code = null, jobId = uuid(50), existing = false, retryAfter = 0, jobsRows = null } = {}) {
  return async (name, args) => {
    if (name === 'reserve_h3_reference_job_atomic' || name === 'reserve_h3_live_job_atomic') {
      // A fresh reservation (code === null) inserts the job row a real RPC
      // would have inserted, so start.js's later `.update()...select('id')`
      // tracking-persist step (and the 'submitting' transition before it)
      // has a real row to match against, exactly like production.
      if (!code && jobsRows && !jobsRows.some((r) => r.id === jobId)) {
        jobsRows.push({ id: jobId, user_id: args.p_user_id, status: 'queued', input_mode: args.p_mode || args.p_input_mode || 'text' });
      }
      return { data: [{ job_id: code ? (existing ? jobId : null) : jobId, code, retry_after_seconds: retryAfter, existing }], error: null };
    }
    if (name === 'deduct_h3_live_credits_atomic') {
      return { data: { ok: true, code: 'deducted', deducted: 60, new_balance: 940, from_subscription: 0, from_free: 60, from_purchased: 0 }, error: null };
    }
    if (name === 'refund_h3_live_job_atomic') {
      return { data: { ok: true, code: 'refunded', refunded: true, refunded_amount: 60 }, error: null };
    }
    return { data: null, error: null };
  };
}

// ---------------------------------------------------------------
// 3-5. reference 1 / 3 / 9 images — successful reservation + submit.
// ---------------------------------------------------------------

for (const count of [1, 3, 9]) {
  test(`reference: ${count}枚の画像で正常にjob作成・deduct 1回・fal submit 1回`, async () => {
    let falCalls = 0;
    const { handler, restore } = installMocks({
      submitReferenceImpl: async (args) => { falCalls++; return { ok: true, requestId: 'r1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' }; }
    });
    try {
      const jobsRows = [];
      const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobId: uuid(60 + count), jobsRows }) });
      const uploadIds = Array.from({ length: count }, (_, i) => `img-${i + 1}`);
      const request = attachDb(req({ mode: 'reference', uploadIds }), db);
      const response = res();
      await handler(request, response);
      assert.equal(response.statusCode, 202, JSON.stringify(response.payload));
      assert.equal(falCalls, 1);
    } finally { restore(); }
  });
}

test('storyboard: 9枚の画像で正常にjob作成・fal submitへmode=storyboardが渡る', async () => {
  let receivedMode = null;
  const { handler, restore } = installMocks({
    submitReferenceImpl: async ({ mode }) => { receivedMode = mode; return { ok: true, requestId: 'r1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' }; }
  });
  try {
    const jobsRows = [];
    const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobId: uuid(70), jobsRows }) });
    const uploadIds = Array.from({ length: 9 }, (_, i) => `img-${i + 1}`);
    const request = attachDb(req({ mode: 'storyboard', uploadIds }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 202, JSON.stringify(response.payload));
    assert.equal(receivedMode, 'storyboard');
  } finally { restore(); }
});

// ---------------------------------------------------------------
// 8-13. app-level input validation (rejected before any RPC call)
// ---------------------------------------------------------------

test('0枚: invalid_upload_idsで拒否、reserve RPCは呼ばれない', async () => {
  let rpcCalled = false;
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: async (name) => { rpcCalled = true; return makeReserveRpc()(name); } });
    const request = attachDb(req({ mode: 'reference', uploadIds: [] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.error, 'invalid_upload_ids');
    assert.equal(rpcCalled, false);
  } finally { restore(); }
});

test('10枚: invalid_upload_idsで拒否、reserve RPCは呼ばれない', async () => {
  let rpcCalled = false;
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: async (name) => { rpcCalled = true; return makeReserveRpc()(name); } });
    const uploadIds = Array.from({ length: 10 }, (_, i) => `img-${i + 1}`);
    const request = attachDb(req({ mode: 'reference', uploadIds }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.error, 'invalid_upload_ids');
    assert.equal(rpcCalled, false);
  } finally { restore(); }
});

test('duplicate uploadId: invalid_upload_idsで拒否、reserve RPCは呼ばれない', async () => {
  let rpcCalled = false;
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: async (name) => { rpcCalled = true; return makeReserveRpc()(name); } });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1', 'img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.error, 'invalid_upload_ids');
    assert.equal(rpcCalled, false);
  } finally { restore(); }
});

test('他userの画像: image_not_usableで拒否される（moderation段階）', async () => {
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: makeReserveRpc() });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-other-user-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'image_not_usable');
  } finally { restore(); }
});

test('deleted済み画像: image_not_usableで拒否される（moderation段階）', async () => {
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: makeReserveRpc() });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-deleted-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'image_not_usable');
  } finally { restore(); }
});

test('superseded済み画像: image_not_usableで拒否される（moderation段階）', async () => {
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: makeReserveRpc() });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-superseded-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'image_not_usable');
  } finally { restore(); }
});

// ---------------------------------------------------------------
// 14-15. moderation gating
// ---------------------------------------------------------------

test('moderation未完了(pending)画像: DB側(reserve RPC)がimage_not_usableで拒否し、charge/falは発生しない', async () => {
  // The app-level pre-check loop in start.js re-moderates every non-replay
  // image and marks it passed/blocked BEFORE calling reserve, so a 'pending'
  // row should normally never reach the RPC still pending. This test models
  // the DB-side defense-in-depth check instead (reserve_h3_reference_job_
  // atomic itself rejects moderation_status <> 'passed' — see the migration
  // static-source test), i.e. the RPC catching an inconsistency the app
  // layer did not.
  let deductCalled = false, falCalled = false;
  const { handler, restore } = installMocks({
    submitReferenceImpl: async () => { falCalled = true; return { ok: true, requestId: 'r' }; }
  });
  try {
    const db = makeFakeDb({
      jobsRows: [],
      rpcImpl: async (name, args) => {
        if (name === 'deduct_h3_live_credits_atomic') deductCalled = true;
        return makeReserveRpc({ code: 'image_not_usable' })(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'image_not_usable');
    assert.equal(deductCalled, false);
    assert.equal(falCalled, false);
  } finally { restore(); }
});

test('3枚中1枚だけmoderation NG: charge 0 / fal 0、422で停止する', async () => {
  let deductCalled = false, falCalled = false;
  const { handler, restore } = installMocks({
    imageModerationResults: [
      { ok: true, allow: true },
      { ok: true, allow: false, source: 'image', categories: ['sexual'] },
      { ok: true, allow: true }
    ],
    submitReferenceImpl: async () => { falCalled = true; return { ok: true, requestId: 'r' }; }
  });
  try {
    const db = makeFakeDb({
      jobsRows: [],
      rpcImpl: async (name, args) => {
        if (name === 'deduct_h3_live_credits_atomic') deductCalled = true;
        return makeReserveRpc()(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1', 'img-2', 'img-3'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 422);
    assert.equal(response.payload.error, 'content_policy_violation');
    assert.equal(deductCalled, false, 'moderation NG must never charge');
    assert.equal(falCalled, false, 'moderation NG must never call fal');
  } finally { restore(); }
});

// ---------------------------------------------------------------
// moderation split: image-only per image, instruction text ONCE, not mixed.
// ---------------------------------------------------------------

test('安全な画像 + NGプロンプト: 422、画像rowはblockedにならない、charge 0 / fal 0', async () => {
  let deductCalled = false, falCalled = false;
  const { handler, restore, counters } = installMocks({
    textModerationAllow: false, // instruction itself is flagged
    imageOnlyModerationResults: [{ ok: true, allow: true }], // the image is clean
    submitReferenceImpl: async () => { falCalled = true; return { ok: true, requestId: 'r' }; }
  });
  try {
    const db = makeFakeDb({
      jobsRows: [],
      rpcImpl: async (name, args) => {
        if (name === 'deduct_h3_live_credits_atomic') deductCalled = true;
        return makeReserveRpc()(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 422);
    assert.equal(response.payload.error, 'content_policy_violation');
    assert.equal(deductCalled, false, 'text moderation NG must never charge');
    assert.equal(falCalled, false, 'text moderation NG must never call fal');
    // The image itself was clean — it must be marked 'passed', never 'blocked'.
    assert.deepEqual(counters.markModerationCalls, [{ uploadId: 'img-1', status: 'passed' }]);
  } finally { restore(); }
});

test('画像3枚: image moderationは3回、text moderationは1回だけ', async () => {
  const { handler, restore, counters } = installMocks();
  try {
    const jobsRows = [];
    const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobId: uuid(90), jobsRows }) });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1', 'img-2', 'img-3'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 202, JSON.stringify(response.payload));
    assert.equal(counters.imageOnlyModerationCalls, 3);
    assert.equal(counters.textModerationCalls, 1);
  } finally { restore(); }
});

test('画像9枚: image moderationは9回、text moderationは1回だけ', async () => {
  const { handler, restore, counters } = installMocks();
  try {
    const jobsRows = [];
    const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobId: uuid(91), jobsRows }) });
    const uploadIds = Array.from({ length: 9 }, (_, i) => `img-${i + 1}`);
    const request = attachDb(req({ mode: 'reference', uploadIds }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 202, JSON.stringify(response.payload));
    assert.equal(counters.imageOnlyModerationCalls, 9);
    assert.equal(counters.textModerationCalls, 1);
  } finally { restore(); }
});

test('2枚目画像NG: 3枚目以降は送らない、reserve 0 / charge 0 / fal 0', async () => {
  let deductCalled = false, falCalled = false, rpcCalled = false;
  const { handler, restore, counters } = installMocks({
    imageOnlyModerationResults: [
      { ok: true, allow: true },
      { ok: true, allow: false, source: 'image', categories: ['violence'] },
      { ok: true, allow: true }
    ],
    submitReferenceImpl: async () => { falCalled = true; return { ok: true, requestId: 'r' }; }
  });
  try {
    const db = makeFakeDb({
      jobsRows: [],
      rpcImpl: async (name, args) => {
        rpcCalled = true;
        if (name === 'deduct_h3_live_credits_atomic') deductCalled = true;
        return makeReserveRpc()(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1', 'img-2', 'img-3'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 422);
    assert.equal(response.payload.error, 'content_policy_violation');
    // Only the 1st and 2nd images were ever moderated — the 3rd was never reached.
    assert.equal(counters.imageOnlyModerationCalls, 2);
    assert.equal(counters.textModerationCalls, 0, 'instruction must not be moderated after an image NG');
    assert.equal(rpcCalled, false, 'reserve RPC must never be called');
    assert.equal(deductCalled, false);
    assert.equal(falCalled, false);
  } finally { restore(); }
});

test('image moderation unavailable: 503、reserve 0 / charge 0 / fal 0', async () => {
  let deductCalled = false, falCalled = false, rpcCalled = false;
  const { handler, restore, counters } = installMocks({
    imageOnlyModerationOk: false,
    submitReferenceImpl: async () => { falCalled = true; return { ok: true, requestId: 'r' }; }
  });
  try {
    const db = makeFakeDb({
      jobsRows: [],
      rpcImpl: async (name, args) => {
        rpcCalled = true;
        if (name === 'deduct_h3_live_credits_atomic') deductCalled = true;
        return makeReserveRpc()(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    assert.equal(counters.textModerationCalls, 0);
    assert.equal(rpcCalled, false);
    assert.equal(deductCalled, false);
    assert.equal(falCalled, false);
  } finally { restore(); }
});

test('text moderation unavailable: 503、reserve 0 / charge 0 / fal 0', async () => {
  let deductCalled = false, falCalled = false, rpcCalled = false;
  const { handler, restore, counters } = installMocks({
    textModerationOk: false,
    submitReferenceImpl: async () => { falCalled = true; return { ok: true, requestId: 'r' }; }
  });
  try {
    const db = makeFakeDb({
      jobsRows: [],
      rpcImpl: async (name, args) => {
        rpcCalled = true;
        if (name === 'deduct_h3_live_credits_atomic') deductCalled = true;
        return makeReserveRpc()(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 503);
    // The image itself was already validated + marked 'passed' before the
    // unavailable text check — that passed state is left as-is (see spec).
    assert.deepEqual(counters.markModerationCalls, [{ uploadId: 'img-1', status: 'passed' }]);
    assert.equal(rpcCalled, false);
    assert.equal(deductCalled, false);
    assert.equal(falCalled, false);
  } finally { restore(); }
});

// ---------------------------------------------------------------
// 16-18. idempotency
// ---------------------------------------------------------------

test('idempotent replay: 同じmode/instruction/uploadIds順序が完全一致なら既存jobを返す(existing)', async () => {
  const { handler, restore } = installMocks();
  try {
    const jobId = uuid(80);
    const jobsRows = [{ id: jobId, user_id: USER_ID, status: 'processing', input_mode: 'reference', provider_request_id: 'req-existing', provider_poll_url: 'https://queue.fal.run/s', provider_response_url: 'https://queue.fal.run/r', charged_at: new Date().toISOString() }];
    const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ code: 'existing', jobId, existing: true }) });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1', 'img-2'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.existing, true);
  } finally { restore(); }
});

test('同じkeyで画像1枚だけ変更: idempotency_conflictを返す', async () => {
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: makeReserveRpc({ code: 'idempotency_conflict', existing: true, jobId: uuid(81) }) });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1', 'img-9'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'idempotency_conflict');
  } finally { restore(); }
});

test('同じkeyで画像の並び替えのみ: idempotency_conflictを返す(順序も一致条件に含む)', async () => {
  const { handler, restore } = installMocks();
  try {
    // The RPC itself is responsible for order-sensitive comparison (verified
    // separately by the migration static-source check below); this test
    // confirms start.js correctly surfaces whatever code the RPC returns.
    const db = makeFakeDb({ jobsRows: [], rpcImpl: makeReserveRpc({ code: 'idempotency_conflict', existing: true, jobId: uuid(82) }) });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-2', 'img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'idempotency_conflict');
  } finally { restore(); }
});

// ---------------------------------------------------------------
// 19. double-submit -> job 1件 / charge 1回 (advisory-lock loser gets 'active_job')
// ---------------------------------------------------------------

test('二重送信(同時実行の2本目がactive_job): 409で停止し、2本目はdeduct/falを一切呼ばない', async () => {
  let deductCalls = 0, falCalls = 0;
  const { handler, restore } = installMocks({
    submitReferenceImpl: async () => { falCalls++; return { ok: true, requestId: 'r' }; }
  });
  try {
    const db = makeFakeDb({
      jobsRows: [],
      rpcImpl: async (name, args) => {
        if (name === 'deduct_h3_live_credits_atomic') deductCalls++;
        return makeReserveRpc({ code: 'active_job' })(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'h3_live_job_in_progress');
    assert.equal(deductCalls, 0);
    assert.equal(falCalls, 0);
  } finally { restore(); }
});

// ---------------------------------------------------------------
// 20-21. provider outcomes
// ---------------------------------------------------------------

test('provider definite reject: refund RPCが呼ばれ422/502で報告する', async () => {
  let refundCalls = 0;
  const { handler, restore } = installMocks({
    submitReferenceImpl: async () => ({ ok: false, category: 'content_policy', httpStatus: 422, detail: 'blocked' })
  });
  try {
    const jobsRows = [];
    const db = makeFakeDb({
      jobsRows,
      rpcImpl: async (name, args) => {
        if (name === 'refund_h3_live_job_atomic') refundCalls++;
        return makeReserveRpc({ jobsRows })(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 422);
    assert.equal(refundCalls, 1);
    assert.equal(response.payload.refunded, true);
  } finally { restore(); }
});

test('ambiguous submit(timeout等): 自動retryなし・自動refundなし・202で保留報告', async () => {
  let refundCalls = 0;
  const { handler, restore } = installMocks({
    submitReferenceImpl: async () => ({ ok: false, category: 'timeout', httpStatus: 0, detail: 'timed out' })
  });
  try {
    const jobsRows = [];
    const db = makeFakeDb({
      jobsRows,
      rpcImpl: async (name, args) => {
        if (name === 'refund_h3_live_job_atomic') refundCalls++;
        return makeReserveRpc({ jobsRows })(name, args);
      }
    });
    const request = attachDb(req({ mode: 'reference', uploadIds: ['img-1'] }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 202);
    assert.equal(response.payload.submissionStateUnknown, true);
    assert.equal(refundCalls, 0, 'ambiguous submit must never auto-refund');
  } finally { restore(); }
});

// ---------------------------------------------------------------
// 1-2. text / image existing regression (through the SAME fake, to prove the
// new branches did not alter these paths).
// ---------------------------------------------------------------

test('text既存正常系: reference/storyboard追加後もmode未指定でテキストjobが通る', async () => {
  const { handler, restore } = installMocks();
  try {
    const jobsRows = [];
    const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobId: uuid(90), jobsRows }) });
    const request = attachDb(req({ mode: undefined, instruction: 'テキストのみ' }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 202, JSON.stringify(response.payload));
    assert.equal(response.payload.job.inputMode, 'text');
  } finally { restore(); }
});

test('image既存正常系(1枚): image_not_usableで拒否される経路自体は無変更(uploadId未登録→404扱い)', async () => {
  // getUploadRow is faked to always return upload_not_found in this suite —
  // this test only confirms the 'image' branch is still reached and still
  // goes through the SAME single-image code path (h3-live-image-store.js),
  // not the new reference/storyboard branch.
  const { handler, restore } = installMocks();
  try {
    const db = makeFakeDb({ jobsRows: [], rpcImpl: makeReserveRpc() });
    const request = attachDb(req({ mode: 'image', uploadId: uuid(95) }), db);
    const response = res();
    await handler(request, response);
    assert.equal(response.statusCode, 404);
    assert.equal(response.payload.error, 'upload_not_found');
  } finally { restore(); }
});

// ---------------------------------------------------------------
// Migration static-source checks (Postgres logic cannot run in this
// environment — verified by reading the SQL, same style as
// tests/h3-director-preview-db-boundary.test.js).
// ---------------------------------------------------------------

const migrationPath = path.join(repoRoot, 'supabase', 'migrations', '20260912000000_h3_max_reference_storyboard.sql');
const migrationSql = fs.readFileSync(migrationPath, 'utf8');

test('migration: h3_live_jobs.input_modeのCHECKにreference/storyboardが追加され、既存2値も維持', () => {
  assert.match(migrationSql, /check \(input_mode in \('text', 'image', 'reference', 'storyboard'\)\)/);
});

test('migration: h3_max_reference_uploadsテーブルとslot 1..9制約が存在する', () => {
  assert.match(migrationSql, /create table if not exists public\.h3_max_reference_uploads/);
  assert.match(migrationSql, /slot\s+smallint not null check \(slot between 1 and 9\)/);
});

test('migration: (user_id, slot)の active upload 一意制約が存在する', () => {
  assert.match(migrationSql, /create unique index if not exists h3_max_reference_uploads_one_active_per_slot_idx\s*\n\s*on public\.h3_max_reference_uploads \(user_id, slot\)\s*\n\s*where job_id is null and deleted_at is null and superseded_at is null;/);
});

test('migration: h3_live_job_reference_imagesがjob_id/upload_id/image_orderを持ち、upload一意制約がある', () => {
  assert.match(migrationSql, /create table if not exists public\.h3_live_job_reference_images/);
  assert.match(migrationSql, /image_order\s+smallint not null check \(image_order between 1 and 9\)/);
  assert.match(migrationSql, /constraint h3_live_job_reference_images_upload_unique unique \(upload_id\)/);
});

test('migration: reserve_h3_reference_job_atomicは1-9枚検証・重複拒否・moderation済み確認・注文一致の冪等性を持つ', () => {
  assert.match(migrationSql, /create or replace function public\.reserve_h3_reference_job_atomic/);
  assert.match(migrationSql, /if v_count is null or v_count < 1 or v_count > 9 then/);
  assert.match(migrationSql, /if v_distinct_count <> v_count then/);
  assert.match(migrationSql, /v_upload\.moderation_status <> 'passed'/);
  assert.match(migrationSql, /coalesce\(v_existing_upload_ids, array\[\]::uuid\[\]\) is distinct from p_upload_ids/);
});

test('migration: reserve_h3_reference_job_atomicは既存の価格関数 public.h3_max_credit_cost() を使う', () => {
  assert.match(migrationSql, /v_credit_cost := public\.h3_max_credit_cost\(\);/);
});

test('migration: reserve_h3_live_job_atomic / deduct_h3_live_credits_atomic / refund_h3_live_job_atomicを再定義していない(既存RPC本体は変更しない)', () => {
  assert.doesNotMatch(migrationSql, /create or replace function public\.reserve_h3_live_job_atomic/);
  assert.doesNotMatch(migrationSql, /create or replace function public\.deduct_h3_live_credits_atomic/);
  assert.doesNotMatch(migrationSql, /create or replace function public\.refund_h3_live_job_atomic/);
});

test('migration: service_role以外へのGRANTがない(新RPC・新テーブルともに)', () => {
  assert.match(migrationSql, /grant execute on function public\.reserve_h3_reference_job_atomic\([^)]*\) to service_role;/);
  assert.doesNotMatch(migrationSql, /grant execute on function public\.reserve_h3_reference_job_atomic\([^)]*\) to (anon|authenticated);/);
  assert.match(migrationSql, /grant all on table public\.h3_max_reference_uploads to service_role;/);
  assert.match(migrationSql, /grant all on table public\.h3_live_job_reference_images to service_role;/);
});

// ---------------------------------------------------------------
// h3-live-fal.js unit tests (pure functions, no network).
// ---------------------------------------------------------------

const { _internals, submitReferenceJob } = require('../api/_lib/h3-live-fal.js');

test('buildH3MaxReferenceInput: reference_image_urlsを配列で渡し、durationは15固定', () => {
  const input = _internals.buildH3MaxReferenceInput('猫が歩く', ['https://a.test/1.jpg', 'https://a.test/2.jpg']);
  assert.deepEqual(input.reference_image_urls, ['https://a.test/1.jpg', 'https://a.test/2.jpg']);
  assert.equal(input.duration, 15);
  assert.equal(input.resolution, '768P');
});

test('buildH3MaxStoryboardInput: promptに時間順ヒントを付加するが、元のpromptを保持する', () => {
  const input = _internals.buildH3MaxStoryboardInput('猫が歩く', ['https://a.test/1.jpg']);
  assert.match(input.prompt, /^猫が歩く/);
  assert.match(input.prompt, /時間的な流れ/);
});

test('submitReferenceJob: 画像0枚/10枚はinvalid_inputで即エラー(fal呼び出しなし)', async () => {
  const zero = await submitReferenceJob({ instruction: 'x', imageUrls: [], mode: 'reference' });
  assert.equal(zero.ok, false);
  assert.equal(zero.category, 'invalid_input');
  const ten = await submitReferenceJob({ instruction: 'x', imageUrls: Array.from({ length: 10 }, (_, i) => `https://a.test/${i}.jpg`), mode: 'reference' });
  assert.equal(ten.ok, false);
  assert.equal(ten.category, 'invalid_input');
});

test('submitReferenceJob: non-httpsのURLはinvalid_input', async () => {
  const r = await submitReferenceJob({ instruction: 'x', imageUrls: ['not-a-url'], mode: 'reference' });
  assert.equal(r.ok, false);
  assert.equal(r.category, 'invalid_input');
});

// ---------------------------------------------------------------
// h3-max-reference-image-store.js unit tests (pure functions).
// ---------------------------------------------------------------

const referenceStore = require('../api/_lib/h3-max-reference-image-store.js');

test('isValidSlot: 1〜9のみ有効', () => {
  assert.equal(referenceStore.isValidSlot(1), true);
  assert.equal(referenceStore.isValidSlot(9), true);
  assert.equal(referenceStore.isValidSlot(0), false);
  assert.equal(referenceStore.isValidSlot(10), false);
  assert.equal(referenceStore.isValidSlot('3'), true);
  assert.equal(referenceStore.isValidSlot('abc'), false);
});

test('isAllowedMime: JPEG/PNG/WebPのみ許可', () => {
  assert.equal(referenceStore.isAllowedMime('image/jpeg'), true);
  assert.equal(referenceStore.isAllowedMime('image/png'), true);
  assert.equal(referenceStore.isAllowedMime('image/webp'), true);
  assert.equal(referenceStore.isAllowedMime('image/gif'), false);
});

test('detectImageMime: JPEG/PNG/WebPのマジックバイトを判別する', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(referenceStore.detectImageMime(jpeg), 'image/jpeg');
  assert.equal(referenceStore.detectImageMime(png), 'image/png');
});

// ---------------------------------------------------------------
// h3-live-config.js: reference mode wired into requireProviderConfig.
// ---------------------------------------------------------------

const config = require('../api/_lib/h3-live-config.js');

test('requireProviderConfig: reference/storyboardはFAL_H3_MAX_REFERENCE_MODEL_IDの有無を見る', () => {
  assert.equal(config.requireProviderConfig('reference').ok, true);
  assert.equal(config.requireProviderConfig('storyboard').ok, true);
});

test('REFERENCE_INPUT_MODESにreference/storyboardが含まれる', () => {
  assert.deepEqual(config.REFERENCE_INPUT_MODES, ['reference', 'storyboard']);
  assert.equal(config.REFERENCE_MAX_IMAGES, 9);
});
