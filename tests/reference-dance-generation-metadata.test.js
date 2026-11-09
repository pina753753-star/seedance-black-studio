'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { validateReadyReferenceDance } = require('../api/_lib/reference-dance.js');
const { hasSeedance25PlanAccess } = require('../api/_lib/video-plan-entitlements.js');

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
async function runStart({ providerFailure = false, resolution = '720p', dance = true, row = readyRow(), role = 'admin', settingsFail = false, expireBeforeRetention = false, subscription = true, bodyOverrides = {} } = {}) {
  const rpcCalls = [], updates = [], providerCalls = [], events = [], accessCalls = [];
  const access = {
    ok: true, allowed: true, plan: subscription ? 'premium' : 'free', accountStatus: 'active',
    hasActiveSubscription: subscription, hasPurchasedAccess: !subscription,
    subscriptionExpiresAt: subscription ? '2999-01-01T00:00:00Z' : null,
    watermarkRequired: !subscription, balance: 5000
  };
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
          if (table === 'generation_tasks' && update.settings) {
            const stage = update.settings.reference_dance ? 'dance' : 'policy';
            if (settingsFail === true || settingsFail === stage) return { data: [], error: { message: 'settings unavailable' } };
          }
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
        update(value) { update = value; updates.push({ table, value }); events.push({ type: 'update', table, value }); return chain; },
        maybeSingle() { return Promise.resolve(result()); },
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
      };
      return chain;
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args }); events.push({ type: 'rpc', name });
      if (name === 'reserve_generation_task') return { data: { task_id: 'task-1' }, error: null };
      if (name === 'deduct_generation_credits_atomic') return { data: { ok: true, deducted: args.p_credit_cost, new_balance: 4000, from_free: args.p_credit_cost }, error: null };
      if (name === 'refund_generation_task_atomic') return { data: { ok: true, code: 'refunded' }, error: null };
      if (name === 'release_generation_task') return { data: true, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    },
    storage: { from() { return { async createSignedUrl() { return { data: { signedUrl: 'https://storage.example.test/source.mp4' }, error: null }; } }; } }
  };
  const filename = path.resolve(__dirname, '../api/_lib/seedance-start.js');
  const localRequire = createRequire(filename);
  // Execute the actual admin helper with a deterministic inert address, never
  // the host's environment/configuration. Preserve its real role/email checks.
  const adminEmail = 'admin@example.test';
  const danceModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../api/_lib/reference-dance.js'), 'utf8'), {
    module: danceModule, process: { env: { ADMIN_EMAIL: adminEmail } }
  });
  const realDance = danceModule.exports;
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
    './credit-access': { readSubscriptionAccess: async () => ({ ...access }) },
    './video-plan-entitlements.js': {
      hasSeedance25PlanAccess,
      getSeedance25Entitlement: async () => { accessCalls.push('purchase'); return { ...access }; },
      getSeedance25SubscriptionEntitlement: async () => { accessCalls.push('subscription'); return { ...access, allowed: subscription }; }
    },
    './reference-audio.js': { normalizeReferenceAudioPaths: () => ({ ok: true, paths: [] }), createReferenceAudioSignedUrls: async () => ({ ok: true, urls: [] }) },
    './reference-dance.js': realDance
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: (name) => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name),
    process: { env: { WAVESPEED_API_KEY: 'mock-only', OPENROUTER_API_KEY: 'mock-only' } },
    console: { log() {}, warn() {}, error() {} }, URL,
    fetch: async (url, options) => {
      providerCalls.push({ url, payload: JSON.parse(options.body) }); events.push({ type: 'provider' });
      return providerFailure ? { ok: false, status: 422, text: async () => 'synthetic rejected input' } : { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'prediction-1', status: 'created' } }) };
    }
  }, { filename });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };
  await module.exports({ method: 'POST', body: {
    prompt: 'Dance naturally', model: 'bytedance/seedance-2.5', mode: 'reference_to_video',
    resolution, duration: 5, aspect_ratio: '9:16', reference_url: 'https://example.test/identity.png',
    ...(dance ? { reference_video_asset_id: ASSET } : {}), ...bodyOverrides
  } }, res);
  return { res, rpcCalls, updates, providerCalls, events, accessCalls };
}

