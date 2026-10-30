'use strict';
// Status polling for a Kling dance task. The real api/seedance-status.js runs in a
// vm with an in-memory generation_tasks table, a mocked provider and storage.
// No network, no real credit transaction, no generation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';
const JOB = 'pred-kling-1';
const POLL = `https://api.wavespeed.ai/api/v3/predictions/${JOB}/result`;
const OUT = 'https://cdn.example.test/kling-output.mp4';

function setup({ provider = () => ({ status: 200, body: { data: { status: 'processing' } } }), taskOverrides = {} } = {}) {
  const tasks = [{
    id: 'task-1', user_id: USER, api_task_id: JOB, polling_url: POLL, api_provider: 'wavespeed', status: 'processing',
    credit_cost: 190, prompt: 'dance', mode: 'reference_to_video', output_url: null, watermarked_url: null,
    settings: { watermark_required: false, dance_method: 'kling_v3_motion_control', reference_dance: { asset_id: 'a', billable_seconds: 10 } },
    created_at: new Date().toISOString(), ...taskOverrides
  }];
  const rpcCalls = [], fetchCalls = [], uploads = [];
  function table(name) {
    const filters = [];
    let patch = null, order = false, lim = null;
    const rows = () => (name === 'generation_tasks' ? tasks : []).filter(r => filters.every(f => f(r)));
    const chain = {
      select() { return chain; },
      eq(k, v) { filters.push(r => r[k] === v); return chain; },
      in(k, v) { filters.push(r => v.includes(r[k])); return chain; },
      order() { order = true; return chain; },
      limit(n) { lim = n; return chain; },
      update(v) { patch = v; return chain; },
      maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
      then(resolve, reject) {
        let out;
        if (patch) { const hit = rows(); hit.forEach(r => Object.assign(r, patch)); out = { data: hit.map(r => ({ id: r.id })), error: null }; }
        else out = { data: rows().slice(0, lim || undefined), error: null };
        return Promise.resolve(out).then(resolve, reject);
      }
    };
    return chain;
  }
  const db = {
    from: table,
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      const t = tasks.find(r => r.id === args.p_task_id);
      if (name === 'refund_generation_task_atomic' && t && ['queued', 'processing'].includes(t.status)) { t.status = 'failed'; return { data: { ok: true, code: 'refunded' }, error: null }; }
      if (name === 'refund_generation_task_atomic') return { data: { ok: true, code: 'already_refunded' }, error: null };
      throw new Error('unexpected rpc ' + name);
    },
    storage: { from: () => ({
      async upload(p, buf) { uploads.push(p); return { error: null }; },
      getPublicUrl: (p) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/reference-images/${p}` } })
    }) }
  };
  const filename = path.resolve(__dirname, '../api/seedance-status.js');
  const localRequire = createRequire(filename);
  const stubs = {
    '@supabase/supabase-js': { createClient: () => db },
    './_lib/credit-access': { readSubscriptionAccess: async () => ({ ok: true }), taskRequiresWatermark: () => false },
    './_lib/confirmed-auth.js': { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER }, supabase: db }) }
  };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, Buffer, URL, URLSearchParams, setTimeout, clearTimeout, AbortController,
    require: (n) => Object.hasOwn(stubs, n) ? stubs[n] : localRequire(n),
    process: { env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', WAVESPEED_API_KEY: 'mock', FLOWVID_VIDEO_BUCKET: 'reference-images' } },
    console: { log() {}, warn() {}, error() {} },
    fetch: async (url, opts = {}) => {
      fetchCalls.push(String(url));
      if (String(url) === POLL) {
        const r = provider();
        if (r.throw) throw new Error('network down');
        return { ok: r.status < 300, status: r.status, async text() { return JSON.stringify(r.body); } };
      }
      const video = Buffer.alloc(4096, 1);
      const headers = { get: (k) => ({ 'content-type': 'video/mp4', 'content-length': String(video.length), 'content-range': `bytes 0-1023/${video.length}` }[k.toLowerCase()] || null) };
      return { ok: true, status: opts.headers?.Range ? 206 : 200, headers, body: { cancel: async () => {} }, async arrayBuffer() { return video; }, async text() { return ''; } };
    }
  }, { filename });
  const handler = mod.exports;
  async function poll() {
    const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {} };
    await handler({ method: 'POST', query: { pollingUrl: POLL }, headers: {} }, res);
    return res;
  }
  return { poll, tasks, rpcCalls, fetchCalls, uploads };
}

test('processing: stays active, no refund, no state change', async () => {
  const s = setup();
  const r = await s.poll();
  assert.equal(r.code, 200);
  assert.equal(r.body.done, false);
  assert.equal(s.rpcCalls.length, 0);
  assert.equal(s.tasks[0].status, 'processing');
});

test('completed: saves the video once, settles at the reserved 190 cr (no cost-based delta), keeps dance_method, replay is idempotent', async () => {
  const s = setup({ provider: () => ({ status: 200, body: { data: { status: 'completed', outputs: [OUT] } } }) });
  const first = await s.poll();
  assert.equal(first.code, 200, JSON.stringify(first.body));
  assert.equal(first.body.done, true);
  assert.match(first.body.videoUrl, /\/storage\/v1\/object\/public\//);
  assert.equal(s.tasks[0].status, 'completed');
  assert.equal(s.tasks[0].output_url, first.body.videoUrl);
  assert.equal(s.tasks[0].settings.dance_method, 'kling_v3_motion_control');
  assert.equal(s.tasks[0].settings.credit_settlement.final_credits, 190);
  assert.equal(s.tasks[0].settings.credit_settlement.estimated_credits, 190);
  assert.equal(s.rpcCalls.length, 0);
  const uploadsAfterFirst = s.uploads.length;
  const second = await s.poll();
  assert.equal(second.body.done, true);
  assert.equal(second.body.videoUrl, first.body.videoUrl);
  assert.equal(s.uploads.length, uploadsAfterFirst);
  assert.equal(s.rpcCalls.length, 0);
});

test('confirmed provider failure: refunded exactly once; later polls do not refund again', async () => {
  const s = setup({ provider: () => ({ status: 200, body: { data: { status: 'failed', error: 'bad input' } } }) });
  const first = await s.poll();
  assert.equal(first.body.refunded, true);
  assert.equal(s.rpcCalls.filter(c => c.name === 'refund_generation_task_atomic').length, 1);
  assert.equal(s.tasks[0].status, 'failed');
  await s.poll();
  await s.poll();
  assert.equal(s.rpcCalls.length, 1, 'terminal task is not looked up as refundable again');
});

test('transient status failures never refund, re-create or re-charge: provider 502/503, thrown network error, non-JSON body', async () => {
  for (const provider of [
    () => ({ status: 502, body: { message: 'bad gateway' } }),
    () => ({ status: 503, body: { error: 'unavailable' } }),
    () => ({ throw: true })
  ]) {
    const s = setup({ provider });
    const r = await s.poll();
    assert.ok(r.code >= 500, String(r.code));
    assert.equal(s.rpcCalls.length, 0);
    assert.equal(s.tasks[0].status, 'processing');
    assert.equal(s.fetchCalls.every(u => u === POLL), true, 'only the status URL is read; no generation endpoint is called');
  }
});

test('another user\'s task is not found', async () => {
  const s = setup({ taskOverrides: { user_id: 'someone-else' } });
  const r = await s.poll();
  assert.equal(r.code, 404);
  assert.equal(s.rpcCalls.length, 0);
});

test('existing 16-20 s motion tasks (character_orientation video) keep working whatever the feature gate: complete at the reserved amount, replay is idempotent, failure refunds once', async () => {
  const settings = { watermark_required: false, dance_method: 'kling_v3_motion_control', character_orientation: 'video', reference_dance: { asset_id: 'a', billable_seconds: 20, duration_ms: 20000 } };
  const done = setup({ taskOverrides: { credit_cost: 380, settings }, provider: () => ({ status: 200, body: { data: { status: 'completed', outputs: [OUT] } } }) });
  const first = await done.poll();
  assert.equal(first.body.done, true);
  assert.equal(done.tasks[0].settings.credit_settlement.final_credits, 380);
  assert.equal(done.tasks[0].settings.character_orientation, 'video');
  assert.equal((await done.poll()).body.videoUrl, first.body.videoUrl);
  assert.equal(done.rpcCalls.length, 0);
  const failed = setup({ taskOverrides: { credit_cost: 380, settings }, provider: () => ({ status: 200, body: { data: { status: 'failed', error: 'x' } } }) });
  assert.equal((await failed.poll()).body.refunded, true);
  await failed.poll();
  assert.equal(failed.rpcCalls.filter(c => c.name === 'refund_generation_task_atomic').length, 1);
});
