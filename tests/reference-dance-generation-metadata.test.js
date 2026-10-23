'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { validateReadyReferenceDance } = require('../api/_lib/reference-dance.js');

const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';
const ASSET = '270bf01a-bafd-4255-8ad5-e18a4f1c8c47';
function readyRow(overrides = {}) {
  return {
    id: ASSET, user_id: USER, status: 'ready',
    approved_path: `approved/${USER}/${ASSET}.mp4`, size_bytes: 1024,
    duration_ms: 15000, billable_seconds: 15, width: 1920, height: 1080,
    video_codec: 'h264', sha256: 'a'.repeat(64),
    rights_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(), ...overrides
  };
}

// Load the real handler in an isolated module with all network/DB boundaries
// mocked. No generation, storage write, or credit transaction leaves this test.
async function runStart({ dance = true, row = readyRow(), role = 'admin', settingsFail = false, expireBeforeRetention = false } = {}) {
  const rpcCalls = [], updates = [], providerCalls = [];
  const db = {
    from(table) {
      let update;
      const predicates = [];
      const result = () => {
        if (update) {
          if (table === 'seedance_reference_video_uploads' && update.expires_at) {
            const current = expireBeforeRetention ? { ...row, expires_at: '2000-01-01T00:00:00.000Z' } : row;
            if (!predicates.every(predicate => predicate(current))) return { data: [], error: null };
          }
          if (settingsFail && table === 'generation_tasks' && update.settings) return { data: [], error: { message: 'settings unavailable' } };
          return { data: [{ id: 'task-1' }], error: null };
        }
        if (table === 'profiles') return { data: { id: USER, email: 'admin@example.test', role }, error: null };
        if (table === 'seedance_reference_video_uploads') return { data: row, error: null };
        if (table === 'credit_balances') return { data: { free_credits: 5000 }, error: null };
        throw new Error(`Unexpected read: ${table}`);
      };
      const chain = {
        select() { return chain; }, eq() { return chain; }, in() { return chain; }, is() { return chain; },
        gt(key, value) { predicates.push(current => current[key] > value); return chain; },
        update(value) { update = value; updates.push({ table, value }); return chain; },
        maybeSingle() { return Promise.resolve(result()); },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
      };
      return chain;
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === 'reserve_generation_task') return { data: { task_id: 'task-1' }, error: null };
      if (name === 'deduct_generation_credits_atomic') return { data: { ok: true, deducted: args.p_credit_cost, new_balance: 4000, from_free: args.p_credit_cost }, error: null };
      if (name === 'release_generation_task') return { data: true, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
    storage: { from() { return { async createSignedUrl() { return { data: { signedUrl: 'https://storage.example.test/source.mp4' }, error: null }; } }; } }
  };
  const filename = path.resolve(__dirname, '../api/_lib/seedance-start.js');
  const localRequire = createRequire(filename);
  const realDance = localRequire('./reference-dance.js');
  // The authorization helper reads ADMIN_EMAIL from its own module's process.
  // Retain the real role/email boundary by supplying its explicitly configured email.
  const adminEmail = String(process.env.ADMIN_EMAIL || 'hinaran53@gmail.com').trim().toLowerCase();
  const baseFrom = db.from;
  db.from = (table) => {
    if (table !== 'profiles') return baseFrom(table);
    const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() { return { data: { id: USER, email: adminEmail, role }, error: null }; } };
    return chain;
  };
  const stubs = {
    '@supabase/supabase-js': { createClient() { throw new Error('Unexpected live client'); } },
    './confirmed-auth.js': { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER, email: adminEmail }, supabase: db }) },
    './openai-moderation.js': { moderateContent: async () => ({ ok: true }) },
    './moderation-decision.js': { resolveModerationDecision: async () => ({ ok: true, allow: true }) },
    './generation-control.js': { checkGenerationControl: async () => ({ ok: true }) },
    './video-plan-entitlements.js': { getSeedance25Entitlement: async () => ({ ok: true, allowed: true, plan: 'premium' }) },
    './reference-audio.js': { normalizeReferenceAudioPaths: () => ({ ok: true, paths: [] }), createReferenceAudioSignedUrls: async () => ({ ok: true, urls: [] }) },
    './reference-dance.js': realDance
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: (name) => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name),
    process: { env: { ...process.env, WAVESPEED_API_KEY: 'mock-only', OPENROUTER_API_KEY: 'mock-only' } },
    console: { log() {}, warn() {}, error() {} }, URL,
    fetch: async (url, options) => {
      providerCalls.push({ url, payload: JSON.parse(options.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'prediction-1', status: 'created' } }) };
    }
  }, { filename });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };
  await module.exports({ method: 'POST', body: {
    prompt: 'Dance naturally', model: 'bytedance/seedance-2.5', mode: 'reference_to_video',
    resolution: '720p', duration: 5, aspect_ratio: '9:16', reference_url: 'https://example.test/identity.png',
    ...(dance ? { reference_video_asset_id: ASSET } : {})
  } }, res);
  return { res, rpcCalls, updates, providerCalls };
}

