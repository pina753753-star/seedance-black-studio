'use strict';

// H3 Max: text mode + a clearly image-dependent instruction, with 0 images
// attached ("画像なし生成事故"). api/h3-live/start.js must stop with 422
// BEFORE entitlement check, moderation, reservation, credit deduction, or
// any fal.ai submit call — this file proves that ordering by execution, not
// just by reading the source.
//
// Uses the exact same require.cache dependency-injection harness as
// tests/h3-max-reference-storyboard.test.js (installMocks/makeFakeDb/req/res/
// makeReserveRpc) so this file exercises ONLY start.js's own new guard
// branch. No real Supabase, no real fal.ai, no real OpenAI moderation call,
// no credits, no Storage writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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

function uuid(n) {
  return `33333333-3333-4333-8333-3333333333${String(n).padStart(2, '0')}`;
}

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
      return makeQuery([]);
    },
    rpc(name, args) { return rpcImpl(name, args); },
    storage: { from() { return { createSignedUrl: async () => ({ data: { signedUrl: 'https://example.test/signed' }, error: null }) }; } }
  };
}

// counters exposed so tests can assert that NOTHING past the new guard ran.
function installMocks() {
  const counters = {
    entitlementCalls: 0,
    textModerationCalls: 0,
    reserveCalls: 0,
    deductCalls: 0,
    submitTextCalls: 0,
    submitImageCalls: 0,
    submitReferenceCalls: 0
  };

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
      isUuid: (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v),
      sanitizeJob: (row) => (row ? { id: row.id, status: row.status, inputMode: row.input_mode } : null)
    }
  };
  const fakeEntitlement = {
    id: entitlementPath, filename: entitlementPath, loaded: true,
    exports: { getH3LiveEntitlement: async () => { counters.entitlementCalls++; return { ok: true, allowed: true, plan: 'premium' }; } }
  };
  const fakeModeration = {
    id: moderationPath, filename: moderationPath, loaded: true,
    exports: {
      moderateH3LiveInstruction: async () => { counters.textModerationCalls++; return { ok: true, allow: true }; }
    }
  };
  const fakeImageModeration = {
    id: imageModerationPath, filename: imageModerationPath, loaded: true,
    exports: {
      moderateH3LiveImageInput: async () => ({ ok: true, allow: true }),
      moderateH3LiveImageOnly: async () => ({ ok: true, allow: true })
    }
  };
  const fakeFal = {
    id: falPath, filename: falPath, loaded: true,
    exports: {
      submitTextJob: async () => { counters.submitTextCalls++; return { ok: true, requestId: 'req-1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' }; },
      submitImageJob: async () => { counters.submitImageCalls++; return { ok: true, requestId: 'req-1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' }; },
      submitReferenceJob: async () => { counters.submitReferenceCalls++; return { ok: true, requestId: 'req-1', statusUrl: 'https://queue.fal.run/s', responseUrl: 'https://queue.fal.run/r' }; }
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
    exports: {
      getUploadRowsOrdered: async () => ({ ok: true, rows: [] }),
      downloadAndValidate: async () => ({ ok: true, buffer: Buffer.from('x'.repeat(100)), contentType: 'image/jpeg' }),
      createModerationSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/mod-signed' }),
      createFalSignedUrl: async () => ({ ok: true, signedUrl: 'https://example.test/fal-signed' }),
      markModeration: async () => true,
      deleteJobReferenceImages: async () => ({ ok: true, deleted: 0 }),
      sweepStaleUploads: async () => ({ ok: true, deleted: 0 })
    }
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

function req({ mode, instruction, idemKey, userId = USER_ID }) {
  const body = { instruction: instruction ?? 'テスト指示', mode };
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

// counters (when passed) is the SAME object installMocks() returned, so
// tests can assert reserveCalls/deductCalls actually incremented (or, for
// the 422 guard, stayed at 0) rather than just asserting against fields that
// are declared but never written to.
function makeReserveRpc({ jobId = uuid(50), jobsRows = null, counters = null } = {}) {
  return async (name, args) => {
    if (name === 'reserve_h3_reference_job_atomic' || name === 'reserve_h3_live_job_atomic') {
      if (counters) counters.reserveCalls++;
      if (jobsRows && !jobsRows.some((r) => r.id === jobId)) {
        jobsRows.push({ id: jobId, user_id: args.p_user_id, status: 'queued', input_mode: args.p_mode || args.p_input_mode || 'text' });
      }
      return { data: [{ job_id: jobId, code: null, retry_after_seconds: 0, existing: false }], error: null };
    }
    if (name === 'deduct_h3_live_credits_atomic') {
      if (counters) counters.deductCalls++;
      return { data: { ok: true, code: 'deducted', deducted: 60, new_balance: 940, from_subscription: 0, from_free: 60, from_purchased: 0 }, error: null };
    }
    return { data: null, error: null };
  };
}

// ---------------------------------------------------------------
// 422 image_required_by_prompt: fires before entitlement/moderation/reserve
// /deduct/fal — proven by call counters, not by reading the source.
// ---------------------------------------------------------------

// Codex-review仕様の正例そのもの(h3-max-beta.htmlのコメントと同一の一覧)。
// 先頭2件は過去の実際の事故で使用された文章そのもの(一般化した短文へ
// 置き換えない)。
const IMAGE_RELIANT_INSTRUCTIONS = [
  '添付画像の女性を主人公にしてください',
  '参照画像の振り返りに近い顔のアップ',
  '添付画像のキャラクター',
  '参照画像の服装を維持',
  'この画像の男性',
  '画像1の髪型',
  '画像１の髪型',
  'Image 1の人物',
  '参照画像を使って',
  '参照画像を基準に',
  '参照画像から始める'
];

for (const instruction of IMAGE_RELIANT_INSTRUCTIONS) {
  test(`text mode + 「${instruction}」+ 画像0件 → 422 image_required_by_prompt、entitlement/moderation/reserve/deduct/fal は一切呼ばれない`, async () => {
    const { handler, counters, restore } = installMocks();
    try {
      const jobsRows = [];
      const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobsRows, counters }) });
      const request = attachDb(req({ mode: 'text', instruction }), db);
      const response = res();
      await handler(request, response);

      assert.equal(response.statusCode, 422, JSON.stringify(response.payload));
      assert.equal(response.payload.error, 'image_required_by_prompt');
      assert.equal(
        response.payload.message,
        'プロンプトが画像を参照しています。画像モードで画像を追加してから生成してください。'
      );

      assert.equal(counters.entitlementCalls, 0, 'entitlement check must not run');
      assert.equal(counters.textModerationCalls, 0, 'moderation must not run');
      // 予約(reserve)・課金(deduct)・fal送信のいずれも、422停止より前に呼ばれ
      // ていないことを実行ベースで確認する(コメント上の主張ではなく、実際に
      // カウンターが加算されていないことで証明する)。
      assert.equal(counters.reserveCalls, 0, 'reserve RPC must not run (no reservation)');
      assert.equal(counters.deductCalls, 0, 'deduct RPC must not run (no charge)');
      assert.equal(counters.submitTextCalls, 0, 'fal submit must not run');
      assert.equal(jobsRows.length, 0, 'no job row must be reserved (no charge)');
    } finally { restore(); }
  });
}

