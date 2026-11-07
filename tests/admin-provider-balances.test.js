'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/admin-provider-balances');
const baseEnv = () => ({ ADMIN_EMAIL: 'admin@example.test', WAVESPEED_API_KEY: 'mock-wave-key', FAL_KEY: 'mock-fal-key' });
function setup(options = {}) {
  const state = { auth: true, role: 'admin', id: 'owner', email: 'admin@example.test', profileError: null, profileId: null, profileEmail: null, calls: [], authCalls: 0, profileCalls: 0, time: 1000000 };
  const env = options.env || baseEnv();
  const handler = createHandler({ env, now: () => state.time, timeoutMs: 15,
    requireAuth: async () => { state.authCalls++; if (state.authFailure) return state.authFailure; return state.auth ? { ok: true, user: { id: state.id, email: state.email }, supabase: { from: () => ({ select: () => ({ eq: (_field, id) => { assert.equal(id, state.id); return { maybeSingle: async () => { state.profileCalls++; return { error: state.profileError, data: { id: state.profileId || state.id, email: state.profileEmail || state.email, role: state.role } }; } }; } }) }) } } : { ok: false, status: 401 }; },
    fetchImpl: async (url, init) => { state.calls.push({ url, init }); if (options.fetch) return options.fetch(url, init, state); return json(url.includes('wavespeed') ? { code: 200, data: { balance: 0 }, private: 'do-not-return' } : { username: 'do-not-return', credits: { current_balance: 12.3, currency: 'USD' } }); }
  });
  async function call(method = 'GET') { const result = { headers: {} }; const res = { setHeader: (k,v) => result.headers[k] = v, status: n => { result.status = n; return res; }, json: body => { result.body = body; return res; } }; await handler({ method, query: { url: 'https://evil.invalid', refresh: 'true' } }, res); return result; }
  return { state, env, call };
}
function json(data, status = 200) { return new Response(JSON.stringify(data), { status }); }
test('fixed GETs, auth headers, zero valid, no account/key leakage', async () => {
  const { state, call } = setup(); const r = await call();
  assert.equal(r.status,200); assert.equal(r.headers['Cache-Control'],'no-store');
  assert.equal(r.body.providers[0].balance,0); assert.equal(r.body.providers[0].state,'current');
  assert.equal(r.body.providers[1].balance,12.3);
  assert.deepEqual(state.calls.map(c=>c.url),['https://api.wavespeed.ai/api/v3/balance','https://api.fal.ai/v1/account/billing?expand=credits']);
  assert.equal(state.calls[0].init.headers.Authorization,'Bearer mock-wave-key'); assert.equal(state.calls[1].init.headers.Authorization,'Key mock-fal-key');
  for (const {init} of state.calls) { assert.equal(init.redirect,'error'); assert.equal(init.method,'GET'); }
  assert.doesNotMatch(JSON.stringify(r),/mock-|do-not-return|username|admin@example/);
});
test('method rejected before authentication/provider', async()=>{const s=setup();assert.equal((await s.call('POST')).status,405);assert.equal(s.state.authCalls,0);assert.equal(s.state.calls.length,0)});
for (const [label, mutate] of [
  ['logout',s=>s.state.auth=false], ['role removed',s=>s.state.role='user'], ['wrong email',s=>s.state.email='other@example.test'],
  ['profile error',s=>s.state.profileError={message:'private'}], ['wrong profile',s=>s.state.profileId='other'], ['profile email mismatch',s=>s.state.profileEmail='other@example.test'], ['admin config missing',s=>delete s.env.ADMIN_EMAIL]
]) test(label+' cannot read warmed cache',async()=>{const s=setup();await s.call();mutate(s);const r=await s.call();assert.ok([401,403].includes(r.status));assert.equal(s.state.calls.length,2);assert.equal(r.body.providers,undefined)});
test('missing provider keys means unconfigured, not zero',async()=>{const s=setup({env:{ADMIN_EMAIL:'admin@example.test'}});const r=await s.call();assert.equal(s.state.calls.length,0);for(const row of r.body.providers){assert.equal(row.state,'unconfigured');assert.equal(row.balance,null)}});
test('cache/parallel coalescing incl failures and per-request authorization',async()=>{const s=setup({fetch:async()=>{await new Promise(r=>setTimeout(r,2));return json({},429)}});await Promise.all(Array.from({length:20},()=>s.call()));assert.equal(s.state.calls.length,2);assert.equal(s.state.profileCalls,20);await s.call();assert.equal(s.state.calls.length,2);s.state.time+=30001;await s.call();assert.equal(s.state.calls.length,4)});
test('failed refresh retains explicitly stale zero and success timestamp',async()=>{let fail=false;const s=setup({fetch:async()=>fail?json({},500):json({code:200,data:{balance:0},credits:{current_balance:0,currency:'USD'}})});const a=await s.call();s.state.time+=30001;fail=true;const b=await s.call();for(let i=0;i<2;i++){assert.equal(b.body.providers[i].state,'stale');assert.equal(b.body.providers[i].balance,0);assert.equal(b.body.providers[i].fetchedAt,a.body.providers[i].fetchedAt);assert.notEqual(b.body.providers[i].checkedAt,a.body.providers[i].checkedAt)}});
test('key rotation and user switch never reuse prior balances',async()=>{const s=setup();await s.call();s.env.WAVESPEED_API_KEY='another-mock';await s.call();assert.equal(s.state.calls.length,3);s.state.id='new-owner';await s.call();assert.equal(s.state.calls.length,5)});
for(const status of [401,403,429,500,302])test('provider HTTP '+status+' is unknown, safe and independently handled',async()=>{const s=setup({fetch:async url=>url.includes('wavespeed')?new Response('private-secret',{status}):json({credits:{current_balance:4,currency:'USD'}})});const r=await s.call();assert.equal(r.body.providers[0].state,'unknown');assert.equal(r.body.providers[0].balance,null);assert.equal(r.body.providers[1].state,'current');assert.doesNotMatch(JSON.stringify(r),/private-secret/)});
for(const [name,body]of [['malformed','{'],['missing','{}'],['string',JSON.stringify({code:200,data:{balance:'0'}})],['code not 200',JSON.stringify({code:500,data:{balance:8}})],['negative',JSON.stringify({code:200,data:{balance:-1}})],['overflow', '{"code":200,"data":{"balance":1e999}}'],['oversized','x'.repeat(16385)]])test(name+' is unknown not zero',async()=>{const s=setup({fetch:async()=>new Response(body)});const r=await s.call();assert.equal(r.body.providers[0].state,'unknown');assert.equal(r.body.providers[0].balance,null)});
test('fal invalid currency fails closed',async()=>{const s=setup({fetch:async()=>json({credits:{current_balance:1,currency:'<script>'}})});assert.equal((await s.call()).body.providers[1].state,'unknown')});
test('timeout bounds fetch and body reads',async()=>{for(const bodyPhase of [false,true]){const s=setup({fetch:async(_u,init)=>bodyPhase?new Response(new ReadableStream({start(c){init.signal.addEventListener('abort',()=>c.error(new Error('secret')))}})):new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('secret'))))});const r=await s.call();assert.equal(r.body.providers[0].error,'timeout');assert.doesNotMatch(JSON.stringify(r),/secret/);}});
test('failed old identity cannot overwrite new identity cache',async()=>{let release;const wait=new Promise(r=>release=r);const s=setup({fetch:async(_u,init)=>{if(init.headers.Authorization.includes('mock-wave'))await wait;return json({code:200,data:{balance:init.headers.Authorization.includes('new-key')?7:2},credits:{current_balance:2,currency:'USD'}})}});const first=s.call();await new Promise(r=>setTimeout(r,0));s.env.WAVESPEED_API_KEY='new-key';const second=await s.call();assert.equal(second.body.providers[0].balance,7);release();await first;assert.equal((await s.call()).body.providers[0].balance,7)});

