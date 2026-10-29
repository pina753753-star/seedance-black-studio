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
    duration_ms: 9500, billable_seconds: 10, width: 1920, height: 1080,
    video_codec: 'h264', sha256: 'a'.repeat(64),
    rights_confirmed_at: new Date().toISOString(), created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600000).toISOString(), ...overrides
  };
}

// Load the real handler in an isolated module with all network/DB boundaries
// mocked. No generation, storage write, or credit transaction leaves this test.
async function runStart({ omit = [], rate = 19, providerFailure = false, resolution = '720p', dance = true, row = readyRow(), role = 'admin', settingsFail = false, expireBeforeRetention = false, subscription = true, bodyOverrides = {} } = {}) {
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
  realDance.klingDance.config.creditsPerSecond = rate;
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
  const requestBody = {
    prompt: 'Dance naturally', model: 'bytedance/seedance-2.5', mode: 'reference_to_video',
    resolution, duration: 5, aspect_ratio: '9:16', input_references: ['https://example.test/identity.png'],
    ...(dance ? { reference_video_asset_id: ASSET, dance_method: 'kling_v3_motion_control', estimated_credits: 19 * (row.billable_seconds || 0) } : {}), ...bodyOverrides
  };
  for (const key of omit) delete requestBody[key];
  await module.exports({ method: 'POST', body: requestBody }, res);
  return { res, rpcCalls, updates, providerCalls, events, accessCalls };
}


const KLING = /kwaivgi\/kling-v3\.0-pro\/motion-control$/;

test('price undecided: refuses before reservation, charge or provider call', async () => {
  const r = await runStart({ rate: null });
  assert.equal(r.res.code, 503);
  assert.equal(r.res.body.error, 'kling_dance_price_undecided');
  assert.equal(r.rpcCalls.length, 0);
  assert.equal(r.providerCalls.length, 0);
});

test('mocked price: payload has server-owned orientation/sound, one image, signed video, no resolution/duration', async () => {
  const r = await runStart({ rate: 19 });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  assert.equal(r.providerCalls.length, 1);
  assert.match(r.providerCalls[0].url, KLING);
  assert.deepEqual(r.providerCalls[0].payload, {
    image: 'https://example.test/identity.png',
    video: 'https://storage.example.test/source.mp4',
    prompt: 'Dance naturally',
    character_orientation: 'image',
    keep_original_sound: false
  });
  const reserve = r.rpcCalls.find(c => c.name === 'reserve_generation_task').args;
  assert.equal(reserve.p_credit_cost, 190);
  assert.equal(reserve.p_duration_secs, 10);
  const deduct = r.rpcCalls.filter(c => c.name === 'deduct_generation_credits_atomic');
  assert.equal(deduct.length, 1);
  assert.equal(r.res.body.creditCost, 190);
  const settings = r.updates.find(u => u.value.settings?.reference_dance).value.settings;
  assert.equal(settings.dance_method, 'kling_v3_motion_control');
});

test('browser cannot inject orientation/sound or extra provider fields', async () => {
  const r = await runStart({ rate: 19, bodyOverrides: { character_orientation: 'video', keep_original_sound: true, resolution_override: '1080p' } });
  assert.equal(r.res.code, 202);
  assert.equal(r.providerCalls[0].payload.character_orientation, 'image');
  assert.equal(r.providerCalls[0].payload.keep_original_sound, false);
  assert.equal(Object.keys(r.providerCalls[0].payload).length, 5);
});

for (const [label, row] of [
  ['over 10 s (11 s)', readyRow({ duration_ms: 10001, billable_seconds: 11 })],
  ['15 s long video', readyRow({ duration_ms: 15000, billable_seconds: 15 })]
]) {
  test(`unsupported length is refused with no trim or method switch: ${label}`, async () => {
    const r = await runStart({ rate: 19, row });
    assert.equal(r.res.code, 400);
    assert.equal(r.res.body.error, 'kling_dance_duration_unsupported');
    assert.equal(r.rpcCalls.length, 0);
    assert.equal(r.providerCalls.length, 0);
  });
}

