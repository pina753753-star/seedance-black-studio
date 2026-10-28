'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { hasSeedance25PlanAccess } = require('../api/_lib/video-plan-entitlements.js');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing.js');
const realAudio = require('../api/_lib/reference-audio.js');

const USER = '5a951e62-7bc3-46c0-a89b-33fa5eea7bb3';

// Real handler, all network/DB boundaries mocked. No generation or credit
// transaction leaves this test.
async function runStart(bodyOverrides = {}, { balance = 5000, hooks = {} } = {}) {
  const rpcCalls = [], providerCalls = [], events = [], calls = { moderation: [], normalize: [], sign: [], inserts: [], updates: [] };
  const chainFor = table => {
    let isUpdate = false;
    const chain = {
      select() { return chain; }, eq() { return chain; }, in() { return chain; }, is() { return chain; }, gt() { return chain; },
      insert(value) { calls.inserts.push({ table, value }); return Promise.resolve({ error: null }); },
      update(value) { isUpdate = true; calls.updates.push({ table, value }); events.push('update:' + table); return chain; },
      maybeSingle() { return Promise.resolve(result()); },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
    };
    const result = () => {
      if (isUpdate) return { data: [{ id: 'task-1' }], error: null };
      if (table === 'credit_balances') return { data: { free_credits: balance }, error: null };
      if (table === 'profiles') return { data: { id: USER, email: 'user@example.test', role: 'user' }, error: null };
      throw new Error(`Unexpected read: ${table}`);
    };
    return chain;
  };
  const db = {
    from: chainFor,
    async rpc(name, args) {
      rpcCalls.push({ name, args }); events.push(name);
      if (name === 'reserve_generation_task') return { data: { task_id: 'task-1' }, error: null };
      if (name === 'deduct_generation_credits_atomic') return { data: { ok: true, deducted: args.p_credit_cost, new_balance: 1, from_free: args.p_credit_cost }, error: null };
      if (name === 'refund_generation_task_atomic') return { data: { ok: true, code: 'refunded' }, error: null };
      if (name === 'release_generation_task') return { data: true, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    }
  };
  const access = { ok: true, allowed: true, plan: 'premium', accountStatus: 'active', hasActiveSubscription: true, hasPurchasedAccess: false, subscriptionExpiresAt: '2999-01-01T00:00:00Z', watermarkRequired: false, balance, ...(hooks.access || {}) };
  const filename = path.resolve(__dirname, '../api/_lib/seedance-start.js');
  const localRequire = createRequire(filename);
  const stubs = {
    '@supabase/supabase-js': { createClient() { throw new Error('Unexpected live client'); } },
    './confirmed-auth.js': { requireConfirmedAuth: async () => ({ ok: true, user: { id: USER, email: 'user@example.test' }, supabase: db }) },
    './openai-moderation.js': { moderateContent: async (prompt, images) => { events.push('moderation'); calls.moderation.push({ prompt, images }); return { ok: true, categories: [] }; } },
    './moderation-decision.js': { resolveModerationDecision: async () => hooks.moderationDecision || ({ ok: true, allow: true }) },
    './generation-control.js': { checkGenerationControl: async () => ({ ok: true }) },
    './credit-access': { readSubscriptionAccess: async () => ({ ...access }) },
    './video-plan-entitlements.js': {
      hasSeedance25PlanAccess,
      getSeedance25Entitlement: async () => ({ ...access }),
      getSeedance25SubscriptionEntitlement: async () => ({ ...access })
    },
    './reference-audio.js': {
      REFERENCE_AUDIO_RETENTION_MS: realAudio.REFERENCE_AUDIO_RETENTION_MS,
      REFERENCE_AUDIO_REGISTRY_TABLE: realAudio.REFERENCE_AUDIO_REGISTRY_TABLE,
      normalizeReferenceAudioPaths: (paths, userId) => { calls.normalize.push({ paths, userId }); return hooks.normalize ? hooks.normalize(paths, userId) : { ok: true, paths: [] }; },
      createReferenceAudioSignedUrls: async (_db, paths) => { calls.sign.push({ paths }); return hooks.sign ? hooks.sign(paths) : { ok: true, urls: [] }; }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports,
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name),
    process: { env: { WAVESPEED_API_KEY: 'mock-only', OPENROUTER_API_KEY: 'mock-only' } },
    console: { log() {}, warn() {}, error() {} }, URL,
    fetch: async (url, options) => {
      providerCalls.push({ url, payload: JSON.parse(options.body) }); events.push('provider');
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'prediction-1', status: 'created' } }) };
    }
  }, { filename });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };
  await module.exports({ method: 'POST', body: {
    prompt: 'A calm lake', model: 'bytedance/seedance-2.5', mode: 'text_to_video',
    resolution: '720p', duration: 5, aspect_ratio: '16:9', ...bodyOverrides
  } }, res);
  return { res, rpcCalls, providerCalls, events, calls };
}

