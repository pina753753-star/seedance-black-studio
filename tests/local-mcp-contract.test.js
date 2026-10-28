'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCore } = require('../local-mcp/core');
const { createMockStore } = require('../local-mcp/mock-store');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing');
const { createQuoteIntegrity } = require('../local-mcp/quote-integrity');
const INPUT = { prompt: 'A paper boat at sunset', model: 'bytedance/seedance-2.0', duration: 5, resolution: '720p', aspect_ratio: '16:9' };
function fixture() {
  let time = 1000, seq = 0;
  const scopes = ['credits:read', 'generation:read', 'generation:write'];
  const identities = new Map([
    ['alice', { userId: 'alice', scopes, emailConfirmed: true, accountStatus: 'active', expiresAt: 99999999 }],
    ['bob', { userId: 'bob', scopes, emailConfirmed: true, accountStatus: 'active', expiresAt: 99999999 }]
  ]);
  const state = { starts: [], credits: 1000, watermark: true, allowed: true, priceExtra: 0, tasks: new Map(), startError: false, active: false };
  const store = createMockStore();
  const backend = {
    async readAccess(userId) { return { userId, allowed: state.allowed, availableCredits: state.credits, watermarkRequired: state.watermark, models: [INPUT.model, 'bytedance/seedance-2.0-fast', 'bytedance/seedance-2.5-standard', 'bytedance/seedance-2.5'] }; },
    async start(request) {
      state.starts.push(request);
      if (state.startError) throw new Error('private diagnostic: never expose');
      if (state.active) throw new Error('active generation already exists');
      // Mock the existing atomic guard/deduct. No actual provider or DB call.
      state.active = true;
      state.credits -= request.expectedCredits;
      const taskId = `task-${state.starts.length}`;
      state.tasks.set(taskId, { taskId, userId: request.userId, status: 'queued', settings: {watermark_required:request.watermarkRequired}, outputUrl: 'https://secret-provider.invalid/raw.mp4' });
      return { userId: request.userId, taskId };
    },
    async readSnapshot(userId, taskId) { return state.tasks.get(taskId); }
  };
  const app = createCore({ integrity:createQuoteIntegrity(Buffer.alloc(32,7)), authenticate: async context => identities.get(context?.testIdentity), store, backend, now: () => time, createId: () => `proposal-${++seq}`, artifactHosts: ['artifacts.example.test'], price: input => calculateVideoCreditCost(input) + state.priceExtra });
  const context = user => ({ testIdentity: user });
  const call = (name, args = {}, user = 'alice') => app.dispatch(name, args, context(user));
  const estimate = (user = 'alice', input = INPUT) => call('pina_estimate_generation', input, user);
  const approve = (q, user = 'alice') => app.approveProposal(q.proposal_id, q.fingerprint, context(user));
  const start = (q, request_id = 'request-1', user = 'alice') => call('pina_start_generation', { proposal_id: q.proposal_id, request_id }, user);
  return { app, state, backend, store, identities, call, estimate, approve, start, advance: ms => { time += ms; } };
}
const rejects = (fn, code) => assert.rejects(fn, error => error.code === code);

test('public entry offers no checkout tools or upsell links in balance, quote or refusal responses', async () => {
  const h = fixture();
  const responses = [h.app.listTools(), await h.call('pina_get_balance'), await h.estimate()];
  h.state.credits = 0;
  responses.push(await h.app.handle({method:'tools/call', params:{name:'pina_estimate_generation',arguments:INPUT}}, {testIdentity:'alice'}));
  h.state.allowed = false;
  responses.push(await h.app.handle({method:'tools/call', params:{name:'pina_estimate_generation',arguments:INPUT}}, {testIdentity:'alice'}));
  for (const name of ['checkout', 'purchase_credits', 'upgrade_subscription']) {
    responses.push(await h.app.handle({method:'tools/call', params:{name,arguments:{}}}, {testIdentity:'alice'}));
  }
  assert.doesNotMatch(JSON.stringify(responses), /checkout|buy\.stripe|pricing\.html|purchase_credits|upgrade_subscription|購入はこちら|アップグレード/i);
  assert.equal(h.state.starts.length, 0);
});

