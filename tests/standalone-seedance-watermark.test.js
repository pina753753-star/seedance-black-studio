'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = require('node:path').resolve(__dirname, '../api/seedance-status.js');
const localRequire = createRequire(file);
const source = fs.readFileSync(file, 'utf8');
const origin = 'https://mock.supabase.co';
const raw = 'https://provider.example.test/raw.mp4';
const marked = `${origin}/storage/v1/object/public/reference-images/watermarked/result.mp4`;
function load({ completed = false, snapshot = true, storageFails = false, saveFails = false, subscriber = false } = {}) {
  const calls = [], uploads = [], removals = [];
  const task = { id: 'task-1', user_id: 'owner', api_task_id: 'job-1', api_provider: 'wavespeed', polling_url: 'https://api.wavespeed.ai/api/v3/predictions/job-1/result', status: completed ? 'completed' : 'processing', settings: snapshot ? { watermark_required: !subscriber } : {}, output_url: `${origin}/storage/v1/object/public/reference-images/legacy/raw.mp4` };
  const db = {
    from(table) {
      let fields = '', updating = false;
      const c = {
        select(value) { fields = value; return c; }, update(value) { calls.push(['update', value]); updating = true; return c; },
        eq() { return c; }, in() { return c; }, order() { return c; }, limit() { return c; },
        async maybeSingle() {
          if (table === 'profiles') return { data: { plan: subscriber ? 'premium' : 'free', account_status: 'active' } };
          if (table === 'credit_balances') return { data: { subscription_expires_at: subscriber ? '2099-01-01' : '2000-01-01' } };
          if (fields === 'output_url') return { data: null };
          // Simulate a competing completed/refunded poll: no chargeable task.
          if (fields.includes('credit_cost')) return { data: null };
          return { data: task };
        },
        then(resolve, reject) { return Promise.resolve({ data: updating && !saveFails ? [{ id: task.id }] : [], error: saveFails ? new Error('save') : null }).then(resolve, reject); }
      }; return c;
    },
    rpc() { throw new Error('Unexpected debit/refund'); },
    storage: { from() { return {
      async upload(path, bytes, options) { uploads.push({ path, options }); return { error: null }; },
      getPublicUrl(path) { return { data: { publicUrl: `${origin}/storage/v1/object/public/reference-images/${path}` } }; },
      async remove(paths) { removals.push(...paths); }
    }; } }
  };
  const sandbox = { module: { exports: {} }, Buffer, URL, AbortController, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} }, process: { env: { SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: 'synthetic', WAVESPEED_API_KEY: 'synthetic', WATERMARK_SERVER_URL: 'https://worker.example.test', WATERMARK_SECRET: 'synthetic' } },
    require(name) {
      if (name === '@supabase/supabase-js') return { createClient: () => db };
      if (name === './_lib/confirmed-auth.js') return { requireConfirmedAuth: async () => ({ ok: true, user: { id: 'owner' }, supabase: db }) };
      return localRequire(name);
    },
    async fetch(url, options = {}) {
      calls.push(['fetch', url]);
      if (String(url).endsWith('/result')) return { ok: true, status: 200, async text() { return JSON.stringify({ data: { status: 'completed', outputs: [raw] } }); } };
      if (String(url).endsWith('/watermark')) return { ok: true, async json() { return { watermarkedUrl: marked }; } };
      if (url === raw) return { ok: !storageFails, status: storageFails ? 503 : 200, headers: { get: () => 'video/mp4' }, async arrayBuffer() { return new Uint8Array(2048).buffer; }, async text() { return 'private raw diagnostic'; } };
      if (String(url).startsWith(origin) && options.method === 'HEAD') return { ok: true, headers: { get: key => key === 'content-type' ? 'video/mp4' : '2048' } };
      throw new Error('Unexpected mock request');
    }
  };
  vm.runInNewContext(source, sandbox);
  return { calls, uploads, removals, task, async run() {
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await sandbox.module.exports({ method: 'GET', query: { jobId: 'job-1' }, headers: {} }, res);
    return res;
  } };
}
test('concurrent completion claim loss never returns unwatermarked URL', async () => {
  const h = load(), res = await h.run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.done, false);
  assert.doesNotMatch(JSON.stringify(res.body), /provider\.example|legacy\/raw|watermark-inputs/);
});
test('storage failure masks raw provider payload even when done=false', async () => {
  const h = load({ storageFails: true }), res = await h.run();
  assert.equal(res.body.done, false);
  assert.equal(res.body.storage, null);
  assert.doesNotMatch(JSON.stringify(res.body), /provider\.example|private raw/);
});
test('raw staging uses unguessable temporary path, no long cache, and cleanup', async () => {
  const h = load(); await h.run();
  assert.equal(h.uploads.length, 1);
  assert.match(h.uploads[0].path, /^watermark-inputs\/[a-f0-9-]+\.mp4$/);
  assert.equal(h.uploads[0].options.cacheControl, '0');
  assert.deepEqual(h.removals, [h.uploads[0].path]);
});
test('legacy completed owned output is finished without debit/refund or generation', async () => {
  const h = load({ completed: true, snapshot: false }), res = await h.run();
  assert.equal(res.body.done, true);
  assert.equal(res.body.videoUrl, marked);
  assert.equal(h.calls.filter(c => c[0] === 'fetch').length, 1);
  assert.equal(h.calls.find(c => c[0] === 'update')[1].settings.watermark_required, true);
});
test('legacy finishing persistence failure does not return raw and reports retryable finishing', async () => {
  const h = load({ completed: true, snapshot: false, saveFails: true }), res = await h.run();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'watermark_finish_required');
  assert.doesNotMatch(JSON.stringify(res.body), /legacy\/raw|provider\.example/);
});
test('subscription-earned completed output remains available with no processing call', async () => {
  const h = load({ completed: true, subscriber: true }), res = await h.run();
  assert.equal(res.body.done, true);
  assert.equal(res.body.videoUrl, h.task.output_url);
  assert.equal(h.calls.length, 0);
});
