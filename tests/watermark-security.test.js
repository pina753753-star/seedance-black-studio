'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'watermark-server/server.js'), 'utf8');
const inspection = require('../watermark-server/reference-dance-inspection.js');
const SECRET = 'unit-test-watermark-secret';
const CLIP_URL = 'https://unit-test.supabase.co/storage/v1/object/public/reference-images/clip.mp4';
const TASK_ID = '11111111-1111-4111-8111-111111111111';

// Execute the real route handlers in isolation. No packages are installed,
// no socket is opened, and network, storage and ffmpeg calls fail the test.
// Only the expensive worker functions are replaced with controlled fixtures.
function loadServer(secret, workerOverrides = {}) {
  const routes = new Map();
  const jobs = [];
  const sideEffects = [];
  function forbidden(name) {
    return () => {
      sideEffects.push(name);
      throw new Error(`Unexpected external side effect: ${name}`);
    };
  }
  const app = {
    use() {},
    get(route, handler) { routes.set(`GET ${route}`, handler); },
    post(route, handler) { routes.set(`POST ${route}`, handler); },
    listen() {}
  };
  const express = () => app;
  express.json = () => () => {};
  const ffmpeg = forbidden('ffmpeg');
  ffmpeg.ffprobe = forbidden('ffprobe');
  const env = { SUPABASE_URL: 'https://unit-test.supabase.co' };
  if (secret !== undefined) env.WATERMARK_SECRET = secret;
  const workers = {
    watermark: async (videoUrl) => ({ ok: true, watermarkedUrl: `${CLIP_URL}?watermarked=1` }),
    edit: async (job) => ({ ok: true, videoUrl: `${CLIP_URL}?edited=1` }),
    inspect: async (job) => ({ ok: true }),
    ...workerOverrides
  };
  const context = vm.createContext({
    Buffer, URL, setTimeout, clearTimeout,
    process: { env },
    console: { log() {}, error() {} },
    require(name) {
      if (name === 'express') return express;
      if (name === 'fluent-ffmpeg') return ffmpeg;
      if (name === 'ffmpeg-static') return '/unused/test-fixture-ffmpeg';
      if (name === '@supabase/supabase-js') return { createClient: forbidden('supabase') };
      if (name === 'node-fetch') return forbidden('fetch');
      if (name === 'fs') return new Proxy({}, { get: (_, method) => forbidden(`fs.${String(method)}`) });
      if (name === 'path') return path;
      if (name === 'crypto') return require('node:crypto');
      if (name === 'child_process') return { execFile: forbidden('ffprobe') };
      if (name === './worker-storage.js') return require('../watermark-server/worker-storage.js');
      if (name === './worker-probe.js') return require('../watermark-server/worker-probe.js');
      if (name === './watermark-download.js') return require('../watermark-server/watermark-download.js');
      if (name === 'uuid') return { v4: forbidden('uuid') };
      if (name === './reference-dance-inspection.js') return inspection;
      throw new Error(`Unexpected require: ${name}`);
    },
    async fixtureJob(kind, data) {
      jobs.push({ kind, data: JSON.parse(JSON.stringify(data)) });
      return workers[kind](data);
    }
  });
  vm.runInContext(source, context, { filename: 'watermark-server/server.js', timeout: 1000 });
  vm.runInContext(`
    runWatermarkJob = (videoUrl) => fixtureJob('watermark', videoUrl);
    runEditJob = (job) => fixtureJob('edit', job);
    runReferenceDanceInspection = (job) => fixtureJob('inspect', job);
  `, context);
  return {
    jobs, sideEffects,
    async request(route, { authorization, body = {}, forbidBodyRead = false, method = 'POST' } = {}) {
      const handler = routes.get(`${method} ${route}`);
      assert.equal(typeof handler, 'function');
      const req = { headers: {} };
      if (authorization !== undefined) req.headers.authorization = authorization;
      Object.defineProperty(req, 'body', { get() {
        if (forbidBodyRead) throw new Error('Body was accessed before authorization');
        return body;
      } });
      const response = { status: 200, body: undefined };
      const res = {
        status(status) { response.status = status; return res; },
        json(value) { response.body = JSON.parse(JSON.stringify(value)); return res; }
      };
      await handler(req, res);
      assert.deepEqual(sideEffects, [], 'No external side effects are permitted');
      return response;
    },
    activeJobs() { return vm.runInContext('activeJobs', context); }
  };
}