test('five tools, no approval tool, strict arguments, accurate side-effect annotations', () => {
  const h = fixture(), tools = h.app.listTools();
  assert.equal(tools.length, 5);
  assert.ok(tools.every(t => t.inputSchema.additionalProperties === false));
  assert.ok(tools.every(t => t.securitySchemes[0].type === 'oauth2'));
  assert.equal(tools.find(t => t.name === 'pina_estimate_generation').annotations.readOnlyHint, false);
  assert.equal(tools.find(t => t.name === 'pina_start_generation').annotations.openWorldHint, true);
  assert.ok(!tools.some(t => /approve/.test(t.name)));
  tools[0].name = 'tampered';
  assert.equal(h.app.listTools()[0].name, 'pina_get_balance');
});
test('balance identity comes only from trusted context, not tool arguments', async () => {
  const h = fixture();
  assert.equal((await h.call('pina_get_balance')).available_credits, 1000);
  await rejects(() => h.call('pina_get_balance', { userId: 'bob' }), 'invalid_arguments');
  await rejects(() => h.call('pina_get_balance', {}, 'unknown'), 'unauthenticated');
});
for (const [name, change, code] of [
  ['expired', { expiresAt: 1 }, 'unauthenticated'],
  ['unconfirmed', { emailConfirmed: false }, 'account_restricted'],
  ['blocked', { accountStatus: 'restricted' }, 'account_restricted'],
  ['scope', { scopes: [] }, 'insufficient_scope']
]) test(`${name} identity is rejected`, async () => {
  const h = fixture(); Object.assign(h.identities.get('alice'), change);
  await rejects(() => h.call('pina_get_balance'), code);
  assert.equal(h.state.starts.length, 0);
});
test('estimate reuses real validation/pricing without starting or consuming credits', async () => {
  const h = fixture();
  const q = await h.estimate();
  assert.equal(q.credits, 85);
  assert.equal((await h.estimate('alice', { ...INPUT, model: 'bytedance/seedance-2.0-fast' })).credits, 70);
  assert.equal(h.state.credits, 1000);
  assert.equal(h.state.starts.length, 0);
  assert.equal(q.approval_required, true);
});
test('unsupported features, unknown fields and invalid model settings fail closed', async () => {
  const h = fixture();
  for (const input of [{ ...INPUT, model: 'unavailable/model' }, { ...INPUT, user_id: 'bob' }, { ...INPUT, duration: 1.1 }, { ...INPUT, approved: true }]) await rejects(() => h.estimate('alice', input), 'invalid_arguments');
  assert.equal(h.state.starts.length, 0);
});
test('unapproved generation and model-supplied approval flag are rejected', async () => {
  const h = fixture(), q = await h.estimate();
  await rejects(() => h.start(q), 'approval_required');
  await rejects(() => h.call('pina_start_generation', { proposal_id: q.proposal_id, request_id: 'r', approved: true }), 'invalid_arguments');
  assert.equal(h.state.starts.length, 0);
});
test('other user cannot approve or start a proposal', async () => {
  const h = fixture(), q = await h.estimate();
  await rejects(() => h.approve(q, 'bob'), 'not_found');
  await h.approve(q);
  await rejects(() => h.start(q, 'r', 'bob'), 'not_found');
});
test('approval is bound to fingerprint and cannot be reused after expiry', async () => {
  const h = fixture(), q = await h.estimate();
  await rejects(() => h.app.approveProposal(q.proposal_id, 'changed', { testIdentity: 'alice' }), 'proposal_changed');
  await h.approve(q); h.advance(600001);
  await rejects(() => h.start(q), 'proposal_expired');
});
test('mutating a returned quote does not mutate stored approved input', async () => {
  const h = fixture(), q = await h.estimate();
  q.input.prompt = 'changed'; q.credits = 1;
  await h.approve(q); await h.start(q);
  assert.equal(h.state.starts[0].input.prompt, INPUT.prompt);
  assert.equal(h.state.starts[0].expectedCredits, 85);
});
test('price and watermark changes require new approval before generation', async () => {
  for (const field of ['priceExtra', 'watermark']) {
    const h = fixture(), q = await h.estimate(); await h.approve(q);
    h.state[field] = field === 'priceExtra' ? 5 : false;
    await rejects(() => h.start(q), 'requote_required');
    assert.equal(h.state.starts.length, 0);
  }
});
test('balance and access are rechecked at start', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q);
  h.state.credits = 0; await rejects(() => h.start(q), 'insufficient_credits');
  h.state.allowed = false; await rejects(() => h.start(q), 'access_unavailable');
  assert.equal(h.state.starts.length, 0);
});
test('concurrent same-request calls start and deduct once, replay after expiry returns task', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q);
  const results = await Promise.all(Array.from({ length: 20 }, () => h.start(q)));
  assert.equal(h.state.starts.length, 1);
  assert.equal(h.state.credits, 915);
  assert.ok(results.every(r => ['pending', 'started'].includes(r.state)));
  h.advance(600001);
  assert.equal((await h.start(q)).task_id, 'task-1');
  assert.equal(h.state.starts.length, 1);
});
test('same proposal cannot start again with another request ID, including concurrent calls', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q);
  const result = await Promise.allSettled([h.start(q, 'one'), h.start(q, 'two')]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.find(r => r.status === 'rejected').reason.code, 'proposal_consumed');
  assert.equal(h.state.starts.length, 1);
});
test('same request ID with different proposal is a conflict', async () => {
  const h = fixture(), q = await h.estimate(), other = await h.estimate();
  await h.approve(q); await h.start(q);
  await rejects(() => h.start(other), 'request_conflict');
});
test('provider uncertainty does not retry or expose diagnostics', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q); h.state.startError = true;
  assert.equal((await h.start(q)).state, 'uncertain');
  assert.equal((await h.start(q)).state, 'uncertain');
  await rejects(() => h.start(q, 'another'), 'proposal_consumed');
  assert.equal(h.state.starts.length, 1);
});
test('persistence failure after start remains blocking even if uncertain-marker write also fails', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q);
  h.store.complete = async () => { throw new Error('storage failure'); };
  h.store.markUncertain = async () => { throw new Error('storage failure'); };
  assert.equal((await h.start(q)).state, 'uncertain');
  assert.equal((await h.start(q)).state, 'pending');
  assert.equal(h.state.starts.length, 1);
});
test('claim-store failure prevents backend invocation', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q);
  h.store.claim = async () => { throw new Error('DB failure'); };
  await assert.rejects(() => h.start(q));
  assert.equal(h.state.starts.length, 0);
});
test('status is owner-only and never returns raw URL or provider fields', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q); const r = await h.start(q);
  await rejects(() => h.call('pina_get_generation', { task_id: r.task_id }, 'bob'), 'not_found');
  const result = await h.call('pina_get_generation', { task_id: r.task_id });
  assert.deepEqual(Object.keys(result).sort(), ['refund_status', 'status', 'task_id']);
});
test('free artifact requires completion and a valid watermarked URL; no raw fallback', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q); const r = await h.start(q);
  const args = { task_id: r.task_id }, task = h.state.tasks.get(r.task_id);
  await rejects(() => h.call('pina_get_artifact', args), 'artifact_not_ready');
  task.status = 'completed'; await rejects(() => h.call('pina_get_artifact', args), 'artifact_not_ready');
  task.watermarkComplete = true; task.watermarkedUrl = 'https://artifacts.example.test/watermarked.mp4';
  assert.equal((await h.call('pina_get_artifact', args)).watermarked, true);
  await rejects(() => h.call('pina_get_artifact', args, 'bob'), 'not_found');
  for (const url of ['https://evil.test/file', 'http://artifacts.example.test/file', 'https://user:pass@artifacts.example.test/file']) {
    task.watermarkedUrl = url; await rejects(() => h.call('pina_get_artifact', args), 'artifact_not_ready');
  }
});
test('local tool envelope returns structured content and sanitized errors', async () => {
  const h = fixture();
  const call = { method: 'tools/call', params: { name: 'pina_get_balance', arguments: {} } };
  assert.equal((await h.app.handle(call, { testIdentity: 'alice' })).structuredContent.available_credits, 1000);
  h.backend.readAccess = async () => { throw new Error('private server detail'); };
  const error = await h.app.handle(call, { testIdentity: 'alice' });
  assert.equal(error.content[0].text, 'internal_error');
  assert.equal(error.isError, true);
});