// ---------------------------------------------------------------
// False-positive guard: mere mentions ("〜について説明する"), negated/
// explanatory phrasing, and image/reference modes (where an image really is
// attached), must NOT be blocked.
// ---------------------------------------------------------------

// Codex-review仕様の非対象例そのもの。
const NON_BLOCKING_TEXT_INSTRUCTIONS = [
  'この画像生成AIについて説明する',
  '参照画像について説明する',
  '参照画像を使わない',
  'この画像は不要',
  '画像なしで生成する',
  '画像という文字を表示する',
  '夕暮れの海辺を走る白い馬。カメラは低い位置から横移動で追いかける。',
  '通常のテキストプロンプトです。'
];

for (const instruction of NON_BLOCKING_TEXT_INSTRUCTIONS) {
  test(`text mode + 「${instruction}」→ 422にならず、通常どおりentitlement以降まで進む(reserve/deductも実行される)`, async () => {
    const { handler, counters, restore } = installMocks();
    try {
      const jobsRows = [];
      const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobsRows, counters }) });
      const request = attachDb(req({ mode: 'text', instruction }), db);
      const response = res();
      await handler(request, response);

      assert.notEqual(response.payload && response.payload.error, 'image_required_by_prompt');
      assert.equal(counters.entitlementCalls, 1, 'entitlement check must still run normally');
      // 誤検知していないことの裏付けとして、この経路では実際にreserve/deduct
      // が実行されることも確認する(カウンターが常に0のまま無意味化しないため)。
      assert.equal(counters.reserveCalls, 1, 'reserve RPC must run normally when not blocked');
      assert.equal(counters.deductCalls, 1, 'deduct RPC must run normally when not blocked');
    } finally { restore(); }
  });
}

test('image mode + 画像依存表現でも、mode!==\'text\'なので新しいガードは発火しない(既存の画像モード経路を維持)', async () => {
  const { handler, counters, restore } = installMocks();
  try {
    const jobsRows = [];
    const db = makeFakeDb({ jobsRows, rpcImpl: makeReserveRpc({ jobsRows, counters }) });
    const request = attachDb(
      { ...req({ mode: 'image', instruction: '添付画像の人物' }), body: JSON.stringify({ instruction: '添付画像の人物', mode: 'image', uploadId: uuid(2) }) },
      db
    );
    const response = res();
    await handler(request, response);

    assert.notEqual(response.payload && response.payload.error, 'image_required_by_prompt');
    assert.equal(counters.entitlementCalls, 1, 'image mode with an attached image must proceed normally');
  } finally { restore(); }
});
