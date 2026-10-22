'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'watermark-server/server.js'), 'utf8');
const download = require('../watermark-server/watermark-download.js');
const SECRET = 'synthetic-unit-secret';
const ORIGIN = 'https://unit-test.supabase.co';
const URL = `${ORIGIN}/storage/v1/object/public/reference-images/nested/video.mp4`;
const TASK = '11111111-1111-4111-8111-111111111111';
const validProbe = () => ({ streams: [{ index: 0, codec_type: 'video', width: 1920, height: 1080 }], format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '15' } });

// Real production functions, fake transport/SDK/FFmpeg boundaries: no sockets,
// credentials, user media, or external services are used by this test suite.
function load(options = {}) {
  const routes = new Map();
  const calls = [];
  let jsonLimit;
  const app = { use() {}, get(p, f) { routes.set(`GET ${p}`, f); }, post(p, f) { routes.set(`POST ${p}`, f); }, listen() {} };
  const express = () => app;
  express.json = (config) => { jsonLimit = config.limit; return () => {}; };
  const fakeFs = {
    existsSync: () => true,
    mkdtempSync: () => { if (options.mkdirError) throw new Error('synthetic-disk-full'); return '/tmp/pina-watermark-synthetic'; },
    rmSync: (file, options) => calls.push(['cleanup', file, options]),
    unlinkSync: (file) => calls.push(['unlink', file]),
    statSync: () => ({ size: options.outputBytes ?? 128 }),
    readFileSync: () => Buffer.from('synthetic-output')
  };
  const ffmpeg = (file) => {
    calls.push(['ffmpeg', file]);
    const callbacks = {};
    const command = {
      inputOptions(...args) { calls.push(['inputOptions', ...args]); return command; },
      outputOptions(...args) { calls.push(['outputOptions', ...args]); return command; },
      output() { return command; },
      on(event, fn) { callbacks[event] = fn; return command; },
      run() { queueMicrotask(() => options.ffmpegError ? callbacks.error(new Error(options.ffmpegError)) : callbacks.end()); },
      kill() { calls.push(['kill']); }
    };
    return command;
  };
  const context = vm.createContext({
    Buffer, URL: global.URL, setTimeout: (fn, ms) => setTimeout(fn, options.shortQueue && ms === 20000 ? 5 : ms), clearTimeout, queueMicrotask,
    process: { env: { SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-not-a-key', WATERMARK_SECRET: options.missingSecret ? '' : SECRET } },
    console: { log() {}, error() {} },
    require(name) {
      if (name === 'express') return express;
      if (name === 'fluent-ffmpeg') return ffmpeg;
      if (name === 'ffmpeg-static') return '/unused';
      if (name === '@supabase/supabase-js') return { createClient: () => ({ storage: { from: () => ({
        upload: async () => { calls.push(['upload']); return { error: options.uploadError ? { message: 'private-storage-detail' } : null }; },
        getPublicUrl: () => ({ data: { publicUrl: `${URL}?watermarked=1` } })
      }) } }) };
      if (name === 'node-fetch') return () => { throw new Error('Unexpected network access'); };
      if (name === 'fs') return fakeFs;
      if (name === 'path') return path;
      if (name === 'crypto') return require('node:crypto');
      if (name === 'uuid') return { v4: () => TASK };
      if (name === 'child_process') return { execFile: (command, args, config, callback) => {
        calls.push(['probe', command, args, config]);
        queueMicrotask(() => callback(options.probeError || null, options.probeOutput ?? JSON.stringify(options.probe || validProbe())));
      } };
      if (name === './worker-probe.js') return require('../watermark-server/worker-probe.js');
      if (name === './worker-storage.js') return { uploadStorageFile: async () => {
        calls.push(['upload']);
        if (options.uploadError) throw new Error('synthetic-upload-failure');
        return { publicUrl: `${URL}?watermarked=1` };
      } };
      if (name === './watermark-download.js') return { ...download, downloadWatermarkVideo: async (args) => {
        calls.push(['download', args.url]);
        if (options.downloadError) throw Object.assign(new Error('private-download-detail'), { publicCode: options.downloadError });
        return 128;
      } };
      if (name === './reference-dance-inspection.js') return require('../watermark-server/reference-dance-inspection.js');
      throw new Error(`Unexpected require ${name}`);
    },
    workerFixture: options.workerFixture || (async () => ({ ok: true, watermarkedUrl: URL }))
  });
  vm.runInContext(source, context, { timeout: 1000 });
  if (options.stubWorker) vm.runInContext('runWatermarkJob = workerFixture;', context);
  const api = vm.runInContext('({ acquireSlot, releaseSlot, runWatermarkJob, validateWatermarkProbe, probeWatermarkVideo })', context);
  return {
    api, calls, context,
    jsonLimit: () => jsonLimit,
    state: () => JSON.parse(vm.runInContext('JSON.stringify({ activeJobs, activeEditJobs, queued: jobQueue.length, requests: activeWatermarkRequests, dedup: inFlightWatermarks.size })', context)),
    async request(route, body, authorization = `Bearer ${SECRET}`) {
      const response = { status: 200, headers: {}, body: null };
      const res = {
        set(name, value) { response.headers[name] = value; return res; },
        status(status) { response.status = status; return res; },
        json(data) { response.body = JSON.parse(JSON.stringify(data)); return res; }
      };
      await routes.get(`POST ${route}`)({ headers: { authorization }, body }, res);
      return response;
    }
  };
}

for (const field of ['url', 'video_url']) {
  test(`route does not invent a ${field} alias for existing videoUrl contract`, async () => {
    const server = load({ stubWorker: true });
    const response = await server.request('/watermark', { [field]: URL });
    assert.equal(response.status, 400);
    assert.equal(server.state().requests, 0);
  });
}

test('only videoUrl is authoritative; unrelated URL aliases cannot override it', async () => {
  let seen;
  const server = load({ stubWorker: true, workerFixture: async (url) => { seen = url; return { ok: true }; } });
  const response = await server.request('/watermark', { videoUrl: URL, url: 'http://127.0.0.1/', video_url: 'http://169.254.169.254/' });
  assert.equal(response.status, 200);
  assert.equal(seen, URL);
});

test('URL rejection happens before any download, queue or worker work', async () => {
  const server = load();
  const response = await server.request('/watermark', { videoUrl: 'http://127.0.0.1/private' });
  assert.deepEqual(response.body, { ok: false, error: 'VIDEO_URL_INVALID' });
  assert.equal(response.status, 400);
  assert.deepEqual(server.calls, []);
  assert.equal(server.state().queued, 0);
});

test('host case/default HTTPS port normalize to one deduplicated job', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let count = 0;
  const server = load({ stubWorker: true, workerFixture: () => { count++; return pending; } });
  const first = server.request('/watermark', { videoUrl: URL });
  const second = server.request('/watermark', { videoUrl: URL.replace('unit-test.supabase.co', 'UNIT-TEST.SUPABASE.CO:443') });
  assert.equal(count, 1);
  resolve({ ok: true });
  assert.deepEqual((await Promise.all([first, second])).map((v) => v.status), [200, 200]);
  assert.equal(server.state().dedup, 0);
});

test('duplicate HTTP waiters are capped independently from unique jobs', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  let count = 0;
  const server = load({ stubWorker: true, workerFixture: () => { count++; return pending; } });
  const requests = Array.from({ length: 16 }, () => server.request('/watermark', { videoUrl: URL }));
  const blocked = await server.request('/watermark', { videoUrl: URL });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['Retry-After'], '20');
  assert.equal(blocked.body.error, 'WORKER_BUSY');
  assert.equal(count, 1);
  resolve({ ok: true });
  assert.equal((await Promise.all(requests)).filter((x) => x.status === 200).length, 16);
  assert.equal(server.state().requests, 0);
  assert.equal(server.state().dedup, 0);
  assert.equal((await server.request('/watermark', { videoUrl: URL })).status, 200);
});