test('dance task persists inspected 15-second landscape source, not 5-second portrait UI controls', async () => {
  const result = await runStart();
  assert.equal(result.res.code, 202, JSON.stringify(result.res.body));
  const reserve = result.rpcCalls.find(call => call.name === 'reserve_generation_task').args;
  assert.equal(reserve.p_duration_secs, 15);
  assert.equal(reserve.p_aspect_ratio, '16:9');
  assert.equal(reserve.p_credit_cost, 605);
  const settings = result.updates.find(update => update.value.settings).value.settings.reference_dance;
  assert.equal(settings.duration_ms, 15000);
  assert.equal(settings.width, 1920);
  assert.equal(settings.height, 1080);
  assert.equal(settings.billable_seconds, 15);
  assert.equal(result.rpcCalls.filter(call => call.name === 'deduct_generation_credits_atomic').length, 1);
  assert.equal(result.providerCalls.length, 1);
  assert.match(result.providerCalls[0].url, /seedance-2\.5\/motion-control$/);
  assert.equal('duration' in result.providerCalls[0].payload, false);
  assert.equal('aspect_ratio' in result.providerCalls[0].payload, false);
});

test('normal generation keeps selected duration, aspect ratio, price and endpoint', async () => {
  const result = await runStart({ dance: false });
  assert.equal(result.res.code, 202, JSON.stringify(result.res.body));
  const reserve = result.rpcCalls.find(call => call.name === 'reserve_generation_task').args;
  assert.equal(reserve.p_duration_secs, 5);
  assert.equal(reserve.p_aspect_ratio, '9:16');
  assert.equal(reserve.p_credit_cost, 95);
  assert.match(result.providerCalls[0].url, /text-to-video-turbo$/);
  assert.equal(result.providerCalls[0].payload.duration, 5);
  assert.equal(result.providerCalls[0].payload.aspect_ratio, '9:16');
});

for (const dimensions of [{ width: 0 }, { height: 4097 }, { width: undefined }, { height: 100.5 }]) {
  test(`invalid source dimensions fail before reservation/charge/provider: ${JSON.stringify(dimensions)}`, async () => {
    const result = await runStart({ row: readyRow(dimensions) });
    assert.equal(result.res.code, 400);
    assert.equal(result.rpcCalls.length, 0);
    assert.equal(result.providerCalls.length, 0);
  });
}

test('non-admin cannot submit dance and incurs no charge', async () => {
  const result = await runStart({ role: 'user' });
  assert.equal(result.res.code, 403);
  assert.equal(result.rpcCalls.length, 0);
  assert.equal(result.providerCalls.length, 0);
});

test('failed metadata persistence never charges or submits a provider job', async () => {
  const result = await runStart({ settingsFail: true });
  assert.equal(result.res.code, 500);
  assert.equal(result.res.body.error, 'reference_video_settings_save_failed');
  assert.equal(result.rpcCalls.some(call => call.name === 'deduct_generation_credits_atomic'), false);
  assert.equal(result.providerCalls.length, 0);
});

test('validated metadata preserves precise duration and reduced nonstandard source ratio', () => {
  const metadata = validateReadyReferenceDance(readyRow({ duration_ms: 14001, width: 1000, height: 720 }), USER);
  assert.equal(metadata.durationMs, 14001);
  assert.equal(metadata.billableSeconds, 15);
  assert.equal(metadata.aspectRatio, '25:18');
});


test('asset expiring between validation and retention cannot be resurrected or charged', async () => {
  const result = await runStart({ expireBeforeRetention: true });
  assert.equal(result.res.code, 503);
  assert.equal(result.res.body.error, 'reference_video_retention_failed');
  assert.equal(result.rpcCalls.length, 0);
  assert.equal(result.providerCalls.length, 0);
});
