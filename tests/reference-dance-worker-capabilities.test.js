'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { withStorageDeadline, uploadStorageFile } = require('../watermark-server/worker-storage.js');
const source = fs.readFileSync(path.join(__dirname, '../watermark-server/server.js'), 'utf8');
const base = 'https://unit-test.supabase.co';
const user = '11111111-1111-4111-8111-111111111111';
const asset = '22222222-2222-4222-8222-222222222222';
const staging = `staging/${user}/${asset}.mp4`;
const approved = `approved/${user}/${asset}.mp4`;
const reviews = Array.from({ length: 5 }, (_, i) => `review/${user}/${asset}/frame-${i + 1}.jpg`);
function fixture() {
  return { supabaseUrl: base, publishableKey: 'synthetic-publishable-key', sourceUrl: `${base}/storage/v1/object/sign/seedance-reference-video/${staging}?token=synthetic`,
    approvedUpload: { path: approved, token: 'synthetic-scoped-upload-token' }, reviewUploads: reviews.map(p => ({ path: p, token: 'synthetic-scoped-upload-token' })) };
}
function harness(overrides = {}) {
  const context = vm.createContext({ URL, Buffer, SUPABASE_URL: base, REFERENCE_DANCE_BUCKET: 'seedance-reference-video', REFERENCE_DANCE_MAX_BYTES: 8,
    referenceDanceError: code => Object.assign(new Error(code), { publicCode: code }), referenceDanceRemainingMs: deadline => deadline - Date.now(),
    withStorageDeadline, uploadStorageFile, fetch: async () => { throw new Error("Unexpected fetch"); }, ...overrides });
  vm.runInContext(source.slice(source.indexOf('function validateReferenceDanceStorageCapabilities('), source.indexOf('async function runReferenceDanceInspection(')), context);
  return context;
}
function validate(value) { return harness().validateReferenceDanceStorageCapabilities(value, staging, approved, reviews); }
test('capabilities bind configured project and every exact source/destination path', () => {
  assert.equal(validate(fixture()).baseUrl, base);
  const mutations = [
    c => { c.supabaseUrl = 'https://other.supabase.co'; c.sourceUrl = c.sourceUrl.replace('unit-test', 'other'); },
    c => { c.supabaseUrl = 'http://unit-test.supabase.co'; },
    c => { c.supabaseUrl = 'https://secret@unit-test.supabase.co'; },
    c => { c.sourceUrl = c.sourceUrl.replace('/staging/', '/approved/'); },
    c => { c.sourceUrl = c.sourceUrl.replace('/staging/', '/extra/../staging/'); },
    c => { c.sourceUrl = c.sourceUrl.replace('/staging/', '/%73taging/'); },
    c => { c.sourceUrl = c.sourceUrl.replace(base, 'https://127.0.0.1'); },
    c => { c.sourceUrl += '&token=another'; },
    c => { c.sourceUrl += '&download=1'; },
    c => { c.sourceUrl += '#fragment'; },
    c => { c.approvedUpload.path = staging; },
    c => { c.reviewUploads[0].path = reviews[1]; },
    c => { c.reviewUploads.pop(); },
    c => { c.approvedUpload.token = 'short'; },
    c => { c.publishableKey += '\r\nInjected: yes'; }
  ];
  for (const mutate of mutations) { const c = fixture(); mutate(c); assert.throws(() => validate(c), /STORAGE_CAPABILITY_INVALID/); }
});
test('signed download rejects redirects and oversized bodies through main bounded transport', async () => {
  for (const response of [
    { status: 302, ok: true, body: Readable.from([Buffer.from('x')]) },
    { status: 200, ok: true, body: Readable.from([Buffer.alloc(9)]) }
  ]) {
    const ctx = harness({ fetch: async (_url, options) => { assert.equal(options.redirect, 'error'); assert.ok(options.signal); return response; } });
    await assert.rejects(ctx.signedReferenceDanceDownload(validate(fixture()), Date.now() + 1000), /STORAGE_DOWNLOAD_FAILED/);
    assert.equal(response.body.destroyed, true);
  }
});
test('signed download succeeds without sending service credentials and aborts stalls', async () => {
  const c = validate(fixture());
  const ctx = harness({ fetch: async (url, options) => { assert.equal(url, c.sourceUrl); assert.equal(options.headers, undefined); return { status: 200, ok: true, body: Readable.from([Buffer.from('video')]) }; } });
  assert.equal((await ctx.signedReferenceDanceDownload(c, Date.now() + 1000)).toString(), 'video');
  let signal;
  const stalled = harness({ fetch: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  await assert.rejects(stalled.signedReferenceDanceDownload(c, Date.now() + 30), /VIDEO_CHECK_TIMEOUT/);
  assert.equal(signal.aborted, true);
});
test('signed upload retains descriptor-owned streaming and scoped destination/token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-cap-test-'));
  const file = path.join(dir, 'video.mp4'); fs.writeFileSync(file, 'test video');
  let called = false;
  const c = validate(fixture());
  const ctx = harness({ createClient: (url, key) => {
    assert.equal(url, base); assert.equal(key, c.publishableKey);
    return { storage: { from: bucket => { assert.equal(bucket, 'seedance-reference-video'); return {
      async uploadToSignedUrl(objectPath, token, body, options) {
        called = true; assert.equal(objectPath, approved); assert.equal(token, c.approvedUpload.token);
        assert.equal(options.headers['content-length'], '10');
        let bytes = ''; for await (const chunk of body) bytes += chunk.toString(); assert.equal(bytes, 'test video');
        return { data: {}, error: null };
      }, getPublicUrl: () => ({ data: { publicUrl: `${base}/unused` } })
    }; } } };
  } });
  try { await ctx.signedReferenceDanceUpload(c, c.approvedUpload, file, 'video/mp4', Date.now() + 1000, 'APPROVED_UPLOAD_FAILED'); assert.ok(called); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('capability endpoint completes without service key or worker delete and releases resources', async () => {
  // Reuse main's lifecycle fixture without executing its tests. Only transport
  // is mocked; the full route, validation, probes and ffmpeg sequence execute.
  let fixtureSource = fs.readFileSync(path.join(__dirname, 'worker-lifecycle.test.js'), 'utf8').split('const editBody =')[0];
  fixtureSource = fixtureSource.replace("SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only-key'", "SUPABASE_SERVICE_ROLE_KEY: ''");
  fixtureSource = fixtureSource.replace("return args.operation({ storage:", "if (args.key === 'synthetic-publishable-key') return args.operation({ fetch: async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }) }); return args.operation({ storage:");
  const sandbox = vm.createContext({ require, __dirname, Buffer, setTimeout, clearTimeout, queueMicrotask, global });
  vm.runInContext(`${fixtureSource}\nthis.makeHarness = harness;`, sandbox);
  const h = sandbox.makeHarness();
  const result = await h.post('/reference-dance-inspect', { userId: user, assetId: asset, stagingPath: staging, storageCapabilities: fixture() });
  assert.equal(result.status, 200);
  assert.equal(result.body.approvedPath, approved);
  assert.equal(h.calls.filter(c => c[0] === 'upload').length, 6);
  assert.equal(h.calls.filter(c => c[0] === 'remove' || c[0] === 'privateDownload').length, 0);
  assert.equal(h.calls.filter(c => c[0] === 'cleanup').length, 1);
  assert.equal(h.state(), 0);
});