const price = (o = {}) => calculateVideoCreditCost({ mode: 'text_to_video', duration: 5, resolution: '720p', model: 'bytedance/seedance-2.5', plan: 'premium', aspectRatio: '16:9', ...o });
const deductions = r => r.rpcCalls.filter(c => c.name === 'deduct_generation_credits_atomic');
const noSideEffects = r => {
  assert.equal(r.rpcCalls.length, 0);
  assert.equal(r.providerCalls.length, 0);
  assert.equal(r.events.includes('moderation'), false);
};

// ---- Already guaranteed before this change (pass on the baseline too) ----

test('current price: reserved and deducted amount equals the server price, once', async () => {
  const r = await runStart({ estimated_credits: price() });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  const reserve = r.rpcCalls.find(c => c.name === 'reserve_generation_task').args;
  assert.equal(reserve.p_credit_cost, price());
  assert.equal(deductions(r).length, 1);
  assert.equal(deductions(r)[0].args.p_credit_cost, price());
  assert.equal(r.providerCalls.length, 1);
});

test('tampered lower estimate cannot lower the charge', async () => {
  const r = await runStart({ estimated_credits: 1, duration: 10 });
  assert.equal(deductions(r).length === 0 || deductions(r)[0].args.p_credit_cost === price({ duration: 10 }), true);
  assert.equal(r.rpcCalls.some(c => c.name === 'reserve_generation_task' && c.args.p_credit_cost !== price({ duration: 10 })), false);
});

test('insufficient balance is rejected before reservation or provider call', async () => {
  const r = await runStart({}, { balance: 10 });
  assert.equal(r.res.code, 402);
  assert.equal(r.rpcCalls.length, 0);
  assert.equal(r.providerCalls.length, 0);
});

// ---- Added guard: the confirmed amount is never silently raised ----

test('server price above the confirmed estimate is refused with credit_cost_changed and no side effects', async () => {
  const r = await runStart({ estimated_credits: price() - 1 });
  assert.equal(r.res.code, 409);
  assert.equal(r.res.body.error, 'credit_cost_changed');
  assert.equal(r.res.body.credits, price());
  assert.equal(r.res.body.estimatedCredits, price() - 1);
  noSideEffects(r);
});

test('condition tampering (longer duration with the old estimate) is refused, not charged more', async () => {
  const r = await runStart({ estimated_credits: price(), duration: 10 });
  assert.equal(r.res.code, 409);
  noSideEffects(r);
});

test('estimate above the server price is accepted and only the server price is charged', async () => {
  const r = await runStart({ estimated_credits: price() + 500 });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  assert.equal(deductions(r)[0].args.p_credit_cost, price());
});

test('omitted estimate (legacy client) keeps the previous behaviour', async () => {
  const r = await runStart({});
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  assert.equal(deductions(r)[0].args.p_credit_cost, price());
});