for (const [label, status, error] of [
  ['unconfirmed email', 403, 'EMAIL_NOT_CONFIRMED'],
  ['authentication outage', 503, 'AUTH_VERIFICATION_UNAVAILABLE']
]) for (const warmed of [false, true]) test(label + (warmed ? ' after cached success' : ' before any fetch'), async () => {
  const s = setup();
  if (warmed) await s.call();
  const before = s.state.calls.length, profilesBefore = s.state.profileCalls;
  s.state.authFailure = { ok: false, status, body: { error, message: 'private auth diagnostic' } };
  const result = await s.call();
  assert.equal(result.status, status);
  assert.equal(result.body.providers, undefined);
  assert.equal(s.state.calls.length, before, 'no additional provider requests');
  assert.equal(s.state.profileCalls, profilesBefore, 'no profile reads after failed authentication');
  if (!warmed) assert.equal(s.state.calls.length, 0);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.doesNotMatch(JSON.stringify(result), /private auth diagnostic/);
});

test('billing key takes precedence only for fal balances', async () => {
  const env = { ...baseEnv(), FAL_BILLING_KEY: '  mock-billing-only  ' };
  const s = setup({ env }); await s.call();
  assert.equal(s.state.calls[1].init.headers.Authorization, 'Key mock-billing-only');
  assert.equal(s.state.calls[0].init.headers.Authorization, 'Bearer mock-wave-key');
  assert.equal(env.FAL_KEY, 'mock-fal-key');
});
test('billing-only configuration does not require an inference key', async () => {
  const s = setup({ env: { ADMIN_EMAIL: 'admin@example.test', FAL_BILLING_KEY: 'mock-billing-only' } });
  const r = await s.call(); assert.equal(s.state.calls.length, 1);
  assert.equal(r.body.providers[1].state, 'current');
  assert.doesNotMatch(JSON.stringify(r), /mock-billing-only/);
});
test('blank billing key preserves existing FAL_KEY and FAL_API_KEY fallback', async () => {
  for (const legacy of [{ FAL_KEY: 'mock-primary', FAL_API_KEY: 'mock-secondary' }, { FAL_API_KEY: 'mock-secondary' }]) {
    const s = setup({ env: { ADMIN_EMAIL: 'admin@example.test', FAL_BILLING_KEY: '  ', ...legacy } });
    await s.call(); assert.equal(s.state.calls[0].init.headers.Authorization, 'Key ' + (legacy.FAL_KEY || legacy.FAL_API_KEY));
  }
});
test('billing permission denial never retries with inference key', async () => {
  const s = setup({ env: { ...baseEnv(), FAL_BILLING_KEY: 'mock-denied' }, fetch: async () => json({}, 403) });
  const r = await s.call();
  const falCalls = s.state.calls.filter(c => c.url.includes('api.fal.ai'));
  assert.equal(falCalls.length, 1); assert.equal(falCalls[0].init.headers.Authorization, 'Key mock-denied');
  assert.equal(r.body.providers[1].state, 'unknown'); assert.equal(r.body.providers[1].error, 'access_unavailable');
});
test('changing billing key invalidates old account balance cache', async () => {
  const env = { ...baseEnv(), FAL_BILLING_KEY: 'mock-billing-first' };
  const s = setup({ env }); await s.call();
  env.FAL_BILLING_KEY = 'mock-billing-second'; await s.call();
  assert.equal(s.state.calls.length, 3);
  assert.equal(s.state.calls[2].init.headers.Authorization, 'Key mock-billing-second');
});
test('H3 generation config ignores billing key and keeps inference key', () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../api/_lib/h3-live-config.js'), 'utf8'), {
    module, exports: module.exports, URL,
    process: { env: { FAL_BILLING_KEY: 'mock-billing-only', FAL_KEY: 'mock-generation-only' } }
  });
  assert.equal(module.exports.falApiKey(), 'mock-generation-only');
});

