'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { withStorageDeadline, uploadStorageFile } = require('../watermark-server/worker-storage.js');
let sdkCreateClient, Response;
try { sdkCreateClient = require('@supabase/supabase-js').createClient; Response = require('node-fetch').Response; } catch (_) {}
const source = fs.readFileSync(path.join(__dirname, '../watermark-server/server.js'), 'utf8');
const base = 'https://unit-test.supabase.co';
const objectPath = 'approved/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.mp4';
function harness(fetch) {
  const context = vm.createContext({ URL, Buffer, SUPABASE_URL: base, REFERENCE_DANCE_BUCKET: 'seedance-reference-video', REFERENCE_DANCE_MAX_BYTES: 1024,
    referenceDanceError: code => Object.assign(new Error(code), { publicCode: code }), referenceDanceRemainingMs: deadline => deadline - Date.now(),
    withStorageDeadline, uploadStorageFile, createClient: sdkCreateClient, fetch });
  vm.runInContext(source.slice(source.indexOf('function validateReferenceDanceStorageCapabilities('), source.indexOf('async function runReferenceDanceInspection(')), context);
  return context;
}
for (const outcome of ['success', 'stalled response']) {
  test(`real SDK signed-upload adapter preserves bounded streaming: ${outcome}`, { skip: !sdkCreateClient || !Response }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dance-sdk-upload-'));
    const file = path.join(dir, 'video.mp4');
    fs.writeFileSync(file, 'test video');
    let calls = 0, signal, body;
    const token = 'synthetic-path-scoped-token';
    const key = 'sb_publishable_syntheticKey';
    const ctx = harness(async (url, options) => {
      calls++; signal = options.signal; body = options.body;
      assert.equal(url, `${base}/storage/v1/object/upload/sign/seedance-reference-video/${objectPath}?token=${token}`);
      assert.equal(options.method, 'PUT');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.get('content-length'), '10');
      assert.equal(options.headers.get('content-type'), 'video/mp4');
      assert.equal(options.headers.get('apikey'), key);
      assert.equal(typeof body.pipe, 'function');
      let bytes = ''; for await (const chunk of body) bytes += chunk.toString();
      assert.equal(bytes, 'test video');
      if (outcome === 'stalled response') return new Promise(() => {});
      return new Response(JSON.stringify({ Key: `seedance-reference-video/${objectPath}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const result = ctx.signedReferenceDanceUpload({ baseUrl: base, publishableKey: key }, { path: objectPath, token }, file, 'video/mp4', Date.now() + (outcome === 'success' ? 1000 : 100), 'APPROVED_UPLOAD_FAILED');
      if (outcome === 'stalled response') await assert.rejects(result, /VIDEO_CHECK_TIMEOUT/);
      else await result;
      assert.equal(calls, 1);
      assert.equal(signal.aborted, true);
      assert.equal(body.destroyed, true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