test('present but invalid estimate is refused before moderation, reservation, deduction and provider', async () => {
  for (const estimated_credits of [null, '', 'abc', '95', 0, -5, 1.5, NaN, Infinity, 1e9, 100001, true, [95], { v: 95 }]) {
    const r = await runStart({ estimated_credits });
    assert.equal(r.res.code, 400, JSON.stringify(estimated_credits));
    assert.equal(r.res.body.error, 'invalid_estimated_credits');
    noSideEffects(r);
  }
});

test('the shapes real clients send (positive integer JSON numbers) are accepted', async () => {
  for (const estimated_credits of [price(), price() + 5, 100000]) {
    const r = await runStart({ estimated_credits });
    assert.equal(r.res.code, 202, String(estimated_credits));
    assert.equal(deductions(r)[0].args.p_credit_cost, price());
  }
});

test('adding dance fields to a normal request cannot bypass the guard', async () => {
  const ASSET = '270bf01a-bafd-4255-8ad5-e18a4f1c8c47';
  for (const extra of [
    { reference_video_asset_id: ASSET },
    { reference_video_asset_id: ASSET, model: 'bytedance/seedance-2.5', mode: 'reference_to_video' },
    { reference_video_asset_id: 'not-a-uuid' },
    { reference_video_asset_id: ' ' + ASSET + ' ' },
    { referenceDanceBillableSeconds: 1, reference_dance: { billableSeconds: 1 }, billable_seconds: 1 }
  ]) {
    const r = await runStart({ estimated_credits: 1, ...extra });
    assert.notEqual(r.res.code, 202, JSON.stringify(extra));
    assert.equal(r.rpcCalls.length, 0, JSON.stringify(extra));
    assert.equal(r.providerCalls.length, 0);
  }
  const r = await runStart({ estimated_credits: 1, referenceDanceBillableSeconds: 1, reference_dance: { billableSeconds: 1 } });
  assert.equal(r.res.code, 409);
});

test('duplicate submission with a stale estimate is refused both times without deduction', async () => {
  const first = await runStart({ estimated_credits: price() - 1 });
  const second = await runStart({ estimated_credits: price() - 1 });
  assert.equal(first.res.code, 409);
  assert.equal(second.res.code, 409);
  assert.equal(deductions(first).length + deductions(second).length, 0);
});

test('refusal happens before the balance check (even with ample balance nothing is reserved)', async () => {
  const r = await runStart({ estimated_credits: 1 }, { balance: 100000 });
  assert.equal(r.res.code, 409);
  noSideEffects(r);
});

// ---- Browser entrance flowvid-history.js (fallback start path) after a 409 ----

function loadHistoryStart(fetchResult) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'flowvid-history.js'), 'utf8');
  const from = src.indexOf('function credits(){');
  const to = src.indexOf('function pollStatus(');
  assert.ok(from > 0 && to > from);
  const state = { fetches: [], saved: [], polled: 0, storage: new Map(), alerts: [], quoteArgs: [] };
  const els = { create: { disabled: false, textContent: '' }, now: { classList: { add() {}, remove() {} } }, done: { classList: { add() {}, remove() {} } }, job: { textContent: '' }, prompt: { value: 'lake' }, duration: { value: '5' }, resolution: { value: '720p' }, aspect: { value: '16:9' } };
  const ctx = vm.createContext({
    state, els, AbortController, setTimeout, clearTimeout, JSON,
    window: { flowvidComputeCredits: args => { state.quoteArgs.push(args); return 95; } },
    localStorage: { setItem: (k, v) => state.storage.set(k, v) },
    alert: m => state.alerts.push(m),
    originalFetch: async (url, init) => { state.fetches.push({ url, body: JSON.parse(init.body) }); return fetchResult(); }
  });
  vm.runInContext(`
    const LAST_JOB_KEY='k';
    const $=id=>els[id]||null;
    const currentMode=()=>'text_to_video';const getRefs=()=>[];const selectedModel=()=>'bytedance/seedance-2.0';
    const toInputReferences=()=>[];const extractJobId=d=>d&&d.jobId;const extractPollingUrl=d=>d&&d.pollingUrl;
    const remoteSave=x=>state.saved.push(x);const pollStatus=()=>{state.polled++};
    ${src.slice(from, to)}
    this.robustStart=robustStart;
  `, ctx);
  return { ctx, state, els };
}
const jsonRes = (status, body) => () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