test('boundary: exactly 10 s and 4 s (inspector minimum) are accepted and priced per second', async () => {
  const ten = await runStart({ rate: 7, row: readyRow({ duration_ms: 10000, billable_seconds: 10 }), bodyOverrides: { estimated_credits: 70 } });
  assert.equal(ten.res.code, 202, JSON.stringify(ten.res.body));
  assert.equal(ten.res.body.creditCost, 70);
  const four = await runStart({ rate: 7, row: readyRow({ duration_ms: 4000, billable_seconds: 4 }), bodyOverrides: { estimated_credits: 28 } });
  assert.equal(four.res.code, 202);
  assert.equal(four.res.body.creditCost, 28);
});

test('estimated_credits: missing, malformed -> 400 invalid_estimated_credits; lower than server -> 409; equal/higher accepted', async () => {
  for (const bad of [undefined, 0, -1, 1.5, '100', null]) {
    const o = bad === undefined ? { estimated_credits: undefined } : { estimated_credits: bad };
    const body = { ...o };
    const r = await runStart({ rate: 19, bodyOverrides: body });
    assert.equal(r.res.code, 400, String(bad));
    assert.equal(r.res.body.error, 'invalid_estimated_credits');
    assert.equal(r.rpcCalls.length, 0);
    assert.equal(r.providerCalls.length, 0);
  }
  const low = await runStart({ rate: 19, bodyOverrides: { estimated_credits: 189 } });
  assert.equal(low.res.code, 409);
  assert.equal(low.res.body.error, 'credit_cost_changed');
  assert.equal(low.res.body.credits, 190);
  assert.equal(low.rpcCalls.length, 0);
  assert.equal(low.providerCalls.length, 0);
  const equal = await runStart({ rate: 19, bodyOverrides: { estimated_credits: 190 } });
  assert.equal(equal.res.code, 202);
  const higher = await runStart({ rate: 19, bodyOverrides: { estimated_credits: 250 } });
  assert.equal(higher.res.code, 202);
  assert.equal(higher.res.body.creditCost, 190);
});

test('estimated_credits absent (legacy shape) is refused for kling only', async () => {
  const r = await runStart({ rate: 19, omit: ['estimated_credits'] });
  assert.equal(r.res.code, 400);
  assert.equal(r.res.body.error, 'invalid_estimated_credits');
  assert.equal(r.rpcCalls.length, 0);
  assert.equal(r.providerCalls.length, 0);
});

test('unknown dance_method and missing video are refused', async () => {
  const unknown = await runStart({ rate: 19, bodyOverrides: { dance_method: 'kling_v3_motion_control ' + 'x' } });
  assert.equal(unknown.res.code, 400);
  assert.equal(unknown.res.body.error, 'invalid_dance_method');
  assert.equal(unknown.providerCalls.length, 0);
  const noVideo = await runStart({ rate: 19, dance: false, bodyOverrides: { dance_method: 'kling_v3_motion_control', estimated_credits: 190 } });
  assert.equal(noVideo.res.code, 400);
  assert.equal(noVideo.res.body.error, 'reference_video_required');
  assert.equal(noVideo.rpcCalls.length, 0);
});

