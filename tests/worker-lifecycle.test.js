'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../watermark-server/server.js'), 'utf8');
const { isAllowedWatermarkUrl } = require('../watermark-server/watermark-download.js');
const URL = 'https://unit-test.supabase.co/storage/v1/object/public/reference-images/nested/video.mp4';
const ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'synthetic-lifecycle-secret';
const error = (publicCode) => Object.assign(new Error(publicCode), { publicCode });
function harness(options = {}) {
  const calls = [];
  const routes = new Map();
  let now = 1700000000000;
  let probeCount = 0;
  let uploadCount = 0;
  const app = { use() {}, get() {}, post(p, f) { routes.set(p, f); }, listen() {} };
  const express = () => app; express.json = () => () => {};
  const fakeFs = {
    mkdtempSync: (prefix) => { calls.push(['mkdir', prefix]); if (options.mkdirError) throw new Error('synthetic'); return `${prefix}owned-fixture`; },
    rmSync: (dir) => calls.push(['cleanup', dir]),
    statSync: () => ({ size: 100 }),
    readFileSync: () => Buffer.from('synthetic-approved-file'),
    writeFileSync: (file) => calls.push(['write', file])
  };
  function ffmpeg(file) {
    calls.push(['ffmpeg', file]);
    const callbacks = {};
    const command = {
      on(event, fn) { callbacks[event] = fn; return command; },
      run() {
        if (options.runThrows) throw new Error('synthetic synchronous run error');
        now += options.advancePerEncode || 0;
        if (options.lateStart) setTimeout(() => callbacks.start?.('synthetic'), 20);
        else queueMicrotask(() => { callbacks.start?.('synthetic'); callbacks.end?.(); });
      },
      kill(signal) { calls.push(['kill', signal]); }
    };
    for (const method of ['inputOptions', 'outputOptions', 'input', 'inputFormat', 'output', 'complexFilter', 'seekInput', 'frames']) {
      command[method] = (...args) => { calls.push([method, ...args]); return command; };
    }
    return command;
  }
  ffmpeg.ffprobe = () => { throw new Error('Legacy unkillable probe must not be called'); };
  const storage = {
    async download(objectPath) {
      calls.push(['privateDownload', objectPath]);
      if (options.stagingMissing && objectPath.startsWith('staging/')) return { data: null, error: { statusCode: 404 } };
      return { error: null, data: { async arrayBuffer() { calls.push(['blobConversion']); return Uint8Array.from([1, 2, 3]).buffer; } } };
    },
    async remove(paths) { calls.push(['remove', ...paths]); return { error: null }; }
  };
  const context = vm.createContext({
    Buffer, URL: global.URL, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } },
    process: { env: { SUPABASE_URL: 'https://unit-test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-only-key', WATERMARK_SECRET: SECRET } },
    console: { log() {}, error() {} },
    require(name) {
      if (name === 'express') return express;
      if (name === 'fluent-ffmpeg') return ffmpeg;
      if (name === 'ffmpeg-static') return '/unused';
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'crypto') return require('node:crypto');
      if (name === 'uuid') return { v4: () => ID };
      if (name === 'child_process') return { execFile() { throw new Error('Probe helper is stubbed'); } };
      if (name === 'node-fetch') return () => { throw new Error('No network allowed'); };
      if (name === '@supabase/supabase-js') return { createClient() { throw new Error('Storage helper must own its client'); } };
      if (name === './worker-probe.js') return { async probeVideoFile(args) {
        calls.push(['probe', args.filePath, args.timeoutMs]); probeCount++;
        if (options.probeError && probeCount === (options.probeErrorAt || 1)) throw error(options.probeError);
        return { format: { format_name: 'mov,mp4', duration: '4' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 240, r_frame_rate: '24/1' }] };
      } };
      if (name === './watermark-download.js') return { isAllowedWatermarkUrl, async downloadWatermarkVideo(args) {
        calls.push(['download', args.url, args.timeoutMs, args.maxBytes]);
        if (options.downloadError) throw error(options.downloadError);
        now += options.advancePerDownload || 0;
        return 100;
      } };
      if (name === './worker-storage.js') return {
        async uploadStorageFile(args) {
          calls.push(['upload', args.bucket, args.objectPath, args.upsert, args.contentType, args.timeoutMs, args.filePath]);
          uploadCount++;
          if (options.uploadError && uploadCount === (options.uploadErrorAt || 1)) throw error(options.uploadError);
          return { publicUrl: `https://unit-test.supabase.co/storage/v1/object/public/${args.bucket}/${args.objectPath}` };
        },
        async withStorageDeadline(args) {
          calls.push(['storageDeadline', args.timeoutMs, args.maxResponseBytes]);
          if (options.storageError) throw error(options.storageError);
          return args.operation({ storage: { from(bucket) { assert.equal(bucket, 'seedance-reference-video'); return storage; } } });
        }
      };
      if (name === './reference-dance-inspection.js') return require('../watermark-server/reference-dance-inspection.js');
      throw new Error(`Unexpected require ${name}`);
    }
  });
  vm.runInContext(source, context, { timeout: 1000 });
  const api = vm.runInContext('({ editDownload, editProbe, referenceDanceProbe, probeWatermarkVideo, runFfmpeg })', context);
  return { calls, api, now: () => now,
    state: () => vm.runInContext('activeJobs + activeEditJobs + activeWatermarkRequests + jobQueue.length + inFlightWatermarks.size', context),
    async post(route, body, authorization = `Bearer ${SECRET}`) {
      const result = { status: 200 };
      const res = { status(code) { result.status = code; return res; }, set() { return res; }, json(data) { result.body = JSON.parse(JSON.stringify(data)); return res; } };
      await routes.get(route)({ body, headers: { authorization } }, res);
      return result;
    }
  };
}
const editBody = { clips: [{ videoUrl: URL }], taskId: ID, userId: ID };
const referenceBody = { userId: ID, assetId: ID, stagingPath: `staging/${ID}/${ID}.mp4` };

