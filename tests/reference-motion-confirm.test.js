'use strict';
// confirm-upload with the motion profile: the real handler in a vm with a fake table, storage and inspector.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('../api/_lib/reference-dance.js');
const api = fs.readFileSync(path.join(__dirname, '../api/reference-dance-confirm-upload.js'), 'utf8');
const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';
const ASSET = '270bf01a-bafd-4255-8ad5-e18a4f1c8c47';
const { klingDance } = lib;

function inspected(overrides = {}, motion = {}) {
  return {
    ok: true, inspectorProfile: 'motion-v1',
    approvedPath: lib.approvedPath(USER, ASSET),
    reviewPaths: Array.from({ length: 5 }, (_, i) => lib.reviewFramePath(USER, ASSET, i + 1)),
    sizeBytes: 1000, durationMs: 16200, width: 1280, height: 720, fps: 30, videoCodec: 'h264', sha256: 'a'.repeat(64),
    motion: { mode: 'whole', useSeconds: null, capped: false, sourceDurationMs: 16200, masterDurationMs: 16200, ...motion },
    ...overrides
  };
}

function setup({ row = {}, upstream = inspected(), upstreamStatus = 200, flagged = false, claimRows = 1, enabled = true, master = 'yes' } = {}) {
  klingDance.config.maxUseSeconds = enabled ? 20 : 10;
  const table = {
    id: ASSET, user_id: USER, status: 'uploading', staging_path: lib.stagingPath(USER, ASSET),
    used_at: null, expires_at: new Date(Date.now() + 3600e3).toISOString(), updated_at: new Date(Date.now() - 60e3).toISOString(),
    duration_ms: 16200, billable_seconds: 17,
    // a ready row sealed by the motion pipeline carries the marker (a Seedance one does not: pass inspection_error: null)
    ...(row.status === 'ready' ? { inspection_error: 'MOTION_MASTER' } : {}), ...row
  };
  const lists = [];
  const updates = [], workerRequests = [], removals = [], claims = [];
  const db = {
    from() {
      const filters = []; let patch = null;
      const matches = () => filters.every(f => f(table));
      const chain = {
        select() { return chain; },
        eq(k, v) { filters.push(r => r[k] === v); return chain; },
        is(k, v) { filters.push(r => r[k] === v); return chain; },
        gt(k, v) { filters.push(r => String(r[k]) > String(v)); return chain; },
        lt(k, v) { filters.push(r => String(r[k]) < String(v)); return chain; },
        update(v) { patch = v; return chain; },
        maybeSingle() { return Promise.resolve({ data: { ...table }, error: null }); },
        then(resolve, reject) {
          if (patch) {
            const isRecutClaim = patch.status === 'checking' && table.status === 'ready';
            if (isRecutClaim && claimRows === 0) return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            const ok = matches();
            if (ok) { updates.push({ ...patch }); Object.assign(table, patch); if (isRecutClaim) claims.push({ ...patch }); }
            return Promise.resolve({ data: ok ? [{ id: ASSET, expires_at: table.expires_at }] : [], error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [{ ...table }], error: null }).then(resolve, reject);
        }
      };
      return chain;
    },
    async rpc() { table.status = 'checking'; return { data: { ok: true, code: 'claimed' }, error: null }; },
    storage: { from() { return {
      async createSignedUrl() { return { data: { signedUrl: 'https://mock.invalid/x' }, error: null }; },
      async createSignedUploadUrl(p) { return { data: { token: 'tok-' + p }, error: null }; },
      async list(dir, opts) { lists.push({ dir, opts }); if (master === 'error') return { data: null, error: { message: 'x' } }; return { data: master === 'yes' ? [{ name: ASSET + '.mp4' }, { name: 'other.mp4' }] : [{ name: 'other.mp4' }], error: null }; },
      async remove(paths) { removals.push(...paths); return { error: null }; }
    }; } }
  };
  const module = { exports: {} };
  vm.runInNewContext(api, { module, Buffer, Date, AbortController, setTimeout, clearTimeout, URL,
    console: { error(...a) { if (process.env.DBG) console.log('ERR', ...a); } }, process: { env: { WATERMARK_SERVER_URL: 'https://worker.invalid', WATERMARK_SECRET: 'mock-only' } },
    require(name) {
      if (name.includes('confirmed-auth')) return { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER }, supabase: db }) };
      if (name.includes('openai-moderation')) return { moderateContent: async () => ({ ok: true, flagged, categories: flagged ? ['x'] : [] }) };
      if (name.includes('reference-dance')) return { ...lib, authorizeReferenceDanceAdmin: async () => ({ ok: true }) };
      throw new Error('Unexpected import ' + name);
    },
    fetch: async (_url, options) => { workerRequests.push(JSON.parse(options.body)); return { ok: upstreamStatus === 200, status: upstreamStatus, text: async () => JSON.stringify(upstream) }; }
  });
  async function call(body) {
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await module.exports.handler?.({ method: 'POST', body }, res) ?? await module.exports({ method: 'POST', body }, res);
    return res;
  }
  return { call, table, updates, workerRequests, removals, claims, lists, handler: module.exports };
}
test.afterEach(() => { klingDance.config.maxUseSeconds = 10; });