test('balance only advertises models allowed by server-owned access; malformed models fail closed', async () => {
  const h = fixture();
  const original = h.backend.readAccess;
  h.backend.readAccess = async user => ({ ...await original(user), models: ['bytedance/seedance-2.0-fast'] });
  assert.deepEqual((await h.call('pina_get_balance')).models, ['bytedance/seedance-2.0-fast']);
  h.backend.readAccess = async user => ({ ...await original(user), models: [] });
  assert.deepEqual((await h.call('pina_get_balance')).models, []);
  h.backend.readAccess = async user => ({ ...await original(user), models: null });
  await rejects(() => h.call('pina_get_balance'), 'access_unavailable');
});
test('spent credits or loss of start eligibility does not hide existing completed artifacts', async () => {
  const h = fixture(), q = await h.estimate(); await h.approve(q); const r = await h.start(q);
  Object.assign(h.state.tasks.get(r.task_id), { status: 'completed', watermarkComplete: true, watermarkedUrl: 'https://artifacts.example.test/watermarked.mp4' });
  h.state.credits = 0; h.state.allowed = false;
  assert.equal((await h.call('pina_get_artifact', { task_id: r.task_id })).watermarked, true);
  assert.equal((await h.call('pina_get_balance')).available_credits, 0);
});

test('current main pricing: 1080 aspect floor and both 2.5 variants, Fast1080 rejected',async()=>{
 const h=fixture();h.state.watermark=false;
 for(const [input,credits] of [[{model:INPUT.model,resolution:'1080p',duration:15},535],[{model:INPUT.model,resolution:'1080p',duration:15,aspect_ratio:'1:1'},335],[{model:'bytedance/seedance-2.5-standard',duration:15},495],[{model:'bytedance/seedance-2.5',resolution:'1080p',duration:15},300]])assert.equal((await h.estimate('alice',{...INPUT,...input})).credits,credits);
 await rejects(()=>h.estimate('alice',{...INPUT,model:'bytedance/seedance-2.0-fast',resolution:'1080p'}),'invalid_resolution');
 assert.equal(h.state.starts.length,0);
});
test('signed proposal rejects stored input, owner, expiry, amount or policy modification',async()=>{
 for(const mutate of [q=>q.input.prompt='altered',q=>q.input.aspect_ratio='1:1',q=>q.credits=1,q=>q.watermarkRequired=false,q=>q.expiresAt+=1,q=>q.id='different']){
  const h=fixture(),q=await h.estimate();await h.approve(q);const read=h.store.getProposal;h.store.getProposal=async id=>{const p=await read(id);mutate(p);return p};await rejects(()=>h.start(q),'proposal_changed');assert.equal(h.state.starts.length,0);
 }
});
test('approval record must bind the user and signed proposal',async()=>{
 const h=fixture(),q=await h.estimate();const read=h.store.getProposal;h.store.getProposal=async id=>({...await read(id),approved:true});await rejects(()=>h.start(q),'approval_required');
});
test('task watermark snapshot survives later subscription changes in either direction',async()=>{
 for(const original of [true,false]){
  const h=fixture();h.state.watermark=original;const q=await h.estimate();await h.approve(q);const r=await h.start(q);const task=h.state.tasks.get(r.task_id);Object.assign(task,{status:'completed',outputUrl:'https://artifacts.example.test/original.mp4'});h.state.watermark=!original;
  if(original)await rejects(()=>h.call('pina_get_artifact',{task_id:r.task_id}),'artifact_not_ready');
  else assert.equal((await h.call('pina_get_artifact',{task_id:r.task_id})).watermarked,false);
 }
});
test('authentication adapter rejects wrong issuer/audience/expiry and ignores claimed user metadata',async()=>{
 const {createAuthenticator}=require('../local-mcp/identity');let claims={iss:'https://issuer.invalid',aud:'https://mcp.invalid',sub:'opaque-sub',exp:100,scope:'credits:read',userId:'attacker'};let link;
 const auth=createAuthenticator({issuer:claims.iss,audience:claims.aud,now:()=>1000,verifyToken:async token=>{assert.equal(token,'mock-access');return claims},resolveIdentity:async x=>{link=x;return {userId:'alice',emailConfirmed:true,accountStatus:'active'}}});
 assert.equal((await auth({accessToken:'mock-access'})).userId,'alice');assert.deepEqual(link,{issuer:'https://issuer.invalid',subject:'opaque-sub'});
 for(const bad of [{iss:'wrong'},{aud:'https://other.invalid'},{exp:0},{nbf:200},{sub:''}]){const old=claims;claims={...claims,...bad};await rejects(()=>auth({accessToken:'mock-access'}),'unauthenticated');claims=old;}
});