test('watermark upload timeout releases its slot, shared promise and owned directory', async () => {
  const h = harness({ uploadError: 'UPLOAD_TIMEOUT' });
  const result = await h.post('/watermark', { videoUrl: URL });
  assert.equal(result.status, 500); assert.equal(result.body.error, 'UPLOAD_TIMEOUT');
  assert.equal(h.state(), 0);
  assert.equal(h.calls.filter((call) => call[0] === 'cleanup').length, 1);
});

test('edit keeps deterministic output identity and streams through bounded helper', async () => {
  const h = harness(); const result = await h.post('/edit', editBody);
  assert.equal(result.status, 200);
  const upload = h.calls.find((call) => call[0] === 'upload');
  assert.deepEqual(upload.slice(1, 6), ['reference-images', `edited/${ID}/${ID}.mp4`, false, 'video/mp4', 60000]);
  assert.equal(upload[6].startsWith('/tmp/pina-edit-owned-fixture/'), true);
  assert.equal(h.state(), 0);
  assert.equal(h.calls.filter((call) => call[0] === 'cleanup').length, 1);
});

for (const [name, options, expected] of [
  ['stalled body', { downloadError: 'DOWNLOAD_TIMEOUT' }, 'Video processing exceeded its time limit'],
  ['oversized body', { downloadError: 'DOWNLOAD_TOO_LARGE' }, 'One of the clips exceeds the maximum allowed file size'],
  ['broken body', { downloadError: 'DOWNLOAD_FAILED' }, 'Failed to download one of the clips'],
  ['probe timeout', { probeError: 'PROBE_TIMEOUT' }, 'Video processing exceeded its time limit'],
  ['probe process error', { probeError: 'PROBE_FAILED' }, 'One of the clips could not be read'],
  ['upload timeout', { uploadError: 'UPLOAD_TIMEOUT' }, 'Video processing exceeded its time limit'],
  ['upload failure', { uploadError: 'UPLOAD_FAILED' }, 'Failed to store the edited video'],
  ['synchronous encode error', { runThrows: true }, 'Video processing failed']
]) {
  test(`edit ${name} closes its request lifecycle`, async () => {
    const h = harness(options); const result = await h.post('/edit', editBody);
    assert.equal(result.status, 500); assert.equal(result.body.error, expected);
    assert.equal(h.state(), 0);
    assert.equal(h.calls.filter((call) => call[0] === 'cleanup').length, 1);
  });
}

