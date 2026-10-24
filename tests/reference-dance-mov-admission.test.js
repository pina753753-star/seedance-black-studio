'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const lib = require('../api/_lib/reference-dance.js');
const root = path.join(__dirname, '..');
const USER = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';
const html = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
const api = fs.readFileSync(path.join(root, 'api/reference-dance-upload-url.js'), 'utf8');
function server({ allowed = true, authenticated = true } = {}) {
  const writes = [];
  const db = {
    from(table) {
      const q = { select() { return q; }, eq() { return q; }, gte() { return q; },
        async maybeSingle() { return { data: { id: USER, email: 'admin@example.com', role: allowed ? 'admin' : 'user' } }; },
        async insert(row) { writes.push(row); return {}; },
        then(resolve, reject) { return Promise.resolve({ count: 0 }).then(resolve, reject); }
      }; return q;
    },
    storage: { from() { return { async createSignedUploadUrl() { return { data: { token: 'synthetic-scoped-upload-token' } }; } }; } }
  };
  const module = { exports: {} };
  vm.runInNewContext(api, { module, Date, console, process: { env: { ADMIN_EMAIL: 'admin@example.com' } },
    require(name) {
      if (name === 'node:crypto') return { randomUUID: () => ASSET };
      if (name.includes('confirmed-auth')) return { requireConfirmedAuth: async () => authenticated
        ? { ok: true, user: { id: USER, email: 'admin@example.com' }, supabase: db }
        : { ok: false, status: 401, body: { error: 'unauthorized' } } };
      if (name.includes('reference-dance')) return { ...lib, authorizeReferenceDanceAdmin: async auth => ({ ok: authenticated && allowed && !!auth.user.id }) };
      throw new Error('Unexpected import ' + name);
    }, fetch() { throw new Error('No network permitted'); }
  });
  return { writes, async call(body) {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await module.exports({ method: 'POST', body: { rightsConfirmed: true, byteSize: 1024, ...body } }, res);
    return res;
  } };
}
const admitted = [
  { filename: 'dance.mp4', contentType: 'video/mp4' },
  { filename: 'dance.MOV', contentType: 'video/quicktime' },
  { filename: 'dance.mov', contentType: '' },
  { filename: 'dance.MOV', contentType: 'application/octet-stream' },
  { filename: 'dance', contentType: 'video/quicktime' }
];
test('MP4 and MOV upload hints are admitted without widening storage or ready-state trust', async () => {
  for (const input of admitted) {
    const h = server(); const res = await h.call(input);
    assert.equal(res.code, 200, JSON.stringify(input));
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].status, 'uploading');
    assert.equal(res.body.contentType, 'video/mp4');
    assert.equal(res.body.path, lib.stagingPath(USER, ASSET));
    assert.equal(res.body.maxBytes, 50 * 1024 * 1024);
    assert.equal(h.writes[0].duration_ms, undefined);
    assert.equal(h.writes[0].billable_seconds, undefined);
  }
});
test('unrelated containers and extension spoof suffixes are rejected before storage', async () => {
  for (const input of [
    { filename: 'dance.webm', contentType: 'video/webm' },
    { filename: 'dance.avi', contentType: 'video/x-msvideo' },
    { filename: 'dance.mov.exe', contentType: 'application/octet-stream' },
    { filename: '', contentType: '' }
  ]) {
    const h = server(); const res = await h.call(input);
    assert.equal(res.code, 415); assert.equal(h.writes.length, 0);
  }
});
test('MOV keeps existing authentication, admin, rights and byte-limit barriers', async () => {
  for (const [options, fields, status] of [
    [{ authenticated: false }, {}, 401], [{ allowed: false }, {}, 403],
    [{}, { rightsConfirmed: false }, 400], [{}, { byteSize: 0 }, 413],
    [{}, { byteSize: 50 * 1024 * 1024 + 1 }, 413]
  ]) {
    const h = server(options); const res = await h.call({ ...admitted[1], ...fields });
    assert.equal(res.code, status); assert.equal(h.writes.length, 0);
  }
});
function browser() {
  const requests = [], uploaded = [], confirmations = [];
  const ctx = { referenceDanceAsset: null, syncReferenceDanceUi() {}, updateCreditUi() {},
    canUseReferenceDance: () => true, getToken: async () => 'synthetic',
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true, assetId: ASSET, path: lib.stagingPath(USER, ASSET), token: 'synthetic', bucket: lib.REFERENCE_DANCE_BUCKET }) }; },
    window: { flowvidSupabaseClient: () => ({ storage: { from: () => ({ uploadToSignedUrl: async (...args) => { uploaded.push(args); return {}; } }) } }) },
    confirmReferenceDanceAsset: async () => { confirmations.push(ASSET); return true; },
    deleteReferenceDanceAsset() { throw new Error('Unexpected deletion'); }
  };
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('async function uploadReferenceDance(file){'), html.indexOf('function removeReferenceDance(){')), ctx);
  return { ctx, requests, uploaded, confirmations };
}
test('browser accepts MOV metadata, uploads original bytes and requires inspection before ready', async () => {
  for (const input of admitted) {
    const b = browser(); const file = { name: input.filename, type: input.contentType, size: 1024 };
    await b.ctx.uploadReferenceDance(file);
    assert.equal(b.requests.length, 1); assert.equal(b.confirmations.length, 1);
    assert.equal(b.uploaded[0][2], file);
    assert.equal(b.uploaded[0][3].contentType, 'video/mp4');
    assert.equal(b.ctx.referenceDanceAsset.status, 'uploading');
    assert.equal(b.requests[0].body.rightsConfirmed, true);
  }
});
test('browser refuses unsupported or oversized input without a request', async () => {
  for (const file of [{ name: 'dance.webm', type: 'video/webm', size: 1024 }, { name: 'dance.mov.exe', type: '', size: 1024 }, { name: 'dance.mov', type: 'video/quicktime', size: 50 * 1024 * 1024 + 1 }]) {
    const b = browser(); await b.ctx.uploadReferenceDance(file);
    assert.equal(b.requests.length, 0); assert.equal(b.uploaded.length, 0); assert.equal(b.ctx.referenceDanceAsset.status, 'failed');
  }
});
test('file picker and help explicitly cover MOV, while inspector remains mandatory', () => {
  assert.match(html, /id="danceFile"[^>]*accept="video\/mp4,video\/quicktime,\.mp4,\.mov"/);
  assert.match(html, /MP4／MOV・4〜15秒・最大50MB/);
  assert.match(api, /status: 'uploading'/);
  assert.doesNotMatch(api, /status: 'ready'/);
});
