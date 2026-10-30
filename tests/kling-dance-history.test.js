'use strict';
// History rows expose the dance method only when the saved task settings carry the
// one known value; nothing else from settings is exposed and no SQL is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const VIDEO = 'https://x.supabase.co/storage/v1/object/public/reference-images/generated-videos/a.mp4';
function task(id, settings) {
  return { id, api_task_id: 'job-' + id, user_id: 'u1', status: 'completed', output_url: VIDEO, watermarked_url: '', api_provider: 'wavespeed', model: 'bytedance/seedance-2.5', mode: 'reference_to_video', prompt: 'p', settings, created_at: new Date().toISOString(), duration_seconds: 8, aspect_ratio: '16:9' };
}
async function history(tasks) {
  const chain = { select() { return chain; }, eq() { return chain; }, not() { return chain; }, order() { return chain; }, limit() { return chain; }, then(res, rej) { return Promise.resolve({ data: tasks, error: null }).then(res, rej); } };
  const client = { from: () => chain, auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } };
  const filename = path.resolve(__dirname, '../api/generated-videos.js');
  const localRequire = createRequire(filename);
  const stubs = { '@supabase/supabase-js': { createClient: () => client }, './_lib/credit-access': { readSubscriptionAccess: async () => ({ ok: true }), taskRequiresWatermark: () => false } };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, URL, AbortController, setTimeout, clearTimeout,
    require: (n) => Object.hasOwn(stubs, n) ? stubs[n] : localRequire(n),
    process: { env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } },
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, status: 200, headers: { get: (k) => ({ 'content-type': 'video/mp4', 'content-length': '4096' }[k.toLowerCase()] || null) }, body: { cancel: async () => {} } })
  }, { filename });
  const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.exports({ query: { limit: '50' }, headers: { authorization: 'Bearer t' } }, res);
  return res.body;
}

test('kling dance tasks are identifiable; every other task (incl. Seedance dance) is not', async () => {
  const body = await history([
    task('k', { dance_method: 'kling_v3_motion_control', reference_dance: { asset_id: 'a' } }),
    task('s', { reference_dance: { asset_id: 'a' } }),
    task('n', {}),
    task('x', { dance_method: 'something_else' })
  ]);
  assert.equal(body.ok, true);
  const by = Object.fromEntries(body.rows.map(r => [r.id, r]));
  assert.equal(by.k.dance_method, 'kling_v3_motion_control');
  assert.equal(by.s.dance_method, '');
  assert.equal(by.n.dance_method, '');
  assert.equal(by.x.dance_method, '');
  assert.equal(by.k.mode, 'reference_to_video');
  assert.equal('settings' in by.k, false);
});