test('admin-BETA, rights-checked asset, identity image and single image are all still required', async () => {
  const nonAdmin = await runStart({ rate: 19, role: 'user' });
  assert.equal(nonAdmin.res.code, 403);
  assert.equal(nonAdmin.rpcCalls.length, 0);
  const noImage = await runStart({ rate: 19, bodyOverrides: { input_references: [] } });
  assert.equal(noImage.res.code, 400);
  assert.equal(noImage.res.body.error, 'identity_reference_image_required');
  const twoImages = await runStart({ rate: 19, bodyOverrides: { input_references: ['https://example.test/a.png', 'https://example.test/b.png'] } });
  assert.equal(twoImages.res.code, 400);
  assert.equal(twoImages.res.body.error, 'kling_dance_single_image_required');
  assert.equal(twoImages.rpcCalls.length, 0);
  const notReady = await runStart({ rate: 19, row: readyRow({ status: 'pending' }) });
  assert.equal(notReady.res.code, 400);
  assert.equal(notReady.rpcCalls.length, 0);
  const noRights = await runStart({ rate: 19, row: readyRow({ rights_confirmed_at: null }) });
  assert.equal(noRights.res.code, 400);
  assert.equal(noRights.providerCalls.length, 0);
});

test('provider rejection refunds the task once and returns refunded', async () => {
  const r = await runStart({ rate: 19, providerFailure: true });
  assert.ok(r.res.code >= 400, String(r.res.code));
  assert.equal(r.rpcCalls.filter(c => c.name === 'deduct_generation_credits_atomic').length, 1);
  assert.equal(r.rpcCalls.filter(c => c.name === 'refund_generation_task_atomic').length, 1);
  assert.equal(r.res.body.refunded, true);
});

test('settings save failure never charges or calls the provider', async () => {
  const r = await runStart({ rate: 19, settingsFail: 'dance' });
  assert.equal(r.res.code, 500);
  assert.equal(r.rpcCalls.some(c => c.name === 'deduct_generation_credits_atomic'), false);
  assert.equal(r.providerCalls.length, 0);
});

test('regression: existing Seedance dance (no dance_method) keeps its endpoint, price and exemption', async () => {
  const r = await runStart({ rate: 19, row: readyRow({ duration_ms: 15000, billable_seconds: 15 }), bodyOverrides: { dance_method: undefined, estimated_credits: 95, reference_url: 'https://example.test/identity.png', input_references: undefined } });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  assert.match(r.providerCalls[0].url, /seedance-2\.5\/motion-control$/);
  assert.equal(r.rpcCalls.find(c => c.name === 'reserve_generation_task').args.p_credit_cost, 605);
  assert.equal('character_orientation' in r.providerCalls[0].payload, false);
});

test('regression: normal generation is untouched and kling module never loads a price', async () => {
  const r = await runStart({ dance: false });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  assert.match(r.providerCalls[0].url, /text-to-video-turbo$|image-to-video|reference/);
  assert.equal(r.rpcCalls.find(c => c.name === 'reserve_generation_task').args.p_credit_cost, 95);
});

test('kling-dance module: owner price 19 cr/s, 4-10 s range, strict helpers', () => {
  const k = require('../api/_lib/reference-dance.js').klingDance;
  assert.equal(k.config.creditsPerSecond, 19);
  assert.equal(k.getKlingDanceCreditsPerSecond(), 19);
  assert.equal(k.klingDanceCredits(5), 95);
  assert.equal(k.klingDanceCredits(10), 190);
  assert.equal(k.klingDanceCredits(4), 76);
  assert.throws(() => k.klingDanceCredits(5, null), /kling_dance_price_undecided/);
  assert.throws(() => k.validateKlingDanceSeconds(3), /kling_dance_duration_unsupported/);
  assert.throws(() => k.validateKlingDanceSeconds(11), /kling_dance_duration_unsupported/);
  assert.equal(k.validateKlingDanceSeconds(4), 4);
  assert.equal(k.KLING_DANCE_MIN_SECONDS, 4);
  assert.equal(k.KLING_DANCE_MAX_SECONDS, 10);
  assert.equal(k.parseKlingDanceMethod({}), '');
  assert.equal(k.KLING_DANCE_PROVIDER_MODEL, 'kwaivgi/kling-v3.0-pro/motion-control');
});