test('rejected shared worker promise releases request/dedup bookkeeping and hides details', async () => {
  const server = load({ stubWorker: true, workerFixture: async () => { throw new Error('private-error-secret'); } });
  const result = await server.request('/watermark', { videoUrl: URL });
  assert.deepEqual(result.body, { ok: false, error: 'PROCESSING_FAILED' });
  assert.equal(result.status, 500);
  assert.equal(server.state().requests, 0);
  assert.equal(server.state().dedup, 0);
});

async function fillQueue(server) {
  vm.runInContext('activeJobs = 2;', server.context);
  return { pending: Array.from({ length: 8 }, () => server.api.acquireSlot('watermark', 1000)) };
}
async function drainQueue(server, pending) {
  for (let i = 0; i < 10; i++) server.api.releaseSlot('watermark');
  await Promise.all(pending);
  assert.equal(server.state().activeJobs, 0);
  assert.equal(server.state().queued, 0);
}

test('shared queue caps at eight jobs and does not leak active slots', async () => {
  const server = load();
  const { pending } = await fillQueue(server);
  await assert.rejects(server.api.acquireSlot('watermark'), (error) => error.publicCode === 'WORKER_BUSY' && error.httpStatus === 429);
  assert.equal(server.state().queued, 8);
  await drainQueue(server, pending);
});