for (const route of ['/watermark', '/edit']) {
  for (const secret of [undefined, '']) {
    test(`${route}: ${secret === undefined ? 'unset' : 'empty'} secret fails closed before body access`, async () => {
      const server = loadServer(secret);
      const result = await server.request(route, { authorization: `Bearer ${SECRET}`, forbidBodyRead: true });
      assert.deepEqual(result, { status: 503, body: { ok: false, error: 'SERVICE_NOT_CONFIGURED' } });
      assert.deepEqual(server.jobs, []);
      assert.equal(server.activeJobs(), 0);
    });
  }
  for (const authorization of [undefined, '', 'Bearer incorrect-secret', `Basic ${SECRET}`]) {
    test(`${route}: rejects ${authorization === undefined ? 'missing' : authorization === '' ? 'empty' : authorization.startsWith('Basic') ? 'wrong-scheme' : 'wrong-token'} authorization`, async () => {
      const server = loadServer(SECRET);
      const result = await server.request(route, { authorization, forbidBodyRead: true });
      assert.deepEqual(result, { status: 401, body: { ok: false, error: 'Unauthorized' } });
      assert.deepEqual(server.jobs, []);
      assert.equal(server.activeJobs(), 0);
    });
  }
  test(`${route}: correct secret preserves input validation`, async () => {
    const server = loadServer(SECRET);
    const result = await server.request(route, { authorization: `Bearer ${SECRET}` });
    assert.equal(result.status, 400);
    assert.deepEqual(server.jobs, []);
  });
}

test('/watermark: correct secret reaches the existing worker and response', async () => {
  const server = loadServer(SECRET);
  const result = await server.request('/watermark', { authorization: `Bearer ${SECRET}`, body: { videoUrl: CLIP_URL } });
  assert.deepEqual(result, { status: 200, body: { ok: true, watermarkedUrl: `${CLIP_URL}?watermarked=1` } });
  assert.deepEqual(server.jobs, [{ kind: 'watermark', data: CLIP_URL }]);
});

test('/watermark: authorized concurrent retries keep existing in-flight de-duplication', async () => {
  let finish;
  const waiting = new Promise((resolve) => { finish = resolve; });
  const server = loadServer(SECRET, { watermark: () => waiting });
  const request = { authorization: `Bearer ${SECRET}`, body: { videoUrl: CLIP_URL } };
  const first = server.request('/watermark', request);
  const second = server.request('/watermark', request);
  assert.equal(server.jobs.length, 1);
  finish({ ok: true, watermarkedUrl: CLIP_URL });
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, 200);
  await server.request('/watermark', request);
  assert.equal(server.jobs.length, 2, 'Completed entry must be removed from the in-flight map');
});

const editBody = { clips: [{ videoUrl: CLIP_URL }], userId: 'unit-test-user', taskId: TASK_ID };
test('/edit: correct secret preserves validation, slot handling and worker arguments', async () => {
  const server = loadServer(SECRET);
  const result = await server.request('/edit', { authorization: `Bearer ${SECRET}`, body: editBody });
  assert.equal(result.status, 200);
  assert.deepEqual(server.jobs, [{ kind: 'edit', data: {
    clips: editBody.clips, transition: 'cut', ownerSegment: 'unit-test-user', outputId: TASK_ID
  } }]);
  assert.equal(server.activeJobs(), 0);
});

for (const [route, worker, body] of [['/watermark', 'watermark', { videoUrl: CLIP_URL }], ['/edit', 'edit', editBody]]) {
  test(`${route}: authorized worker failure preserves error response`, async () => {
    const server = loadServer(SECRET, { [worker]: async () => ({ ok: false, error: 'fixture-failure' }) });
    const result = await server.request(route, { authorization: `Bearer ${SECRET}`, body });
    assert.deepEqual(result, { status: 500, body: { ok: false, error: 'fixture-failure' } });
    assert.equal(server.jobs.length, 1);
    assert.equal(server.activeJobs(), 0);
  });
}

test('/edit: correct secret does not bypass URL allowlist', async () => {
  const server = loadServer(SECRET);
  const result = await server.request('/edit', { authorization: `Bearer ${SECRET}`, body: {
    ...editBody, clips: [{ videoUrl: 'https://untrusted.invalid/clip.mp4' }]
  } });
  assert.equal(result.status, 400);
  assert.deepEqual(server.jobs, []);
});

test('health route remains available without the secret', async () => {
  const result = await loadServer().request('/', { method: 'GET' });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test('reference inspection retains its existing fail-closed behavior', async () => {
  const result = await loadServer().request('/reference-dance-inspect', { forbidBodyRead: true });
  assert.deepEqual(result, { status: 503, body: { ok: false, error: 'SERVICE_NOT_CONFIGURED' } });
  const denied = await loadServer(SECRET).request('/reference-dance-inspect', { authorization: 'Bearer incorrect', forbidBodyRead: true });
  assert.equal(denied.status, 401);
  const allowed = await loadServer(SECRET).request('/reference-dance-inspect', { authorization: `Bearer ${SECRET}`, body: {
    userId: 'unit-test-user', assetId: TASK_ID, stagingPath: 'fixture'
  } });
  assert.equal(allowed.status, 200);
});

test('runtime configuration selects the verified Node 24 security release', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'watermark-server/Dockerfile'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'watermark-server/package.json'), 'utf8'));
  assert.match(dockerfile, /^FROM node:24\.22\.1-bookworm-slim\n/);
  assert.equal(pkg.engines.node, '>=24.22.1 <25');
});