test('history entrance: 409 shows the amounts, starts nothing, releases the button, never auto-resends', async () => {
  const h = loadHistoryStart(jsonRes(409, { ok: false, error: 'credit_cost_changed', credits: 125, estimatedCredits: 95 }));
  await h.ctx.robustStart();
  assert.equal(h.state.fetches.length, 1);
  assert.equal(h.state.fetches[0].body.estimated_credits, 95);
  assert.equal(h.state.fetches[0].body.mode, 'text_to_video', 'the priced mode is sent, not left to the server default');
  assert.equal(h.els.create.disabled, false);
  assert.match(h.els.job.textContent, /95 → 125/);
  assert.match(h.els.job.textContent, /生成は開始していません/);
  assert.equal(h.state.saved.length, 0);
  assert.equal(h.state.polled, 0);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(h.state.fetches.length, 1, 'no automatic resend');
  await h.ctx.robustStart();
  assert.equal(h.state.fetches.length, 2, 'explicit user resend is possible');
});

test('history entrance: success path still starts, saves and polls', async () => {
  const h = loadHistoryStart(jsonRes(200, { ok: true, jobId: 'job-1' }));
  await h.ctx.robustStart();
  assert.equal(h.state.saved.length, 1);
  assert.equal(h.state.polled, 1);
});

// ---- Restored-code regression: audio validation, moderation, entitlement, 720p, order ----

const AUDIO = ['reference-audio/' + USER + '/song.mp3'];
const audioOk = { normalize: () => ({ ok: true, paths: AUDIO }), sign: () => ({ ok: true, urls: ['https://storage.example.test/song.mp3'] }) };
const audioBody = { resolution: '1080p', duration: 5, reference_audio_paths: AUDIO };
const untouched = r => { assert.equal(r.rpcCalls.length, 0); assert.equal(r.providerCalls.length, 0); };

test('normal request actually runs audio normalization, moderation, reserve, deduct and provider in that order', async () => {
  const r = await runStart({ estimated_credits: price() });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  assert.equal(r.calls.normalize.length, 1);
  assert.equal(r.calls.normalize[0].userId, USER);
  assert.equal(r.calls.moderation.length, 1);
  assert.equal(r.calls.moderation[0].prompt, 'A calm lake');
  const order = r.events.filter(e => ['moderation', 'reserve_generation_task', 'deduct_generation_credits_atomic', 'provider'].includes(e));
  assert.deepEqual(order, ['moderation', 'reserve_generation_task', 'deduct_generation_credits_atomic', 'provider']);
});

test('valid reference audio on a 1080p subscriber request is normalized, retained, signed and moderated before reserve/deduct', async () => {
  const r = await runStart({ ...audioBody, estimated_credits: price({ resolution: '1080p' }) }, { hooks: audioOk });
  assert.equal(r.res.code, 202, JSON.stringify(r.res.body));
  assert.deepEqual(r.calls.normalize[0].paths, AUDIO);
  assert.deepEqual(r.calls.sign[0].paths, AUDIO);
  assert.ok(r.calls.updates.some(u => u.table !== 'generation_tasks' && u.value.expires_at), 'audio retention update');
  assert.ok(r.events.indexOf('moderation') < r.events.indexOf('reserve_generation_task'));
  assert.ok(r.events.indexOf('update:' + r.calls.updates.find(u => u.value.expires_at).table) < r.events.indexOf('moderation'));
});

test('invalid reference audio stops before moderation, reservation, deduction and provider', async () => {
  const r = await runStart(audioBody, { hooks: { normalize: () => ({ ok: false, error: 'invalid_reference_audio', message: 'bad' }) } });
  assert.equal(r.res.code, 400);
  assert.equal(r.res.body.error, 'invalid_reference_audio');
  assert.equal(r.calls.moderation.length, 0);
  untouched(r);
});