test('queue deadline removes its waiter without acquiring a slot', async () => {
  const server = load();
  vm.runInContext('activeJobs = 2;', server.context);
  await assert.rejects(server.api.acquireSlot('watermark', 5), (error) => error.publicCode === 'WORKER_QUEUE_TIMEOUT' && error.httpStatus === 429);
  assert.equal(server.state().queued, 0);
  assert.equal(server.state().activeJobs, 2);
  server.api.releaseSlot(); server.api.releaseSlot();
});

for (const [route, body] of [
  ['/watermark', { videoUrl: URL }],
  ['/edit', { clips: [{ videoUrl: URL }], taskId: TASK, userId: 'synthetic' }],
  ['/reference-dance-inspect', { userId: TASK, assetId: TASK, stagingPath: `staging/${TASK}/${TASK}.mp4` }]
]) {
  test(`${route}: saturated queue returns429, not authentication failure`, async () => {
    const server = load();
    const { pending } = await fillQueue(server);
    const result = await server.request(route, body);
    assert.equal(result.status, 429);
    assert.equal(result.headers['Retry-After'], '20');
    assert.equal(result.body.error, 'WORKER_BUSY');
    assert.equal(server.calls.length, 0);
    await drainQueue(server, pending);
  });
}

test('wrong authentication stays401 even while the queue is saturated', async () => {
  const server = load();
  const { pending } = await fillQueue(server);
  assert.equal((await server.request('/watermark', { videoUrl: URL }, 'Bearer incorrect')).status, 401);
  await drainQueue(server, pending);
});

test('worker JSON parser has a64KiB limit, not a media-upload-sized buffer', () => {
  assert.equal(load().jsonLimit(), '64kb');
});

for (const format of ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'mov']) {
  test(`probe accepts existing supported video container ${format}`, () => {
    const data = validProbe(); data.format.format_name = format;
    assert.equal(load().api.validateWatermarkProbe(data).duration, 15);
  });
}

for (const [name, modify] of [
  ['image format despite video-like stream', (p) => { p.format.format_name = 'image2'; }],
  ['audio only', (p) => { p.streams[0].codec_type = 'audio'; }],
  ['cover image only', (p) => { p.streams[0].disposition = { attached_pic: 1 }; }],
  ['oversized dimensions', (p) => { p.streams[0].width = 100000; }],
  ['missing dimensions', (p) => { delete p.streams[0].width; }],
  ['excessive duration', (p) => { p.format.duration = 181; }],
  ['invalid duration', (p) => { p.format.duration = 'NaN'; }]
]) {
  test(`probe rejects ${name} before encoding`, () => {
    const probe = validProbe(); modify(probe);
    assert.throws(() => load().api.validateWatermarkProbe(probe), (error) => ['VIDEO_FORMAT_INVALID', 'VIDEO_LIMIT_EXCEEDED'].includes(error.publicCode));
  });
}

test('whole worker preserves download→probe→encode→upload order and cleans scratch files', async () => {
  const server = load();
  const result = await server.api.runWatermarkJob(URL);
  assert.equal(result.ok, true);
  assert.deepEqual(server.calls.filter((x) => ['download', 'probe', 'ffmpeg', 'upload'].includes(x[0])).map((x) => x[0]), ['download', 'probe', 'ffmpeg', 'upload']);
  const probeCall = server.calls.find((x) => x[0] === 'probe');
  assert.equal(probeCall[1], 'ffprobe');
  assert.equal(probeCall[3].timeout, 15000);
  assert.equal(probeCall[3].killSignal, 'SIGKILL');
  assert.equal(probeCall[3].maxBuffer, 1024 * 1024);
  assert.equal(probeCall[2].includes('file,pipe'), true);
  assert.deepEqual(server.calls.find((x) => x[0] === 'inputOptions').slice(1), ['-protocol_whitelist', 'file,pipe']);
  const output = server.calls.find((x) => x[0] === 'outputOptions');
  assert.equal(output[output.indexOf('-fs') + 1], String(200 * 1024 * 1024));
  assert.equal(server.calls.filter((x) => x[0] === 'cleanup').length, 1);
  assert.equal(server.state().activeJobs, 0);
});