test('disabled gate (default 10 s): the motion profile is refused before anything is touched', async () => {
  const h = setup({ enabled: false });
  const r = await h.call({ assetId: ASSET, profile: 'motion' });
  assert.equal(r.code, 400);
  assert.equal(r.body.error, 'motion_profile_disabled');
  assert.equal(h.workerRequests.length, 0);
  assert.equal(h.updates.length, 0);
});

test('first run: forwards the motion profile with whole-source use and a staging master token; stores measured numbers; keeps staging', async () => {
  const h = setup();
  const r = await h.call({ assetId: ASSET, profile: 'motion' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(h.workerRequests[0].profile, 'motion');
  assert.equal(h.workerRequests[0].useSeconds, null);
  assert.equal(h.workerRequests[0].allowBoundaryTrim, false);
  assert.equal(h.workerRequests[0].storageCapabilities.masterUpload.path, lib.stagingPath(USER, ASSET));
  assert.equal(h.table.status, 'ready');
  assert.equal(h.table.duration_ms, 16200);
  assert.equal(h.table.billable_seconds, 17);
  assert.equal(r.body.billableSeconds, 17);
  assert.deepEqual({ ...r.body.motion }, { mode: 'whole', useSeconds: null, capped: false, sourceDurationMs: 16200, masterDurationMs: 16200 });
  assert.equal(h.removals.includes(lib.stagingPath(USER, ASSET)), false, 'staging holds the master for later length changes');
});

test('an inspector that does not answer as the motion profile is never trusted (fail closed, not ready)', async () => {
  for (const upstream of [inspected({ inspectorProfile: undefined }), { ...inspected(), inspectorProfile: 'legacy' }]) {
    const h = setup({ upstream });
    const r = await h.call({ assetId: ASSET, profile: 'motion' });
    assert.equal(r.code, 503);
    assert.notEqual(h.table.status, 'ready');
    assert.equal(h.table.status, 'uploading');
  }
});

test('length change on a ready asset: conditional ready->checking, no master token, exact cut accepted and stored', async () => {
  const h = setup({ row: { status: 'ready' }, upstream: inspected({ durationMs: 15000 }, { mode: 'cut', useSeconds: 15, sourceDurationMs: 16200, masterDurationMs: 16200 }) });
  const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 15 });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(h.claims.length, 1);
  assert.equal(h.workerRequests[0].useSeconds, 15);
  assert.equal(h.workerRequests[0].storageCapabilities.masterUpload, undefined);
  assert.equal(h.table.status, 'ready');
  assert.equal(h.table.duration_ms, 15000);
  assert.equal(h.table.billable_seconds, 15);
  assert.equal(r.body.motion.useSeconds, 15);
});

test('a returned file that does not match the chosen length is rejected, never stored as ready: 15 chosen but 15.001 s / 14.0 s / 16 s returned', async () => {
  for (const durationMs of [15001, 14000, 16000]) {
    const h = setup({ row: { status: 'ready' }, upstream: inspected({ durationMs }, { mode: 'cut', useSeconds: 15 }) });
    const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 15 });
    assert.equal(r.code, 503, String(durationMs));
    assert.equal(h.table.status, 'uploading', 'not ready: nothing can be billed from this');
    assert.notEqual(h.table.duration_ms, durationMs);
  }
});

