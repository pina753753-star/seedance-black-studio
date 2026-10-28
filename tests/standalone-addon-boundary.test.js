'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../api/_lib/seedance-start.js'), 'utf8');
const modelValidation = require('../api/_lib/video-model-validation');
const audio = require('../api/_lib/reference-audio');
const dance = require('../api/_lib/reference-dance');
const { hasSeedance25PlanAccess } = require('../api/_lib/video-plan-entitlements');

// The actual handler executes with inert local credentials and all external
// boundaries replaced. Moderation deliberately stops accepted model requests,
// so this test cannot create a task, deduct credits, or invoke a provider.
function harness({ subscription = false } = {}) {
  const calls = { purchasedGate: 0, subscriptionGate: 0, moderation: 0, signedAudio: 0, dbWrites: 0, rpc: 0, provider: 0, danceAdmin: 0 };
  const access = {
    ok: true, allowed: true, plan: subscription ? 'premium' : 'free', accountStatus: 'active',
    hasActiveSubscription: subscription, hasPurchasedAccess: !subscription,
    subscriptionExpiresAt: subscription ? '2999-01-01T00:00:00Z' : null,
    watermarkRequired: !subscription, balance: 1000
  };
  const db = {
    from(table) {
      // Only a subscriber audio request may reach the pre-moderation retention
      // write. Everything else touching a DB table is unexpected here.
      assert.equal(table, audio.REFERENCE_AUDIO_REGISTRY_TABLE);
      const chain = {
        update() { calls.dbWrites++; return chain; },
        eq(field, value) { assert.equal(field, 'user_id'); assert.equal(value, 'owner'); return chain; },
        async in(field, paths) { assert.equal(field, 'path'); assert.equal(paths[0], 'users/owner/clip.mp3'); return { error: null }; }
      };
      return chain;
    },
    async rpc() { calls.rpc++; throw new Error('Unexpected task/credit RPC'); }
  };
  const context = {
    module: { exports: {} }, console: { log() {}, warn() {}, error() {} },
    process: { env: { WAVESPEED_API_KEY: 'local-inert-value', OPENROUTER_API_KEY: 'local-inert-value' } },
    async fetch() { calls.provider++; throw new Error('Unexpected provider request'); },
    require(name) {
      if (name === './reference-dance.js') return { ...dance, authorizeReferenceDanceAdmin: async () => { calls.danceAdmin++; return { ok: true }; } };
      if (name === './credit-access') return { readSubscriptionAccess: async () => ({ ...access }) };
      if (name === '@supabase/supabase-js') return { createClient: () => { throw new Error('Unexpected SDK construction'); } };
      if (name === './confirmed-auth.js') return { requireConfirmedAuth: async () => ({ ok: true, user: { id: 'owner' }, supabase: db }) };
      if (name === './generation-control.js') return { checkGenerationControl: async () => ({ ok: true }), REFUND_UNCONFIRMED_MESSAGE: 'mock' };
      if (name === './video-model-validation.js') return modelValidation;
      if (name === './video-pricing.js') return require('../api/_lib/video-pricing');
      if (name === './video-provider-prompt.js') return { buildProviderPrompt: () => { throw new Error('Past moderation boundary'); } };
      if (name === './video-plan-entitlements.js') return {
        hasSeedance25PlanAccess,
        getSeedance25Entitlement: async () => { calls.purchasedGate++; return { ...access }; },
        getSeedance25SubscriptionEntitlement: async () => { calls.subscriptionGate++; return { ...access, allowed: subscription }; }
      };
      if (name === './reference-audio.js') return { ...audio, createReferenceAudioSignedUrls: async (_db, paths) => { calls.signedAudio++; return { ok: true, urls: paths.map(() => 'https://mock.invalid/signed-audio') }; } };
      if (name === './openai-moderation.js') return { moderateContent: async () => { calls.moderation++; return { ok: false }; } };
      if (name === './moderation-decision.js') return { resolveModerationDecision: async () => ({ ok: false, allow: false, reason: 'test_stop' }) };
      throw new Error(`Unexpected dependency ${name}`);
    }
  };
  vm.runInNewContext(source, context);
  return { calls, async request(body) {
    const res = { status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await context.module.exports({ method: 'POST', body: { prompt: 'A paper boat', model: 'bytedance/seedance-2.5', resolution: subscription ? '1080p' : '720p', duration: 5, aspect_ratio: '16:9', ...body } }, res);
    return res;
  } };
}
function noSpendOrProvider(calls) { assert.equal(calls.rpc, 0); assert.equal(calls.provider, 0); }

for (const model of ['bytedance/seedance-2.5', 'bytedance/seedance-2.5-standard']) {
  const resolution = '720p';
  for (const body of [{ mode: 'storyboard' }, { mode: 'reference_to_video', ui_origin: 'storyboard' }]) {
    test(`purchase-only ${model} rejects ${body.ui_origin ? 'ui_origin storyboard' : 'explicit storyboard'} before any paid or external work`, async () => {
      const h = harness(); const res = await h.request({ model, resolution, ...body });
      assert.equal(res.statusCode, 403); assert.equal(res.body.error, 'seedance_25_plan_required');
      assert.equal(h.calls.subscriptionGate, 1); assert.equal(h.calls.purchasedGate, 0);
      assert.equal(h.calls.moderation, 0); assert.equal(h.calls.signedAudio, 0); assert.equal(h.calls.dbWrites, 0);
      noSpendOrProvider(h.calls);
    });
  }
  for (const mode of ['text_to_video', 'image_to_video', 'reference_to_video']) {
    test(`purchase-only normal ${model} ${mode} passes model access and reaches the moderation boundary`, async () => {
      const h = harness(); const res = await h.request({ model, resolution, mode });
      assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'content_safety_check_unavailable');
      assert.equal(h.calls.purchasedGate, 1); assert.equal(h.calls.subscriptionGate, 0);
      assert.equal(h.calls.moderation, 1); assert.equal(h.calls.dbWrites, 0);
      noSpendOrProvider(h.calls);
    });
  }
}
test('purchase-only reference_audio_paths is rejected before retention, signing, moderation, debit or provider', async () => {
  const h = harness(); const res = await h.request({ mode: 'text_to_video', reference_audio_paths: ['users/owner/clip.mp3'] });
  assert.equal(res.statusCode, 403); assert.equal(res.body.error, 'reference_audio_plan_required');
  assert.equal(h.calls.purchasedGate, 1); assert.equal(h.calls.dbWrites, 0); assert.equal(h.calls.signedAudio, 0); assert.equal(h.calls.moderation, 0);
  noSpendOrProvider(h.calls);
});
test('active Premium retains both storyboard entry forms', async () => {
  for (const body of [{ mode: 'storyboard' }, { mode: 'reference_to_video', ui_origin: 'storyboard' }]) {
    const h = harness({ subscription: true }); const res = await h.request(body);
    assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'content_safety_check_unavailable');
    assert.equal(h.calls.subscriptionGate, 1); assert.equal(h.calls.moderation, 1);
    noSpendOrProvider(h.calls);
  }
});
test('active Premium retains owned reference audio validation and retention before moderation', async () => {
  const h = harness({ subscription: true });
  const res = await h.request({ mode: 'text_to_video', reference_audio_paths: ['users/owner/clip.mp3'] });
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'content_safety_check_unavailable');
  assert.equal(h.calls.dbWrites, 1); assert.equal(h.calls.signedAudio, 1); assert.equal(h.calls.moderation, 1);
  noSpendOrProvider(h.calls);
});
test('ordinary 2.0 storyboard keeps its existing free-capable model path', async () => {
  const h = harness(); const res = await h.request({ model: 'bytedance/seedance-2.0', mode: 'storyboard', resolution: '720p' });
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'content_safety_check_unavailable');
  assert.equal(h.calls.purchasedGate, 0); assert.equal(h.calls.subscriptionGate, 0); assert.equal(h.calls.moderation, 1);
  noSpendOrProvider(h.calls);
});