test('unsigned extra stored input cannot reach backend through an approved quote',async()=>{
 const h=fixture(),q=await h.estimate();await h.approve(q);const read=h.store.getProposal;
 h.store.getProposal=async id=>{const stored=await read(id);stored.input.reference_video_url='https://evil.invalid/video';return stored};
 await rejects(()=>h.start(q),'proposal_changed');assert.equal(h.state.starts.length,0);
});

test('cancelled existing task remains readable without provider URLs or assumed refund', async () => {
 const h=fixture(),q=await h.estimate();await h.approve(q);const r=await h.start(q);
 h.state.tasks.get(r.task_id).status='cancelled';
 assert.deepEqual(await h.call('pina_get_generation',{task_id:r.task_id}),{task_id:r.task_id,status:'cancelled',refund_status:'unknown'});
});


test('Fast 1-3s estimates fail before proposal persistence; supported 4s stays55credits', async()=>{
 const h=fixture();let proposals=0;const original=h.store.createProposal.bind(h.store);h.store.createProposal=async q=>{proposals++;return original(q);};
 const input={...INPUT,model:'bytedance/seedance-2.0-fast',resolution:'480p',aspect_ratio:'1:1'};
 for(const duration of [1,2,3])await rejects(()=>h.estimate('alice',{...input,duration}),'invalid_duration');
 assert.equal(proposals,0);assert.equal(h.state.starts.length,0);assert.equal(h.state.credits,1000);
 const q=await h.estimate('alice',{...input,duration:4});assert.equal(q.credits,55);assert.equal(q.approval_required,true);assert.equal(proposals,1);
 const {validateVideoGenerationOptions}=require('../api/_lib/video-model-validation');
 for(const mode of ['text_to_video','image_to_video','reference_to_video','storyboard'])for(const duration of [1,2,3])assert.equal(validateVideoGenerationOptions({...input,mode,duration}).error,'invalid_duration');
 for(const resolution of ['480p','720p'])for(const duration of [4,15])assert.equal(validateVideoGenerationOptions({...input,mode:'text_to_video',duration,resolution}).ok,true);
});

test('1080p quote requires active subscription and expiry rejects start without consuming',async()=>{
 const h=fixture(),input={...INPUT,resolution:'1080p'};
 await rejects(()=>h.estimate('alice',input),'resolution_subscription_required');
 h.state.watermark=false;const q=await h.estimate('alice',input);await h.approve(q);
 h.state.watermark=true;await rejects(()=>h.start(q),'resolution_subscription_required');
 assert.equal(h.state.starts.length,0);assert.equal(h.state.credits,1000);
});
