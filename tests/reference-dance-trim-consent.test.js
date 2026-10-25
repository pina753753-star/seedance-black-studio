'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const lib = require('../api/_lib/reference-dance.js');
const api = fs.readFileSync(path.join(root, 'api/reference-dance-confirm-upload.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';
const ASSET = '270bf01a-bafd-4255-8ad5-e18a4f1c8c47';
function harness(upstream, { retryPersistError = false } = {}) {
  const updates = [], requests = [], removals = [];
  const row = { id: ASSET, user_id: USER, status: 'uploading', staging_path: lib.stagingPath(USER, ASSET) };
  const db = {
    from() { let update; const chain = { select() { return chain; }, eq() { return chain; }, update(value) { update = value; updates.push(value); return chain; }, async maybeSingle() { return { data: { ...row } }; }, then(resolve, reject) { return Promise.resolve({ data: [{ id: ASSET }], ...(retryPersistError && update?.status === 'uploading' ? { error: { message: 'synthetic persistence failure' } } : {}) }).then(resolve, reject); } }; return chain; },
    async rpc() { return { data: { ok: true, code: 'claimed' } }; },
    storage: { from() { return { async createSignedUrl() { return { data: { signedUrl: 'https://mock.invalid/source' } }; }, async createSignedUploadUrl() { return { data: { token: 'mock-path-token' } }; }, async remove(paths) { removals.push(...paths); return {}; } }; } }
  };
  const module = { exports: {} };
  vm.runInNewContext(api, { module, Buffer, Date, AbortController, setTimeout, clearTimeout,
    console: { error() {} }, process: { env: { WATERMARK_SERVER_URL: 'https://worker.invalid', WATERMARK_SECRET: 'mock-only' } },
    require(name) {
      if (name.includes('confirmed-auth')) return { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER }, supabase: db }) };
      if (name.includes('openai-moderation')) return { moderateContent: async () => ({ ok: true }) };
      if (name.includes('reference-dance')) return { ...lib, authorizeReferenceDanceAdmin: async () => ({ ok: true }) };
      throw new Error('Unexpected import');
    },
    fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: upstream.ok === true, status: upstream.ok ? 200 : 422, text: async () => JSON.stringify(upstream) }; }
  });
  return { handler: module.exports, updates, requests, removals };
}
const clean = value => JSON.parse(JSON.stringify(value));
test('duration diagnostics retain only finite bounded numeric fields, never external text', () => {
  const { safeDurationDiagnostics, inspectionMessage } = harness({}).handler._test;
  assert.deepEqual(clean(safeDurationDiagnostics({ containerSeconds: 15.04, videoSeconds: 20, audioSeconds: 30, secret: 'never-store' })), { containerSeconds: 15.04, videoSeconds: 20, audioSeconds: 30 });
  for (const bad of [NaN, Infinity, -1, 86401, '15', {}, null, undefined]) {
    const result = safeDurationDiagnostics({ containerSeconds: bad, videoSeconds: bad, audioSeconds: bad });
    assert.deepEqual(clean(result), { containerSeconds: null, videoSeconds: null, audioSeconds: null });
  }
  assert.match(inspectionMessage('VIDEO_DURATION_INVALID', { containerSeconds: 15.04 }), /15\.040/);
  assert.doesNotMatch(inspectionMessage('VIDEO_DURATION_INVALID', { containerSeconds: 'sensitive-external-text' }), /sensitive-external-text/);
});
test('Railway adapter forwards opt-in only for the boolean true', async () => {
  for (const consent of [undefined, false, true, 'true', 1, {}]) {
    const h = harness({ ok: true });
    await h.handler._test.inspectOnRailway({ userId: USER, assetId: ASSET, allowBoundaryTrim: consent });
    assert.equal(h.requests[0].allowBoundaryTrim, consent === true);
  }
});
test('full confirmation forwards strict consent and persists only sanitized permanent diagnostics', async () => {
  for (const consent of [true, false, 'true']) {
    const h = harness({ error: 'VIDEO_DURATION_INVALID', durationDiagnostics: { containerSeconds: 65.5, videoSeconds: 65, audioSeconds: 'secret', path: '/private/path' } });
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await h.handler({ method: 'POST', body: { assetId: ASSET, allowBoundaryTrim: consent } }, res);
    assert.equal(h.requests[0].allowBoundaryTrim, consent === true);
    assert.equal(res.code, 422);
    const record = h.updates.find(u => u.status === 'failed');
    assert.deepEqual(JSON.parse(record.inspection_error), { code: 'VIDEO_DURATION_INVALID', durationDiagnostics: { containerSeconds: 65.5, videoSeconds: 65, audioSeconds: null } });
    assert.doesNotMatch(record.inspection_error, /secret|private/);
    assert.equal(res.body.durationDiagnostics.containerSeconds, 65.5);
  }
});
test('sealed inspection duration remains <=15 seconds and billing derives from sealed data', () => {
  const { validateInspection } = harness({}).handler._test;
  const inspected = { ok: true, approvedPath: lib.approvedPath(USER, ASSET), reviewPaths: Array.from({ length: 5 }, (_, i) => lib.reviewFramePath(USER, ASSET, i + 1)), sizeBytes: 1000, durationMs: 15000, width: 720, height: 1280, fps: 30, videoCodec: 'h264', sha256: 'a'.repeat(64), boundaryTrimmed: true, durationDiagnostics: { videoSeconds: 60 } };
  assert.equal(validateInspection(inspected, USER, ASSET).billableSeconds, 15);
  assert.equal(lib.referenceDanceCredits(15), 605);
  assert.equal(validateInspection({ ...inspected, durationMs: 15001 }, USER, ASSET), null);
  assert.equal(validateInspection({ ...inspected, durationMs: 5001 }, USER, ASSET).billableSeconds, 6);
});
test('missing trim choice retains a 15–60s upload for explicit retry instead of deleting it', async () => {
  for (const consent of [undefined, false, 'true']) {
    const h = harness({ error: 'VIDEO_DURATION_INVALID', durationDiagnostics: { containerSeconds: 20, videoSeconds: 20 } });
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await h.handler({ method: 'POST', body: { assetId: ASSET, allowBoundaryTrim: consent } }, res);
    assert.equal(h.requests[0].allowBoundaryTrim, false);
    assert.equal(res.code, 422);
    assert.equal(res.body.error, 'reference_video_trim_choice_required');
    assert.equal(res.body.retryable, true);
    assert.equal(h.removals.length, 0);
    assert.equal(h.updates.at(-1).status, 'uploading');
    assert.equal(h.updates.at(-1).expires_at, undefined);
    assert.equal(h.updates.some(u => u.status === 'failed'), false);
  }
});
test('trim consent cannot make over-limit, short or unknown durations recoverable', async () => {
  for (const duration of [3, 60.001, null]) {
    const h = harness({ error: 'VIDEO_DURATION_INVALID', durationDiagnostics: { containerSeconds: duration, videoSeconds: duration } });
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await h.handler({ method: 'POST', body: { assetId: ASSET, allowBoundaryTrim: false } }, res);
    assert.equal(res.code, 422);
    assert.equal(res.body.retryable, undefined);
    assert.equal(h.removals.length, 7);
    assert.equal(h.updates.at(-1).status, 'failed');
  }
});
test('a transient retry-state persistence failure retains the upload and retry affordance', async () => {
  const h = harness({ error: 'VIDEO_DURATION_INVALID', durationDiagnostics: { containerSeconds: 20, videoSeconds: 20 } }, { retryPersistError: true });
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await h.handler({ method: 'POST', body: { assetId: ASSET, allowBoundaryTrim: false } }, res);
  assert.equal(res.code, 503);
  assert.equal(res.body.retryable, true);
  assert.equal(h.removals.length, 0);
});
function browser(checked) {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, { checked: false, style: {}, value: '' }); return elements.get(id); };
  $('danceTrim').checked = checked; $('danceRights').checked = true; $('model').value = 'turbo'; $('resolution').value = '720p';
  let releaseToken;
  const requests = [];
  const ctx = { $, referenceDanceAsset: { id: ASSET, status: 'failed' }, referenceDanceAccess: true, generationRequestInFlight: false, SEEDANCE_25_TURBO_MODEL: 'turbo', mode: 'reference_to_video', canUseReferenceDance: () => true, updateCreditUi() {},
    getToken: () => new Promise(resolve => { releaseToken = resolve; }),
    fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true, status: 'ready', durationMs: 15000, billableSeconds: 15 }) }; }
  };
  vm.createContext(ctx);
  const sync = html.slice(html.indexOf('function syncReferenceDanceUi(){'), html.indexOf('\n', html.indexOf('function syncReferenceDanceUi(){')));
  const confirm = html.slice(html.indexOf('async function confirmReferenceDanceAsset(){'), html.indexOf('async function uploadReferenceDance(file){'));
  vm.runInContext(sync + '\n' + confirm, ctx);
  return { ctx, $, requests, release: () => releaseToken('mock') };
}
test('trim checkbox is separate, uniquely identified and not checked by default', () => {
  const tag = html.match(/<input\b[^>]*\bid="danceTrim"[^>]*>/g);
  assert.equal(tag.length, 1);
  assert.match(tag[0], /type="checkbox"/);
  assert.doesNotMatch(tag[0], /\bchecked\b/);
  assert.match(html, /<label[^>]*><input[^>]*id="danceTrim"[^>]*>[^<]*<\/label>/);
});
test('browser sends chosen consent and disables editing before async authentication', async () => {
  for (const checked of [false, true]) {
    const b = browser(checked);
    const pending = b.ctx.confirmReferenceDanceAsset();
    assert.equal(b.$('danceTrim').disabled, true);
    assert.equal(b.$('danceRights').disabled, true);
    b.release(); await pending;
    assert.equal(b.requests[0].allowBoundaryTrim, checked);
    assert.equal(b.ctx.referenceDanceAsset.billableSeconds, 15);
    b.ctx.generationRequestInFlight = true; b.ctx.syncReferenceDanceUi();
    assert.equal(b.$('danceTrim').disabled, true);
  }
});
test('all inline scripts remain syntactically valid after UI edits', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) new vm.Script(script[1]);
});
test('reload after a transient failure can explicitly choose trim and retry the retained asset', async () => {
  const b = browser(false);
  b.ctx.referenceDanceAsset = null;
  b.ctx.getToken = async () => 'synthetic';
  b.ctx.fetch = async () => ({ ok: true, json: async () => ({ asset: { id: ASSET, status: 'uploading', name: 'dance.mov' } }) });
  const restore = html.slice(html.indexOf('async function restoreLatestReferenceDance(){'), html.indexOf('async function loadReferenceDanceAccess(){'));
  vm.runInContext(restore, b.ctx);
  await b.ctx.restoreLatestReferenceDance();
  assert.equal(b.$('danceTrim').checked, false);
  assert.equal(b.ctx.referenceDanceAsset.retryable, true);
  assert.match(b.ctx.referenceDanceAsset.error, /先頭15秒/);
  b.ctx.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.assetId, ASSET);
    return body.allowBoundaryTrim
      ? { ok: true, json: async () => ({ ok: true, status: 'ready', durationMs: 15000, billableSeconds: 15, trimApplied: true }) }
      : { ok: false, json: async () => ({ error: 'reference_video_trim_choice_required', retryable: true, message: '先頭15秒を使うにチェックして再検査してください。' }) };
  };
  assert.equal(await b.ctx.confirmReferenceDanceAsset(), false);
  assert.equal(b.ctx.referenceDanceAsset.id, ASSET);
  assert.equal(b.ctx.referenceDanceAsset.retryable, true);
  assert.equal(b.$('danceTrim').disabled, false);
  b.$('danceTrim').checked = true;
  assert.equal(await b.ctx.confirmReferenceDanceAsset(), true);
  assert.equal(b.ctx.referenceDanceAsset.id, ASSET);
  assert.equal(b.ctx.referenceDanceAsset.trimApplied, true);
  assert.equal(b.ctx.referenceDanceAsset.durationMs, 15000);
  assert.equal(b.ctx.referenceDanceAsset.billableSeconds, 15);
});