// Measured length decides acceptance; billed seconds = ceil(durationMs / 1000) (the inspector's rule).
const BOUNDARIES = [
  [4000, 4, 'accept', 76], [4001, 5, 'accept', 95], [4999, 5, 'accept', 95], [5000, 5, 'accept', 95],
  [9500, 10, 'accept', 190], [9999, 10, 'accept', 190], [10000, 10, 'accept', 190],
  [10001, 11, 'reject'], [10999, 11, 'reject'], [15000, 15, 'reject']
];
for (const [ms, billed, outcome, credits] of BOUNDARIES) {
  test(`boundary ${ms} ms (billed ${billed} s): ${outcome}${credits ? ` ${credits} cr` : ''}`, async () => {
    const r = await runStart({ row: readyRow({ duration_ms: ms, billable_seconds: billed }), bodyOverrides: { estimated_credits: credits || 1 } });
    if (outcome === 'reject') {
      assert.equal(r.res.code, 400);
      assert.equal(r.res.body.error, 'kling_dance_duration_unsupported');
      assert.equal(r.rpcCalls.length, 0);
      assert.equal(r.providerCalls.length, 0);
      return;
    }
    assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
    assert.equal(r.res.body.creditCost, credits);
    assert.equal(r.rpcCalls.find(c => c.name === 'reserve_generation_task').args.p_credit_cost, credits);
    assert.equal(r.rpcCalls.find(c => c.name === 'deduct_generation_credits_atomic').args.p_credit_cost ?? r.rpcCalls.find(c => c.name === 'deduct_generation_credits_atomic').args.p_cost, credits);
  });
}

test('under 4 s (3.9 s and 3 s) fails the existing inspection before any reservation/charge/provider call', async () => {
  for (const ms of [3999, 3000]) {
    const r = await runStart({ row: readyRow({ duration_ms: ms, billable_seconds: 4 }) });
    assert.equal(r.res.code, 400, String(ms));
    assert.equal(r.rpcCalls.length, 0);
    assert.equal(r.providerCalls.length, 0);
  }
});

test('client-supplied price/seconds are never a billing basis (5 s => 95, 10 s => 190 regardless of body)', async () => {
  const fake = { credits_per_second: 1, creditsPerSecond: 1, duration: 4, duration_seconds: 4, billable_seconds: 3, credit_cost: 1, cost: 1 };
  const five = await runStart({ row: readyRow({ duration_ms: 5000, billable_seconds: 5 }), bodyOverrides: { ...fake, estimated_credits: 95 } });
  assert.equal(five.res.code, 202, JSON.stringify(five.res.body));
  assert.equal(five.res.body.creditCost, 95);
  assert.equal(five.rpcCalls.find(c => c.name === 'reserve_generation_task').args.p_duration_secs, 5);
  const ten = await runStart({ row: readyRow({ duration_ms: 10000, billable_seconds: 10 }), bodyOverrides: { ...fake, estimated_credits: 190 } });
  assert.equal(ten.res.code, 202);
  assert.equal(ten.res.body.creditCost, 190);
  // a tampered low confirmation is refused with 409 and nothing is charged
  const low = await runStart({ row: readyRow({ duration_ms: 10000, billable_seconds: 10 }), bodyOverrides: { ...fake, estimated_credits: 1 } });
  assert.equal(low.res.code, 409);
  assert.equal(low.rpcCalls.length, 0);
});

test('reservation, deduction and response amounts are identical (19 x billed seconds)', async () => {
  const r = await runStart({ row: readyRow({ duration_ms: 7300, billable_seconds: 8 }), bodyOverrides: { estimated_credits: 152 } });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  const amounts = [
    r.res.body.creditCost,
    r.rpcCalls.find(c => c.name === 'reserve_generation_task').args.p_credit_cost,
    Object.entries(r.rpcCalls.find(c => c.name === 'deduct_generation_credits_atomic').args).find(([k]) => /cost|amount/.test(k))[1]
  ];
  assert.deepEqual(amounts, [152, 152, 152]);
});