test('edit final upload consumes only the remaining shared five-minute budget', async () => {
  const h = harness({ advancePerEncode: 130000 });
  assert.equal((await h.post('/edit', editBody)).status, 200);
  assert.equal(h.calls.find((call) => call[0] === 'upload')[5], 40000);
});

test('edit does not upload after its shared deadline is exhausted', async () => {
  const h = harness({ advancePerEncode: 160000 });
  const result = await h.post('/edit', editBody);
  assert.equal(result.body.error, 'Video processing exceeded its time limit');
  assert.equal(h.calls.some((call) => call[0] === 'upload'), false);
  assert.equal(h.state(), 0);
});

test('sub-second remaining download/probe budgets are not extended to one second', async () => {
  const h = harness();
  await h.api.editDownload(URL, '/tmp/synthetic.mp4', h.now() + 2);
  await h.api.editProbe('/tmp/synthetic.mp4', h.now() + 2);
  assert.equal(h.calls.find((call) => call[0] === 'download')[2], 2);
  assert.equal(h.calls.find((call) => call[0] === 'probe')[2], 2);
});

test('already-exhausted budgets do not start network, probe or encoder work', async () => {
  const h = harness();
  await assert.rejects(h.api.editDownload(URL, '/tmp/synthetic.mp4', h.now()), (e) => e.publicCode === 'PROCESSING_TIMEOUT');
  await assert.rejects(h.api.editProbe('/tmp/synthetic.mp4', h.now()), (e) => e.publicCode === 'PROCESSING_TIMEOUT');
  await assert.rejects(h.api.referenceDanceProbe('/tmp/synthetic.mp4', 0), (e) => e.publicCode === 'VIDEO_CHECK_TIMEOUT');
  await assert.rejects(h.api.runFfmpeg(() => { throw new Error('must not build'); }, 0), /timed out/);
  assert.deepEqual(h.calls, []);
});

test('edit preserves own reference-images URL contract and rejects other buckets', async () => {
  const h = harness();
  const body = (url) => ({ ...editBody, clips: [{ videoUrl: url }] });
  const encoded = URL.replace('unit-test.supabase.co', 'UNIT-TEST.SUPABASE.CO:443').replace('video.mp4', '%E6%97%A5%E6%9C%AC%20name%2520.mp4?download');
  assert.equal((await h.post('/edit', body(encoded))).status, 200);
  assert.equal((await h.post('/edit', body(URL.replace('reference-images', 'alternate-public')))).status, 400);
  assert.equal((await h.post('/edit', body(URL.replace('https://', 'https://user:password@')))).status, 400);
});

for (const [method, expected] of [['probeWatermarkVideo', 'VIDEO_PROBE_TIMEOUT'], ['editProbe', 'PROCESSING_TIMEOUT'], ['referenceDanceProbe', 'VIDEO_CHECK_TIMEOUT']]) {
  test(`${method} preserves route-owned timeout mapping`, async () => {
    const h = harness({ probeError: 'PROBE_TIMEOUT' });
    const budget = method === 'editProbe' ? h.now() + 100 : 100;
    await assert.rejects(h.api[method]('/tmp/synthetic.mp4', budget), (e) => e.publicCode === expected);
  });
}