test('repeated confirmation cannot race a successful inspection', async () => {
  const b = browser(true);
  let release;
  const token = new Promise(resolve => { release = resolve; });
  b.ctx.getToken = () => token;
  const first = b.ctx.confirmReferenceDanceAsset();
  const second = b.ctx.confirmReferenceDanceAsset();
  release('synthetic');
  assert.equal(await first, true);
  assert.equal(await second, false);
  assert.equal(b.requests.length, 1);
  assert.equal(b.ctx.referenceDanceAsset.status, 'ready');
});
test('interrupted confirmation retains asset and consent for a successful retry', async () => {
  const b = browser(true);
  b.ctx.getToken = async () => 'synthetic';
  b.ctx.fetch = async () => { throw new Error('synthetic connection interrupted'); };
  assert.equal(await b.ctx.confirmReferenceDanceAsset(), false);
  assert.equal(b.ctx.referenceDanceAsset.id, ASSET);
  assert.equal(b.ctx.referenceDanceAsset.retryable, true);
  assert.equal(b.$('danceTrim').checked, true);
  assert.equal(b.$('danceTrim').disabled, false);
  b.ctx.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).allowBoundaryTrim, true);
    return { ok: true, json: async () => ({ ok: true, status: 'ready', durationMs: 15000, billableSeconds: 15 }) };
  };
  assert.equal(await b.ctx.confirmReferenceDanceAsset(), true);
});
test('busy server response preserves consent while permanent rejection removes retry affordance', async () => {
  const b = browser(true);
  b.ctx.getToken = async () => 'synthetic';
  for (const [error, retryable] of [['reference_video_checking', true], ['reference_video_invalid', false]]) {
    b.ctx.fetch = async () => ({ ok: false, json: async () => ({ error }) });
    assert.equal(await b.ctx.confirmReferenceDanceAsset(), false);
    assert.equal(b.ctx.referenceDanceAsset.retryable, retryable);
    assert.equal(b.$('danceTrim').checked, true);
  }
});
test('upload events during upload, inspection or generation cannot replace the active asset', async () => {
  const b = browser(true);
  const upload = html.slice(html.indexOf('async function uploadReferenceDance(file){'), html.indexOf('function removeReferenceDance(){'));
  vm.runInContext(upload, b.ctx);
  for (const [status, generating] of [['uploading', false], ['checking', false], ['ready', true]]) {
    const asset = { id: ASSET, status };
    b.ctx.referenceDanceAsset = asset;
    b.ctx.generationRequestInFlight = generating;
    await b.ctx.uploadReferenceDance({ name: 'invalid.txt', type: 'text/plain', size: 1 });
    assert.equal(b.ctx.referenceDanceAsset, asset);
    assert.equal(b.requests.length, 0);
  }
});
test('completed byte upload can still enter confirmation from uploading state', async () => {
  const b = browser(true);
  b.ctx.referenceDanceAsset.status = 'uploading';
  const pending = b.ctx.confirmReferenceDanceAsset();
  b.release();
  assert.equal(await pending, true);
  assert.equal(b.requests.length, 1);
  assert.equal(b.ctx.referenceDanceAsset.status, 'ready');
});
test('cancelled picker and remove while busy preserve the active upload, then failure removal clears selection', async () => {
  const b = browser(true);
  const removed = [];
  b.ctx.deleteReferenceDanceAsset = id => { removed.push(id); };
  vm.runInContext(html.slice(html.indexOf('async function uploadReferenceDance(file){'), html.indexOf('\n\nasync function getBalance(){')), b.ctx);
  for (const status of ['uploading', 'checking']) {
    const active = { id: ASSET, status };
    b.ctx.referenceDanceAsset = active;
    await b.ctx.uploadReferenceDance(undefined);
    b.ctx.removeReferenceDance();
    assert.equal(b.ctx.referenceDanceAsset, active);
    assert.equal(removed.length, 0);
  }
  b.ctx.referenceDanceAsset.status = 'failed';
  b.$('danceFile').value = 'dance.mov';
  b.ctx.removeReferenceDance();
  assert.equal(b.ctx.referenceDanceAsset, null);
  assert.equal(b.$('danceFile').value, '');
  assert.equal(b.$('danceRights').checked, false);
  assert.deepEqual(removed, [ASSET]);
});
test('fresh page restores server checking state as retryable and busy response leaves retry unlocked', async () => {
  const b = browser(false);
  b.ctx.referenceDanceAsset = null;
  b.ctx.getToken = async () => 'synthetic';
  b.ctx.fetch = async () => ({ ok: true, json: async () => ({ asset: { id: ASSET, status: 'checking', name: 'dance.mov' } }) });
  vm.runInContext(html.slice(html.indexOf('async function restoreLatestReferenceDance(){'), html.indexOf('async function loadReferenceDanceAccess(){')), b.ctx);
  await b.ctx.restoreLatestReferenceDance();
  assert.equal(b.ctx.referenceDanceAsset.status, 'failed');
  assert.equal(b.ctx.referenceDanceAsset.retryable, true);
  assert.equal(b.$('danceTrim').checked, false);
  b.ctx.fetch = async () => ({ ok: false, json: async () => ({ error: 'reference_video_checking', retryable: true }) });
  assert.equal(await b.ctx.confirmReferenceDanceAsset(), false);
  assert.equal(b.ctx.referenceDanceAsset.status, 'failed');
  assert.equal(b.$('danceRetry').style.display, 'block');
  assert.equal(b.$('danceTrim').disabled, false);
});