test('purchase-only admin dance stays subscription-only before asset access and moderation', async () => {
  const h = harness();
  const res = await h.request({ mode: 'reference_to_video', resolution: '720p', reference_video_asset_id: '270bf01a-bafd-4255-8ad5-e18a4f1c8c47' });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'seedance_25_plan_required');
  assert.equal(h.calls.subscriptionGate, 1);
  assert.equal(h.calls.purchasedGate, 0);
  assert.equal(h.calls.danceAdmin, 0);
  assert.equal(h.calls.dbWrites, 0);
  assert.equal(h.calls.moderation, 0);
  noSpendOrProvider(h.calls);
});

for (const mode of ['text_to_video','image_to_video','reference_to_video','storyboard']) {
  test(`Fast 1080p ${mode} rejects before moderation, writes, debit and provider`, async () => {
    const h=harness(); const res=await h.request({model:'bytedance/seedance-2.0-fast',resolution:'1080p',mode});
    assert.equal(res.statusCode,400);assert.equal(res.body.error,'invalid_resolution');
    assert.equal(h.calls.moderation,0);assert.equal(h.calls.dbWrites,0);noSpendOrProvider(h.calls);
  });
  for(const resolution of ['480p','720p'])test(`Fast ${resolution} ${mode} still reaches moderation`,async()=>{
    const h=harness();const res=await h.request({model:'bytedance/seedance-2.0-fast',resolution,mode});
    assert.equal(res.statusCode,503);assert.equal(res.body.error,'content_safety_check_unavailable');assert.equal(h.calls.moderation,1);noSpendOrProvider(h.calls);
  });
}

for(const model of ['bytedance/seedance-2.0','bytedance/seedance-2.5']){
 test(model+' purchase-only 1080p replay denied before any work',async()=>{
  const h=harness();const r=await h.request({model,resolution:'1080p'});
  assert.equal(r.statusCode,403);assert.equal(r.body.error,'resolution_subscription_required');
  assert.equal(h.calls.moderation,0);assert.equal(h.calls.dbWrites,0);noSpendOrProvider(h.calls);
 });
 test(model+' active subscription retains 1080p',async()=>{
  const h=harness({subscription:true});const r=await h.request({model,resolution:'1080p'});
  assert.equal(r.body.error,'content_safety_check_unavailable');assert.equal(h.calls.moderation,1);noSpendOrProvider(h.calls);
 });
}