test('reference success keeps private staging/approved/review paths, upsert and delete order', async () => {
  const h = harness(); const result = await h.post('/reference-dance-inspect', referenceBody);
  assert.equal(result.status, 200);
  assert.equal(h.calls.some((call) => call[0] === 'download'), false, 'public downloader is never used for private files');
  assert.deepEqual(h.calls.find((call) => call[0] === 'privateDownload'), ['privateDownload', referenceBody.stagingPath]);
  const uploads = h.calls.filter((call) => call[0] === 'upload');
  assert.equal(uploads.length, 6);
  assert.equal(uploads.every((call) => call[1] === 'seedance-reference-video' && call[3] === true), true);
  assert.equal(uploads[0][2], `approved/${ID}/${ID}.mp4`);
  assert.equal(uploads[5][2], `review/${ID}/${ID}/frame-5.jpg`);
  assert.equal(h.calls.findIndex((call) => call[0] === 'remove') > h.calls.lastIndexOf(uploads[5]), true);
  assert.deepEqual(h.calls.find((call) => call[0] === 'remove'), ['remove', referenceBody.stagingPath]);
  assert.equal(h.calls.find((call) => call[0] === 'storageDeadline')[2], 50 * 1024 * 1024);
  assert.equal(h.calls.some((call) => call[0] === 'blobConversion'), true);
  assert.equal(h.state(), 0);
});

test('reference missing staging still falls back only to its deterministic approved object', async () => {
  const h = harness({ stagingMissing: true });
  assert.equal((await h.post('/reference-dance-inspect', referenceBody)).status, 200);
  assert.deepEqual(h.calls.filter((call) => call[0] === 'privateDownload').map((call) => call[1]), [referenceBody.stagingPath, `approved/${ID}/${ID}.mp4`]);
});

for (const [name, options, expected] of [
  ['private download timeout', { storageError: 'STORAGE_TIMEOUT' }, 'VIDEO_CHECK_TIMEOUT'],
  ['private transport failure', { storageError: 'STORAGE_FAILED' }, 'STORAGE_FAILED'],
  ['first probe timeout', { probeError: 'PROBE_TIMEOUT' }, 'VIDEO_CHECK_TIMEOUT'],
  ['approved probe timeout', { probeError: 'PROBE_TIMEOUT', probeErrorAt: 2 }, 'VIDEO_CHECK_TIMEOUT'],
  ['approved upload timeout', { uploadError: 'UPLOAD_TIMEOUT' }, 'VIDEO_CHECK_TIMEOUT'],
  ['review upload timeout', { uploadError: 'UPLOAD_TIMEOUT', uploadErrorAt: 2 }, 'VIDEO_CHECK_TIMEOUT'],
  ['review upload failure', { uploadError: 'UPLOAD_FAILED', uploadErrorAt: 2 }, 'REVIEW_UPLOAD_FAILED']
]) {
  test(`reference ${name} aborts the remaining workflow without deleting staging`, async () => {
    const h = harness(options); const result = await h.post('/reference-dance-inspect', referenceBody);
    assert.equal(result.status, 422); assert.equal(result.body.error, expected);
    assert.equal(h.calls.some((call) => call[0] === 'remove'), false);
    assert.equal(h.calls.filter((call) => call[0] === 'cleanup').length, 1);
    assert.equal(h.state(), 0);
  });
}

test('reference auth/private-path rejection does not invoke storage', async () => {
  const h = harness();
  assert.equal((await h.post('/reference-dance-inspect', referenceBody, 'Bearer wrong')).status, 401);
  assert.equal((await h.post('/reference-dance-inspect', { ...referenceBody, stagingPath: `approved/${ID}/${ID}.mp4` })).status, 422);
  assert.deepEqual(h.calls, []);
  assert.equal(h.state(), 0);
});

test('encoder starting after its watchdog expired is killed rather than orphaned', async () => {
  const h = harness({ lateStart: true });
  // Access the actual common watchdog with a controlled late-starting command.
  let starts;
  let kills = 0;
  const command = { on(event, fn) { if (event === 'start') starts = fn; return command; }, run() { setTimeout(() => starts(), 20); }, kill(signal) { assert.equal(signal, 'SIGKILL'); kills++; } };
  await assert.rejects(h.api.runFfmpeg(() => command, 5), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(kills, 2);
});