test('length change guards: used asset, lost race, expired, throttle, invalid values', async () => {
  const used = setup({ row: { status: 'ready', used_at: new Date().toISOString() } });
  assert.equal((await used.call({ assetId: ASSET, profile: 'motion', useSeconds: 10 })).body.error, 'reference_video_in_use');
  assert.equal(used.workerRequests.length, 0);
  const race = setup({ row: { status: 'ready' }, claimRows: 0 });
  const raceRes = await race.call({ assetId: ASSET, profile: 'motion', useSeconds: 10 });
  assert.equal(raceRes.code, 409);
  assert.equal(raceRes.body.retryable, true);
  assert.equal(race.workerRequests.length, 0);
  const fresh = setup({ row: { status: 'ready', updated_at: new Date().toISOString() } });
  assert.equal((await fresh.call({ assetId: ASSET, profile: 'motion', useSeconds: 10 })).code, 409);
  for (const bad of [3, 21, 12.5, '15', -1, true]) {
    const h = setup({ row: { status: 'ready' } });
    const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: bad });
    assert.equal(r.code, 400, String(bad));
    assert.equal(r.body.error, 'invalid_use_seconds');
    assert.equal(h.workerRequests.length, 0);
  }
  const noProfile = setup({ row: { status: 'ready' } });
  assert.equal((await noProfile.call({ assetId: ASSET, useSeconds: 10 })).body.error, 'invalid_use_seconds');
  assert.equal((await setup().call({ assetId: ASSET, profile: 'other' })).body.error, 'invalid_profile');
});

test('a choice longer than the source is refused by the inspector and the asset simply stays ready with its old numbers', async () => {
  const h = setup({ row: { status: 'ready' }, upstream: { ok: false, error: 'MOTION_USE_EXCEEDS_SOURCE' }, upstreamStatus: 422 });
  const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 20 });
  assert.equal(r.code, 400);
  assert.equal(r.body.error, 'motion_length_invalid');
  assert.equal(h.table.status, 'ready');
  assert.equal(h.table.duration_ms, 16200);
  assert.equal(h.removals.length, 0);
});

test('without a length key a ready asset returns its stored numbers (no recut, no inspector call)', async () => {
  const h = setup({ row: { status: 'ready', approved_path: lib.approvedPath(USER, ASSET) } });
  const r = await h.call({ assetId: ASSET, profile: 'motion' });
  assert.equal(r.code, 200);
  assert.equal(r.body.billableSeconds, 17);
  assert.equal(h.workerRequests.length, 0);
});

