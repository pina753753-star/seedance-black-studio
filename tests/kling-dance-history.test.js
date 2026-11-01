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

test('history lists existing 16-20 s motion videos with their own length and label, independent of any gate', async () => {
  const body = await history([{ ...task('long', { dance_method: 'kling_v3_motion_control', character_orientation: 'video' }), duration_seconds: 20 }]);
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].duration_seconds, 20);
  assert.equal(body.rows[0].dance_method, 'kling_v3_motion_control');
});

test('saved provider model is allowlisted only for a consistent WaveSpeed Kling tuple; model and private settings stay unchanged', async()=>{
 const settings={dance_method:'kling_v3_motion_control',provider_model:'kwaivgi/kling-v3.0-pro/motion-control',secret:'never expose'};
 const rows=[task('e4416b39',settings),task('a9175e08',settings),task('missing',{dance_method:settings.dance_method}),task('wrong',{...settings,provider_model:'unknown'}),{...task('wrong-provider',settings),api_provider:'openrouter'},task('wrong-method',{...settings,dance_method:'other'}),task('normal',{})];
 const body=await history(rows);
 for(const r of body.rows){assert.equal(r.model,'bytedance/seedance-2.5');assert.equal(r.provider_model,['e4416b39','a9175e08'].includes(r.id)?settings.provider_model:'');assert.equal('settings' in r,false);assert.equal(JSON.stringify(r).includes('never expose'),false);}
});

test('pending API exposes the same safe identity fields and no full settings',async()=>{
 const rows=[task('k',{dance_method:'kling_v3_motion_control',provider_model:'kwaivgi/kling-v3.0-pro/motion-control',secret:'never expose'}),task('normal',{}),task('unknown',{dance_method:'kling_v3_motion_control',provider_model:'unknown'})];
 const chain={select(){return this},update(){return this},eq(){return this},in(){return this},lt(){return this},gte(){return this},order(){return this},limit:async()=>({data:rows,error:null})};
 const client={from:()=>chain,auth:{getUser:async()=>({data:{user:{id:'u1'}}})}};
 const filename=path.resolve(__dirname,'../api/pending-tasks.js'),mod={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:mod,require:()=>({createClient:()=>client}),process:{env:{SUPABASE_SERVICE_ROLE_KEY:'mock'}},console},{filename});
 const res={status(c){this.code=c;return this},json(b){this.body=b;return this}};
 await mod.exports({method:'GET',headers:{authorization:'Bearer mock'}},res);
 assert.equal(res.code,200);assert.equal(res.body.tasks[0].provider_model,'kwaivgi/kling-v3.0-pro/motion-control');
 assert.equal(res.body.tasks[1].provider_model,'');assert.equal(res.body.tasks[2].provider_model,'');
 for(const r of res.body.tasks){assert.equal('settings' in r,false);assert.equal(r.model,'bytedance/seedance-2.5');assert.equal(JSON.stringify(r).includes('never expose'),false);}
});

test('shared display helper rejects conflicting identity and preserves every normal model label',()=>{
 const src=fs.readFileSync(path.resolve(__dirname,'../flowvid-history.js'),'utf8');
 const code=src.split('\n').filter(l=>l.includes('window.flowvidMotionModelLabel=')||l.includes('function modelLabel(')).join('\n');
 const ctx={window:{}};vm.runInNewContext(code,ctx);
 const pair={provider:'wavespeed',dance_method:'kling_v3_motion_control',provider_model:'kwaivgi/kling-v3.0-pro/motion-control'};
 assert.equal(ctx.modelLabel('bytedance/seedance-2.5','wavespeed',pair),'Kling v3 Pro Motion Control');
 for(const row of [{...pair,provider_model:undefined},{...pair,dance_method:'other'},{...pair,api_provider:'openrouter'}])assert.equal(ctx.window.flowvidMotionModelLabel(row),'');
 for(const [model,provider,label] of [['bytedance/seedance-2.5','wavespeed','Seedance 2.5 Turbo'],['bytedance/seedance-2.5','openrouter','Seedance 2.5'],['bytedance/seedance-2.5','','Seedance 2.5（旧履歴）'],['bytedance/seedance-2.5-standard','wavespeed','Seedance 2.5'],['bytedance/seedance-2.0','openrouter','Seedance 2.0'],['bytedance/seedance-2.0-fast','openrouter','Seedance 2.0 Fast'],['bytedance/seedance-2.0-lite','openrouter','Seedance 2.0 Lite'],['unknown','unknown','unknown']])assert.equal(ctx.modelLabel(model,provider,{}),label);
});
