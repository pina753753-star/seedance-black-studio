'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'api/credit-access.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
function apiHarness({auth, access, throwLookup} = {}) {
  const calls = [];
  const context = { module: { exports: {} }, require(name) {
    if (name.endsWith('confirmed-auth.js')) return { requireConfirmedAuth: async () => auth || { ok: true, user: { id: 'owner' }, supabase: 'db-mock' } };
    if (name.endsWith('credit-access.js')) return { getCreditAccess: async (...args) => {
      calls.push(args); if (throwLookup) throw new Error('private database details');
      return access || { ok: true, allowed: true, hasActiveSubscription: false, hasPurchasedAccess: true, watermarkRequired: true, accountStatus: 'active', plan: 'free' };
    } };
    throw new Error('unexpected require');
  }};
  vm.runInNewContext(apiSource, context);
  return { calls, async request(method = 'GET') {
    const res = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; } };
    await context.module.exports({method,query:{userId:'other'}},res);return res;
  }};
}
test('capability endpoint uses confirmed owner, exposes booleans only and disables caching', async () => {
  const h=apiHarness(), res=await h.request();
  assert.equal(res.statusCode,200);assert.equal(res.headers['Cache-Control'],'no-store');
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), {ok:true,seedance25:true,referenceAudio:false,storyboard25:false,watermarkRequired:true});
  assert.equal(h.calls[0][0],'db-mock');assert.equal(h.calls[0][1],'owner');
  assert.deepEqual(Array.from(h.calls[0][2].paidPlans),['premium','ultimate','team','scale']);
});
test('active Standard preserves watermark exemption without adding restricted model or extras access', async () => {
  const h=apiHarness({access:{ok:true,allowed:false,hasActiveSubscription:true,hasPurchasedAccess:false,watermarkRequired:false,accountStatus:'active',plan:'standard'}});
  const res=await h.request();assert.equal(res.body.seedance25,false);assert.equal(res.body.referenceAudio,false);assert.equal(res.body.storyboard25,false);assert.equal(res.body.watermarkRequired,false);
});
test('free-only account gets no restricted capabilities', async () => {
  const h=apiHarness({access:{ok:true,allowed:false,hasActiveSubscription:false,hasPurchasedAccess:false,watermarkRequired:true,accountStatus:'active'}});
  const res=await h.request();assert.equal(res.body.seedance25,false);assert.equal(res.body.referenceAudio,false);assert.equal(res.body.storyboard25,false);
});
test('authentication failures return before any capability lookup', async () => {
  for(const status of [401,403]) {
    const h=apiHarness({auth:{ok:false,status,body:{ok:false,error:'auth_failure'}}});
    assert.equal((await h.request()).statusCode,status);assert.equal(h.calls.length,0);
  }
});
test('method, restricted account and unreadable qualification fail closed', async () => {
  const method=apiHarness();assert.equal((await method.request('POST')).statusCode,405);assert.equal(method.calls.length,0);
  assert.equal((await apiHarness({access:{ok:true,accountStatus:'restricted'}}).request()).statusCode,403);
  assert.equal((await apiHarness({access:{ok:false}}).request()).statusCode,503);
  const failure=await apiHarness({throwLookup:true}).request();assert.equal(failure.statusCode,503);assert.doesNotMatch(JSON.stringify(failure.body),/private/);
});
function uiHarness(fetch) {
  const start=html.indexOf('async function loadGenerationPlan()');
  const end=html.indexOf('\n}',start)+2;
  const context={ fetch, getToken:async()=> 'test-session', syncSeedance25PlanUi(){}, seedance25Access:true,referenceAudioAccess:true,storyboard25Access:true,generationAccessLoaded:true,generationAccessRequest:0 };
  vm.runInNewContext(html.slice(start,end),context);
  return context;
}
test('UI obtains purchase qualification from authenticated no-store API', async () => {
  const calls=[];
  const c=uiHarness(async (...args)=>{calls.push(args);return {ok:true,json:async()=>({ok:true,seedance25:true,referenceAudio:false,storyboard25:false})};});
  assert.equal(await c.loadGenerationPlan(),true);
  assert.equal(c.seedance25Access,true);assert.equal(c.referenceAudioAccess,false);assert.equal(c.storyboard25Access,false);
  assert.equal(calls[0][0],'/api/credit-access');assert.equal(calls[0][1].headers.Authorization,'Bearer test-session');assert.equal(calls[0][1].cache,'no-store');
});
test('UI clears old qualification on network/API failure and missing login', async () => {
  for(const fetch of [async()=>{throw new Error('offline')},async()=>({ok:false,json:async()=>({ok:true,seedance25:true,referenceAudio:false,storyboard25:false})})]) {
    const c=uiHarness(fetch);assert.equal(await c.loadGenerationPlan(),false);assert.equal(c.seedance25Access,false);assert.equal(c.referenceAudioAccess,false);assert.equal(c.storyboard25Access,false);assert.equal(c.generationAccessLoaded,false);
  }
  const c=uiHarness(async()=>{throw new Error('must not fetch')});c.getToken=async()=>'';
  await c.loadGenerationPlan();assert.equal(c.seedance25Access,false);
});
test('stale UI response cannot overwrite newer denial', async () => {
  let complete;let count=0;
  const c=uiHarness(async()=> ++count===1 ? new Promise(resolve=>{complete=resolve}) : {ok:true,json:async()=>({ok:true,seedance25:false,referenceAudio:false,storyboard25:false})});
  const pending=c.loadGenerationPlan();await Promise.resolve();await c.loadGenerationPlan();
  complete({ok:true,json:async()=>({ok:true,seedance25:true,referenceAudio:false,storyboard25:false})});await pending;
  assert.equal(c.seedance25Access,false);assert.equal(c.referenceAudioAccess,false);assert.equal(c.storyboard25Access,false);
});
test('generation page parses and editing submit/modal remain the original subscription flow', () => {
  for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if(script[1].trim()) new vm.Script(script[1]);
  assert.doesNotMatch(html,/function getPlan\(|function isPaid\(|hasActiveSeedance25Plan\(/);
  const original = require('node:child_process').execFileSync('git',['show','HEAD:generate-prod.html'],{cwd:root,encoding:'utf8'});
  for (const prefix of ['function showVideoEditModal(', 'async function veSubmit(', 'async function veSend(']) {
    const extract = source => source.slice(source.indexOf(prefix), source.indexOf('\n', source.indexOf(prefix)));
    assert.equal(extract(html),extract(original));
  }
  assert.doesNotMatch(html,/videoEditAccess/);
  assert.match(html,/id="veWatermarkPending"/);
});

test('Standard plus purchase gains normal 2.5 only, without audio/storyboard or plan promotion', async () => {
  const access={ok:true,allowed:true,hasActiveSubscription:true,hasPurchasedAccess:true,watermarkRequired:false,accountStatus:'active',plan:'standard'};
  const h=apiHarness({access});const res=await h.request();
  assert.equal(res.body.seedance25,true);assert.equal(res.body.referenceAudio,false);assert.equal(res.body.storyboard25,false);
  assert.equal(res.body.watermarkRequired,false);assert.equal(access.plan,'standard');
  assert.equal('videoEdit' in res.body,false);
});
test('active high subscription keeps audio/storyboard, expired high subscription plus purchase does not', async () => {
  for(const active of [true,false]){
    const h=apiHarness({access:{ok:true,allowed:true,hasActiveSubscription:active,hasPurchasedAccess:true,watermarkRequired:!active,accountStatus:'active',plan:'premium'}});
    const res=await h.request();assert.equal(res.body.seedance25,true);
    assert.equal(res.body.referenceAudio,active);assert.equal(res.body.storyboard25,active);
  }
});
test('purchase UI can generate normal 2.5 but cannot attach audio or use a locked 2.5 storyboard', () => {
  const context={seedance25Access:true,referenceAudioAccess:false,storyboard25Access:false,sbLocked:false,mode:'text_to_video',$:id=>({value:id==='resolution'?'1080p':'bytedance/seedance-2.5'}),isSeedance25Model:()=>true};
  for(const prefix of ['function canUseReferenceAudio()', 'function canUseSelectedSeedance25()']){
    const a=html.indexOf(prefix);vm.runInNewContext(html.slice(a,html.indexOf('\n',a)),context);
  }
  assert.equal(context.canUseSelectedSeedance25(),true);assert.equal(context.canUseReferenceAudio(),false);
  context.sbLocked=true;assert.equal(context.canUseSelectedSeedance25(),false);
  context.referenceAudioAccess=true;context.storyboard25Access=true;
  assert.equal(context.canUseReferenceAudio(),true);assert.equal(context.canUseSelectedSeedance25(),true);
  assert.match(html,/isSeedance25Model\(\$\('sbModel'\)\?\.value\)&&!storyboard25Access/);
});