for (const [name, options, expected, forbidden] of [
  ['download refusal', { downloadError: 'DOWNLOAD_TOO_LARGE' }, 'DOWNLOAD_TOO_LARGE', 'probe'],
  ['probe process failure', { probeError: { killed: true } }, 'VIDEO_UNREADABLE', 'ffmpeg'],
  ['invalid probe JSON', { probeOutput: 'bad-json' }, 'VIDEO_UNREADABLE', 'ffmpeg'],
  ['image in a video response', { probe: { ...validProbe(), format: { duration: 1, format_name: 'png_pipe' } } }, 'VIDEO_FORMAT_INVALID', 'ffmpeg'],
  ['encoding failure', { ffmpegError: 'private-parser-detail' }, 'PROCESSING_FAILED', 'upload'],
  ['oversized output', { outputBytes: 200 * 1024 * 1024 }, 'VIDEO_OUTPUT_TOO_LARGE', 'upload'],
  ['storage failure', { uploadError: true }, 'PROCESSING_FAILED', null]
]) {
  test(`${name}: fails safely and releases files/slot`, async () => {
    const server = load(options);
    const result = await server.api.runWatermarkJob(URL);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, error: expected });
    if (forbidden) assert.equal(server.calls.some((x) => x[0] === forbidden), false);
    assert.equal(server.calls.filter((x) => x[0] === 'cleanup').length, 1);
    assert.equal(server.state().activeJobs, 0);
  });
}

// FFmpeg otherwise chooses the higher-resolution/default stream, not the first
// one inspected. Mapping is part of the validation security boundary.
test('multistream input maps only the validated stream, never an unvalidated default', async () => {
  const probe = validProbe();
  probe.streams[0].index = 3;
  probe.streams.push({ index: 4, codec_type: 'video', width: 100000, height: 100000, disposition: { default: 1 } });
  const server = load({ probe });
  assert.equal((await server.api.runWatermarkJob(URL)).ok, true);
  const output = server.calls.find((call) => call[0] === 'outputOptions');
  assert.equal(output[output.indexOf('-map') + 1], '0:3');
  assert.equal(output.includes('0:a:0?'), true);
  assert.equal(output.includes('0:4'), false);
});

test('missing or invalid selected stream index is rejected before encoding', () => {
  for (const index of [undefined, -1, 0.5, 'bad']) {
    const probe = validProbe(); probe.streams[0].index = index;
    assert.throws(() => load().api.validateWatermarkProbe(probe), (error) => error.publicCode === 'VIDEO_FORMAT_INVALID');
  }
});


test('missing service secret remains503 before queue handling', async () => {
  const server = load({ missingSecret: true });
  const { pending } = await fillQueue(server);
  assert.equal((await server.request('/watermark', { videoUrl: URL })).status, 503);
  assert.equal(server.calls.length, 0);
  await drainQueue(server, pending);
});

for (const [route, body] of [
  ['/watermark', { videoUrl: URL }],
  ['/edit', { clips: [{ videoUrl: URL }], taskId: TASK }],
  ['/reference-dance-inspect', { userId: TASK, assetId: TASK, stagingPath: `staging/${TASK}/${TASK}.mp4` }]
]) {
  test(`${route}: expired queue reports429 and performs no processing`, async () => {
    const server = load({ shortQueue: true });
    vm.runInContext('activeJobs = 2;', server.context);
    const response = await server.request(route, body);
    assert.equal(response.status, 429);
    assert.equal(response.body.error, 'WORKER_QUEUE_TIMEOUT');
    assert.equal(response.headers['Retry-After'], '20');
    assert.equal(server.calls.length, 0);
    assert.equal(server.state().queued, 0);
    assert.equal(server.state().requests, 0);
    server.api.releaseSlot(); server.api.releaseSlot();
  });
}

test('watermark priority and single-edit concurrency remain intact', async () => {
  const server = load();
  vm.runInContext('activeJobs = 2; activeEditJobs = 1;', server.context);
  const order = [];
  const edit = server.api.acquireSlot('edit', 1000).then(() => order.push('edit'));
  const watermark = server.api.acquireSlot('watermark', 1000).then(() => order.push('watermark'));
  server.api.releaseSlot('watermark');
  await Promise.resolve();
  assert.deepEqual(order, ['watermark']);
  assert.equal(server.state().activeEditJobs, 1);
  server.api.releaseSlot('edit');
  await Promise.all([edit, watermark]);
  assert.deepEqual(order, ['watermark', 'edit']);
  assert.equal(server.state().activeEditJobs, 1);
  server.api.releaseSlot('watermark'); server.api.releaseSlot('edit');
  assert.equal(server.state().activeJobs, 0);
  assert.equal(server.state().activeEditJobs, 0);
});

test('temporary directory creation failure still releases the acquired slot', async () => {
  const server = load({ mkdirError: true });
  assert.equal((await server.api.runWatermarkJob(URL)).error, 'PROCESSING_FAILED');
  assert.equal(server.calls.length, 0);
  assert.equal(server.state().activeJobs, 0);
});