for (const [label, response, expected] of [
  ['401', () => json({}, 401), 'access_unavailable'],
  ['429', () => json({}, 429), 'rate_limited'],
  ['500', () => json({}, 500), 'provider_unavailable'],
  ['malformed JSON', () => new Response('{'), 'provider_unavailable'],
  ['missing balance', () => json({}), 'invalid_response'],
  ['timeout', (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('mock-private-error')))), 'timeout']
]) test('dedicated billing failure ' + label + ' is bounded and never uses inference fallback', async () => {
  const s = setup({ env: { ADMIN_EMAIL: 'admin@example.test', FAL_BILLING_KEY: 'mock-billing-only', FAL_KEY: 'mock-generation-only' }, fetch: response });
  const first = await s.call();
  assert.equal(first.body.providers[1].state, 'unknown');
  assert.equal(first.body.providers[1].balance, null);
  assert.equal(first.body.providers[1].error, expected);
  await s.call();
  assert.equal(s.state.calls.length, 1, 'failures are cached, no immediate retry');
  assert.equal(s.state.calls[0].init.headers.Authorization, 'Key mock-billing-only');
  assert.doesNotMatch(JSON.stringify(first), /mock-billing|mock-generation|mock-private/);
});
test('dedicated billing failed refresh preserves stale balance and timestamp', async () => {
  let failed = false;
  const s = setup({ env: { ADMIN_EMAIL: 'admin@example.test', FAL_BILLING_KEY: 'mock-billing-only' }, fetch: () => failed ? json({}, 403) : json({ credits: { current_balance: 0, currency: 'USD' } }) });
  const first = await s.call(); failed = true; s.state.time += 30001;
  const next = await s.call();
  assert.equal(next.body.providers[1].state, 'stale');
  assert.equal(next.body.providers[1].balance, 0);
  assert.equal(next.body.providers[1].fetchedAt, first.body.providers[1].fetchedAt);
  assert.equal(next.body.providers[1].error, 'access_unavailable');
  assert.equal(s.state.calls.length, 2);
});