test('dance task persists inspected 15-second landscape source, not 5-second portrait UI controls', async () => {
  const result = await runStart();
  assert.equal(result.res.code, 202, JSON.stringify(result.res.body));
  const reserve = result.rpcCalls.find(call => call.name === 'reserve_generation_task').args;
  assert.equal(reserve.p_duration_secs, 15);
  assert.equal(reserve.p_aspect_ratio, '16:9');
  assert.equal(reserve.p_credit_cost, 605);
  const settings = result.updates.find(update => update.value.settings?.reference_dance).value.settings.reference_dance;
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

for (const [stage, errorCode] of [['policy', 'generation_policy_save_failed'], ['dance', 'reference_video_settings_save_failed']]) {
  test(`failed ${stage} settings persistence never charges or submits a provider job`, async () => {
    const result = await runStart({ settingsFail: stage });
    assert.equal(result.res.code, 500);
    assert.equal(result.res.body.error, errorCode);
    assert.equal(result.rpcCalls.some(call => call.name === 'deduct_generation_credits_atomic'), false);
    assert.equal(result.updates.filter(update => update.table === 'generation_tasks' && update.value.status === 'cancelled').length, 1);
    assert.equal(result.providerCalls.length, 0);
    const saves = result.updates.filter(update => update.table === 'generation_tasks' && update.value.settings);
    assert.equal(saves.length, stage === 'policy' ? 1 : 2);
  });
}

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

for (const [durationMs, seconds, credits] of [[4000,4,85],[4001,5,105],[15000,15,305]]) {
  test(`480p real handler charges sealed ${durationMs}ms at ${credits} credits`, async () => {
    const result = await runStart({ resolution: '480p', row: readyRow({ duration_ms: durationMs, billable_seconds: seconds }) });
    assert.equal(result.res.code, 202, JSON.stringify(result.res.body));
    assert.equal(result.rpcCalls.find(c => c.name === 'reserve_generation_task').args.p_credit_cost, credits);
    assert.equal(result.rpcCalls.find(c => c.name === 'deduct_generation_credits_atomic').args.p_credit_cost, credits);
    assert.equal(result.providerCalls.length, 1);
    assert.match(result.providerCalls[0].url, /motion-control$/);
    assert.equal(result.providerCalls[0].payload.resolution, '480p');
  });
}
test('480p cannot admit ordinary Turbo generation or nonadmin dance', async () => {
  for (const options of [{ dance: false }, { role: 'user' }]) {
    const result = await runStart({ resolution: '480p', ...options });
    assert.ok(result.res.code >= 400);
    assert.equal(result.rpcCalls.length, 0);
    assert.equal(result.providerCalls.length, 0);
  }
});

test('480p rejected provider request refunds the same 85-credit reserved task once', async () => {
  const result = await runStart({ resolution:'480p', providerFailure:true, row:readyRow({duration_ms:4000,billable_seconds:4}) });
  assert.equal(result.res.code,502);
  assert.equal(result.res.body.creditRefunded,85);
  assert.equal(result.rpcCalls.find(c=>c.name==='deduct_generation_credits_atomic').args.p_credit_cost,85);
  const refunds=result.rpcCalls.filter(c=>c.name==='refund_generation_task_atomic');
  assert.equal(refunds.length,1);assert.equal(refunds[0].args.p_task_id,'task-1');
  assert.equal(result.providerCalls.length,1);
});


test('purchase-only admin cannot use reference dance and never reaches reservation or provider', async () => {
  const result = await runStart({ subscription: false, role: 'admin' });
  assert.equal(result.res.code, 403);
  assert.equal(result.res.body.error, 'seedance_25_plan_required');
  assert.deepEqual(result.accessCalls, ['subscription']);
  assert.equal(result.updates.length, 0);
  assert.equal(result.rpcCalls.length, 0);
  assert.equal(result.providerCalls.length, 0);
});

test('Premium admin keeps both server policy markers through the second dance metadata write', async () => {
  const result = await runStart({ bodyOverrides: {
    watermark_required: true, purchase_access_required: true,
    settings: { watermark_required: true, purchase_access_required: true, reference_dance: { asset_id: 'forged', billable_seconds: 1 } },
    referenceDanceBillableSeconds: 1
  } });
  assert.equal(result.res.code, 202, JSON.stringify(result.res.body));
  assert.deepEqual(result.accessCalls, ['subscription']);
  const saves = result.events.filter(event => event.type === 'update' && event.table === 'generation_tasks' && event.value.settings);
  assert.equal(saves.length, 2);
  for (const save of saves) {
    assert.equal(save.value.settings.watermark_required, false);
    assert.equal(save.value.settings.purchase_access_required, false);
  }
  const finalSettings = saves[1].value.settings;
  assert.equal(finalSettings.reference_dance.asset_id, ASSET);
  assert.equal(finalSettings.reference_dance.billable_seconds, 15);
  assert.equal(finalSettings.reference_dance.duration_ms, 15000);
  const debitIndex = result.events.findIndex(event => event.type === 'rpc' && event.name === 'deduct_generation_credits_atomic');
  for (const save of saves) assert.ok(result.events.indexOf(save) < debitIndex);
  assert.equal(result.rpcCalls.find(call => call.name === 'deduct_generation_credits_atomic').args.p_credit_cost, 605);
});

test('normal purchase-only generation remains allowed with server-owned purchase and watermark markers', async () => {
  const result = await runStart({ dance: false, subscription: false, bodyOverrides: {
    watermark_required: false, purchase_access_required: false,
    settings: { watermark_required: false, purchase_access_required: false, reference_dance: { asset_id: ASSET } }
  } });
  assert.equal(result.res.code, 202, JSON.stringify(result.res.body));
  assert.deepEqual(result.accessCalls, ['purchase']);
  const saves = result.updates.filter(update => update.table === 'generation_tasks' && update.value.settings);
  assert.equal(saves.length, 1);
  assert.equal(saves[0].value.settings.watermark_required, true);
  assert.equal(saves[0].value.settings.purchase_access_required, true);
  assert.equal(Object.hasOwn(saves[0].value.settings, 'reference_dance'), false);
  assert.equal(result.rpcCalls.find(call => call.name === 'deduct_generation_credits_atomic').args.p_credit_cost, 95);
  assert.equal(result.providerCalls.length, 1);
  assert.match(result.providerCalls[0].url, /text-to-video-turbo$/);
});

test('verified admin dance path is exempt from the estimate comparison (known display gap 95 vs server price) but not from format validation', async () => {
  const lowButValid = await runStart({ bodyOverrides: { estimated_credits: 95 } });
  assert.equal(lowButValid.res.code, 202, JSON.stringify(lowButValid.res.body));
  assert.equal(lowButValid.rpcCalls.find(call => call.name === 'deduct_generation_credits_atomic').args.p_credit_cost, 605);
  const invalid = await runStart({ bodyOverrides: { estimated_credits: null } });
  assert.equal(invalid.res.code, 400);
  assert.equal(invalid.rpcCalls.length, 0);
  assert.equal(invalid.providerCalls.length, 0);
});