test('moderation of the cut: flagged content blocks the asset and removes its objects', async () => {
  const h = setup({ row: { status: 'ready' }, flagged: true, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(r.code, 422);
  assert.equal(r.body.error, 'reference_video_content_blocked');
  assert.equal(h.table.status, 'blocked');
});

test('Seedance dance (no profile) is unchanged: 15 s limit, original staging removed after success', async () => {
  const h = setup({ enabled: true, upstream: { ...inspected(), inspectorProfile: undefined, durationMs: 15000, motion: undefined } });
  const r = await h.call({ assetId: ASSET });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal('profile' in h.workerRequests[0], false);
  assert.equal(h.removals.includes(lib.stagingPath(USER, ASSET)), true);
  const over = setup({ enabled: true, upstream: { ...inspected(), inspectorProfile: undefined, durationMs: 16000, motion: undefined } });
  assert.equal((await over.call({ assetId: ASSET })).code, 503, 'a 16 s result is never accepted without the motion profile');
  assert.notEqual(over.table.status, 'ready');
});

test('validateInspection boundaries', () => {
  const { validateInspection } = setup().handler._test;
  const base = inspected();
  const m = (useSeconds) => ({ maxDurationMs: 20000, useSeconds });
  assert.equal(validateInspection({ ...base, durationMs: 20000 }, USER, ASSET, m(null)).billableSeconds, 20);
  assert.equal(validateInspection({ ...base, durationMs: 20001 }, USER, ASSET, m(null)), null);
  assert.equal(validateInspection({ ...base, durationMs: 16200 }, USER, ASSET, m(null)).billableSeconds, 17);
  assert.equal(validateInspection({ ...base, durationMs: 15000 }, USER, ASSET, m(15)).billableSeconds, 15);
  assert.equal(validateInspection({ ...base, durationMs: 14500 }, USER, ASSET, m(15)).billableSeconds, 15);
  assert.equal(validateInspection({ ...base, durationMs: 15001 }, USER, ASSET, m(15)), null);
  assert.equal(validateInspection({ ...base, durationMs: 14000 }, USER, ASSET, m(15)), null);
  assert.equal(validateInspection({ ...base, durationMs: 3999 }, USER, ASSET, m(null)), null);
  assert.equal(validateInspection({ ...base, durationMs: 16000 }, USER, ASSET, null), null, 'non-motion keeps 15 s');
  assert.equal(validateInspection({ ...base, inspectorProfile: undefined }, USER, ASSET, m(null)), null);
});

test('a first inspection of a motion asset is always the whole video: a cut is refused until the master exists', async () => {
  const h = setup({ row: { status: 'uploading' } });
  const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(r.code, 400);
  assert.equal(r.body.error, 'invalid_use_seconds');
  assert.equal(h.workerRequests.length, 0);
  assert.equal(h.table.status, 'uploading', 'untouched: no attempt consumed, no worker call');
});

test('after a failed length change the retry is again a length change: no inspection attempt consumed, no master rewrite', async () => {
  const failing = setup({ row: { status: 'ready' }, upstream: { ok: false, error: 'VIDEO_CHECK_TIMEOUT' }, upstreamStatus: 422 });
  const first = await failing.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(first.code, 503);
  assert.equal(failing.table.status, 'uploading');
  assert.match(failing.table.inspection_error, /^MOTION_RECUT:/);
  // retry on the row left behind by that failure
  const retry = setup({ row: { status: 'uploading', inspection_error: 'MOTION_RECUT:VIDEO_CHECK_TIMEOUT' }, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  const ok = await retry.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(ok.code, 200, JSON.stringify(ok.body));
  assert.equal(retry.workerRequests[0].storageCapabilities.masterUpload, undefined);
  assert.equal(retry.table.status, 'ready');
  assert.equal(retry.table.duration_ms, 12000);
  assert.equal(retry.table.billable_seconds, 12);
  // a retry of a length change that the inspector refuses goes back to the retry state, never to ready
  const refused = setup({ row: { status: 'uploading', inspection_error: 'MOTION_RECUT:X' }, upstream: { ok: false, error: 'MOTION_USE_EXCEEDS_SOURCE' }, upstreamStatus: 422 });
  assert.equal((await refused.call({ assetId: ASSET, profile: 'motion', useSeconds: 20 })).code, 400);
  assert.equal(refused.table.status, 'uploading');
});

test('gate closed again with 16-20 s data present: stored assets stay readable and untouched, only new motion requests stop', async () => {
  // a ready 17 s asset: a plain (non-motion) confirmation returns its stored numbers without throwing and without the Seedance sample price
  const ready = setup({ enabled: false, row: { status: 'ready', duration_ms: 17500, billable_seconds: 18, approved_path: lib.approvedPath(USER, ASSET) } });
  const cached = await ready.call({ assetId: ASSET });
  assert.equal(cached.code, 200);
  assert.equal(cached.body.billableSeconds, 18);
  assert.equal(cached.body.sampleCredits, null);
  assert.equal(ready.workerRequests.length, 0);
  // a motion length change is refused (new acceptance stopped) and the asset row is not touched
  for (const body of [{ assetId: ASSET, profile: 'motion', useSeconds: 12 }, { assetId: ASSET, profile: 'motion' }]) {
    const closed = setup({ enabled: false, row: { status: 'ready', duration_ms: 17500, billable_seconds: 18 } });
    const r = await closed.call(body);
    assert.equal(r.code, 400);
    assert.equal(r.body.error, 'motion_profile_disabled');
    assert.equal(closed.updates.length, 0);
    assert.equal(closed.removals.length, 0);
    assert.equal(closed.table.status, 'ready');
  }
  // an interrupted asset whose staging holds a 20 s master, retried by the previous 4-10 s build (no profile): the Seedance inspector
  // refuses >15 s without consent but the upload is RETAINED for an explicit choice - it is never deleted
  const retry = setup({ enabled: false, row: { status: 'uploading', inspection_error: 'MOTION_RECUT:VIDEO_CHECK_TIMEOUT' }, upstream: { ok: false, error: 'VIDEO_DURATION_INVALID', durationDiagnostics: { containerSeconds: 20, videoSeconds: 20 } }, upstreamStatus: 422 });
  const old = await retry.call({ assetId: ASSET, allowBoundaryTrim: false });
  assert.equal(old.code, 422);
  assert.equal(old.body.error, 'reference_video_trim_choice_required');
  assert.equal(retry.removals.length, 0, 'nothing is deleted');
  assert.equal(retry.table.status, 'uploading');
});

test('access endpoint: shipped default reports the 10 s gate; the length choice appears only when the gate is opened', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../api/reference-dance-access.js'), 'utf8');
  async function access() {
    const module = { exports: {} };
    vm.runInNewContext(src, { module, console: { error() {} }, require: (n) => {
      if (n.includes('confirmed-auth')) return { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER } }) };
      if (n.includes('reference-dance')) return { ...lib, authorizeReferenceDanceAdmin: async () => ({ ok: true }) };
      throw new Error('Unexpected import ' + n);
    } });
    const res = { setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await module.exports({ method: 'GET', headers: {} }, res);
    return res.body.klingDance;
  }
  klingDance.config.maxUseSeconds = 10;
  const closed = await access();
  assert.equal(closed.maxSeconds, 10);
  assert.equal(closed.lengthSelectEnabled, false);
  klingDance.config.maxUseSeconds = 20;
  const open = await access();
  assert.equal(open.maxSeconds, 20);
  assert.equal(open.lengthSelectEnabled, true);
  assert.equal(open.sourceMaxSeconds, 30);
});

test('a failed length change never deletes the asset it started from, even for a permanent-looking inspection code', async () => {
  for (const code of ['VIDEO_DURATION_MISMATCH', 'VIDEO_SIZE_INVALID', 'VIDEO_DURATION_INVALID']) {
    const h = setup({ row: { status: 'ready' }, upstream: { ok: false, error: code, durationDiagnostics: { containerSeconds: 20 } }, upstreamStatus: 422 });
    const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
    assert.equal(r.code, 503, code);
    assert.equal(h.removals.length, 0, 'no object is removed');
    assert.equal(h.table.status, 'uploading', 'retry state, not failed');
    assert.match(h.table.inspection_error, /^MOTION_RECUT:/);
  }
  // a FIRST inspection with a permanent code is still the existing delete-and-fail path
  const first = setup({ row: { status: 'uploading' }, upstream: { ok: false, error: 'VIDEO_DURATION_INVALID', durationDiagnostics: { containerSeconds: 31 } }, upstreamStatus: 422 });
  assert.equal((await first.call({ assetId: ASSET, profile: 'motion' })).code, 422);
  assert.equal(first.table.status, 'failed');
});

test('a length change extends the asset lease like the first-run claim does (never shortens it)', async () => {
  const soon = new Date(Date.now() + 90e3).toISOString();
  const h = setup({ row: { status: 'ready', expires_at: soon }, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.ok(Date.parse(h.claims[0].expires_at) >= Date.now() + 3500e3);
  const far = new Date(Date.now() + 20 * 3600e3).toISOString();
  const h2 = setup({ row: { status: 'ready', expires_at: far }, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  await h2.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(h2.claims[0].expires_at, far);
});

// A length change may start only from an asset the motion pipeline sealed AND whose master still exists.
// Anything else is refused before the row is touched: same status, same numbers, still usable, nothing removed.
test('a Seedance-sealed ready asset (no motion marker, source deleted) is refused untouched: still ready and usable', async () => {
  for (const inspection_error of [null, '', 'VIDEO_DURATION_INVALID']) {
    const h = setup({ row: { status: 'ready', inspection_error }, master: 'no' });
    const before = { ...h.table };
    const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
    assert.equal(r.code, 400);
    assert.equal(r.body.error, 'motion_length_unavailable');
    assert.deepEqual(h.table, before, 'row is byte-for-byte unchanged');
    assert.equal(h.updates.length, 0, 'no write at all');
    assert.equal(h.workerRequests.length, 0);
    assert.equal(h.removals.length, 0);
    // and it is still returned as a usable ready asset
    const again = await h.call({ assetId: ASSET });
    assert.equal(again.code, 200);
    assert.equal(again.body.status, 'ready');
  }
});

test('even with the marker, a missing master object refuses the change untouched; a failed lookup is a retryable 503, never read as missing', async () => {
  const gone = setup({ row: { status: 'ready' }, master: 'no' });
  const before = { ...gone.table };
  const r = await gone.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(r.body.error, 'motion_length_unavailable');
  assert.deepEqual(gone.table, before);
  assert.equal(gone.updates.length, 0);
  const err = setup({ row: { status: 'ready' }, master: 'error' });
  const e = await err.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(e.code, 503);
  assert.equal(e.body.retryable, true);
  assert.equal(err.table.status, 'ready');
  assert.equal(err.updates.length, 0);
  // the lookup is scoped to this user's staging folder and this asset
  assert.equal(err.lists[0].dir, 'staging/' + USER);
  assert.equal(err.lists[0].opts.search, ASSET + '.mp4');
});

test('motion asset with its master: the change succeeds, keeps the marker, and does not renew the retention', async () => {
  const exp = new Date(Date.now() + 5 * 3600e3).toISOString();
  const h = setup({ row: { status: 'ready', expires_at: exp }, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(h.table.status, 'ready');
  assert.equal(h.table.inspection_error, 'MOTION_MASTER');
  assert.equal(h.table.expires_at, exp, 'no reset to a fresh 24 h');
  assert.equal(r.body.expiresAt, exp);
  // a first inspection still starts the full retention
  const first = setup({ row: { status: 'uploading' } });
  const f = await first.call({ assetId: ASSET, profile: 'motion' });
  assert.equal(f.code, 200);
  assert.ok(Date.parse(first.table.expires_at) > Date.now() + 23 * 3600e3);
  assert.equal(first.table.inspection_error, 'MOTION_MASTER');
});

test('retention: near expiry the claim leaves enough time to finish; repeated changes never reset to a fresh 24 h', async () => {
  const soon = new Date(Date.now() + 90e3).toISOString();
  const h = setup({ row: { status: 'ready', expires_at: soon }, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  const after = Date.parse(h.table.expires_at);
  assert.ok(after >= Date.now() + 3500e3 && after <= Date.now() + 3601e3, 'about now+1h, not 24 h');
});

test('an expired asset is never revived: ready, and the MOTION_RECUT retry state alike', async () => {
  const past = new Date(Date.now() - 60e3).toISOString();
  for (const row of [{ status: 'ready', expires_at: past }, { status: 'uploading', inspection_error: 'MOTION_RECUT:X', expires_at: past }]) {
    const h = setup({ row });
    const before = { ...h.table };
    const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
    assert.equal(r.code, 409, row.status);
    assert.deepEqual(h.table, before);
    assert.equal(h.workerRequests.length, 0);
    assert.equal(h.removals.length, 0);
  }
});

test('retry of a failed length change: master required, lease extended like a fresh change, healthy row never destroyed', async () => {
  const soon = new Date(Date.now() + 90e3).toISOString();
  const h = setup({ row: { status: 'uploading', inspection_error: 'MOTION_RECUT:X', expires_at: soon }, master: 'no' });
  const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(r.body.error, 'motion_length_unavailable');
  assert.equal(h.table.status, 'uploading');
  assert.equal(h.updates.length, 0);
  const ok = setup({ row: { status: 'uploading', inspection_error: 'MOTION_RECUT:X', expires_at: soon }, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  const o = await ok.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(o.code, 200, JSON.stringify(o.body));
  assert.ok(Date.parse(ok.updates[0].expires_at) >= Date.now() + 3500e3, 'claim extended the lease');
  assert.ok(Date.parse(ok.table.expires_at) < Date.now() + 2 * 3600e3, 'success did not reset to 24 h');
});

test('concurrency: of two simultaneous length changes only one runs; the loser touches nothing and the asset stays healthy', async () => {
  const h = setup({ row: { status: 'ready' }, upstream: inspected({ durationMs: 12000 }, { mode: 'cut', useSeconds: 12 }) });
  // second request arrives while the first holds the claim (status checking): it must not run the worker
  const [a, b] = await Promise.all([
    h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 }),
    h.call({ assetId: ASSET, profile: 'motion', useSeconds: 14 })
  ]);
  const codes = [a.code, b.code].sort();
  assert.deepEqual(codes, [200, 409], JSON.stringify([a.body, b.body]));
  assert.equal(h.workerRequests.length, 1, 'exactly one inspection');
  assert.equal(h.table.status, 'ready', 'never left broken');
  assert.equal(h.removals.length, 0);
});

test('a ready asset WITHOUT the motion marker is refused untouched even if an object sits in staging (e.g. a Seedance source whose deletion failed)', async () => {
  const h = setup({ row: { status: 'ready', inspection_error: null }, master: 'yes' });
  const before = { ...h.table };
  const r = await h.call({ assetId: ASSET, profile: 'motion', useSeconds: 12 });
  assert.equal(r.body.error, 'motion_length_unavailable');
  assert.deepEqual(h.table, before);
  assert.equal(h.updates.length, 0);
  assert.equal(h.workerRequests.length, 0);
});