test('audio signed-url failure stops before moderation, reservation, deduction and provider', async () => {
  const r = await runStart(audioBody, { hooks: { ...audioOk, sign: () => ({ ok: false, error: 'reference_audio_unavailable', message: 'gone' }) } });
  assert.equal(r.res.code, 400);
  assert.equal(r.calls.moderation.length, 0);
  untouched(r);
});

test('reference audio without 1080p is refused (reference_audio_not_supported) before any side effect', async () => {
  const r = await runStart({ resolution: '720p', reference_audio_paths: AUDIO }, { hooks: audioOk });
  assert.equal(r.res.code, 400);
  assert.equal(r.res.body.error, 'reference_audio_not_supported');
  assert.equal(r.calls.moderation.length, 0);
  untouched(r);
});

test('reference audio without a qualifying subscription plan is refused (403) before any side effect', async () => {
  const r = await runStart({ resolution: '720p', reference_audio_paths: AUDIO }, { hooks: { ...audioOk, access: { plan: 'free', hasActiveSubscription: false, hasPurchasedAccess: true, subscriptionExpiresAt: null, watermarkRequired: true } } });
  assert.equal(r.res.code, 403);
  assert.equal(r.res.body.error, 'reference_audio_plan_required');
  assert.equal(r.calls.moderation.length, 0);
  untouched(r);
});

test('moderation block returns 422, records the block, and never reserves, deducts or calls the provider', async () => {
  const r = await runStart({ estimated_credits: price() }, { hooks: { moderationDecision: { ok: true, allow: false, reason: 'blocked' } } });
  assert.equal(r.res.code, 422);
  assert.equal(r.res.body.error, 'content_policy_violation');
  assert.equal(r.calls.inserts.filter(i => i.table === 'moderation_blocks').length, 1);
  untouched(r);
});

test('moderation unavailable returns 503 and never reserves, deducts or calls the provider', async () => {
  const r = await runStart({}, { hooks: { moderationDecision: { ok: false, reason: 'down' } } });
  assert.equal(r.res.code, 503);
  assert.equal(r.res.body.error, 'content_safety_check_unavailable');
  untouched(r);
});

test('PR #273: 1080p without an active subscription is refused before price check, moderation and any side effect', async () => {
  const r = await runStart({ resolution: '1080p', estimated_credits: 1 }, { hooks: { access: { plan: 'free', hasActiveSubscription: false, hasPurchasedAccess: true, subscriptionExpiresAt: null, watermarkRequired: true } } });
  assert.equal(r.res.code, 403);
  assert.equal(r.res.body.error, 'resolution_subscription_required');
  assert.equal(r.calls.moderation.length, 0);
  untouched(r);
});

test('stale estimate with otherwise valid audio is refused (409) before audio retention write, moderation, reserve, deduct, provider', async () => {
  const r = await runStart({ ...audioBody, estimated_credits: 5 }, { hooks: audioOk });
  assert.equal(r.res.code, 409);
  assert.equal(r.calls.updates.length, 0);
  assert.equal(r.calls.moderation.length, 0);
  assert.equal(r.calls.sign.length, 0);
  untouched(r);
});

test('history entrance: the quote inputs are exactly the fields sent to the server (mode, duration, resolution, aspect, model)', async () => {
  const h = loadHistoryStart(jsonRes(200, { ok: true, jobId: 'job-1' }));
  await h.ctx.robustStart();
  const sent = h.state.fetches[0].body;
  const quoted = h.state.quoteArgs.at(-1);
  assert.equal(quoted.mode, sent.mode);
  assert.equal(String(quoted.duration), String(sent.duration));
  assert.equal(quoted.resolution, sent.resolution);
  assert.equal(quoted.aspectRatio, sent.aspect_ratio);
  assert.equal(quoted.model, sent.model);
});
