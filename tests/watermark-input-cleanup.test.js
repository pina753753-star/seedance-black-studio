'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RETENTION_MS, expiredTemporaryObject, sweepWatermarkInputs } = require('../api/_lib/watermark-input-cleanup');
const NOW = Date.parse('2026-10-25T12:00:00Z');
function item(age = RETENTION_MS + 1000, extra = {}) {
  return { id: randomUUID(), name: `${randomUUID()}.mp4`, created_at: new Date(NOW-age).toISOString(), updated_at: new Date(NOW-age).toISOString(), ...extra };
}
function storageFixture(entries = []) {
  const objects = new Map(entries.map(e => [e.bucket + '/' + e.prefix + '/' + e.row.name, e]));
  const calls = []; const cursors = new Map();
  const db = { storage: { from(bucket) { return {
    async download(name) { return cursors.has(bucket+'/'+name) ? { data: new Blob([cursors.get(bucket+'/'+name)]) } : { error: { statusCode: '404' } }; },
    async upload(name, body) { assert.match(name, /^watermark-cleanup-state\/(watermark-inputs)\.json$/); cursors.set(bucket+'/'+name,body); return { data: { path:name } }; },
    async list(prefix, options) {
      calls.push(['list', bucket, prefix, options]);
      const matching = [...objects.values()].filter(e => e.bucket === bucket && e.prefix === prefix).map(e => e.row).sort((a,b) => Date.parse(a.updated_at)-Date.parse(b.updated_at));
      return { data: matching.slice(options.offset, options.offset+options.limit), error: null };
    },
    async remove(paths) {
      calls.push(['remove', bucket, paths]);
      const deleted = [];
      for (const p of paths) if (objects.delete(bucket+'/'+p)) deleted.push({ name: p });
      return { data: deleted, error: null };
    }
  }; } } };
  return { db, objects, calls, cursors, add(bucket, prefix, row) { objects.set(bucket+'/'+prefix+'/'+row.name,{bucket,prefix,row}); } };
}
test('only stale UUID temporary files are eligible; no directories, traversal, malformed ages', () => {
  const cutoff = NOW-RETENTION_MS;
  assert.equal(expiredTemporaryObject(item(),cutoff),true);
  for (const row of [item(0),item(RETENTION_MS),item(RETENTION_MS+1000,{updated_at:new Date(NOW).toISOString()}),item(undefined,{id:null}),item(undefined,{name:'../final.mp4'}),item(undefined,{name:'nested/'+randomUUID()+'.mp4'}),item(undefined,{name:'important.mp4'}),item(undefined,{created_at:'unknown'}),item(undefined,{updated_at:null})]) assert.equal(expiredTemporaryObject(row,cutoff),false);
});
test('sweep targets only Seedance temporary namespace, never final outputs, recordings or user uploads', async () => {
  const old=item();
  const h=storageFixture(['h3-watermark-input','watermark-inputs','watermarked','generated-videos','edited','edited-watermarked','recordings','uploads'].map(prefix=>({bucket:'reference-images',prefix,row:old})));
  const result=await sweepWatermarkInputs(h.db,{now:NOW});
  assert.equal(result.ok,true);assert.equal(result.deleted,1);assert.equal(h.objects.size,7);
  assert.deepEqual(h.calls.filter(c=>c[0]==='list').map(c=>c[2]),['watermark-inputs']);
});
test('late successful upload after timeout/finally is found by later independent sweep', async () => {
  const h=storageFixture(); const late=item(0); const prefix='watermark-inputs';
  // The original process attempts cleanup before storage commits, then dies.
  await h.db.storage.from('reference-images').remove([prefix+'/'+late.name]);
  h.add('reference-images',prefix,late); // delayed successful storage commit
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW})).deleted,0);
  assert.equal(h.objects.size,1);
  const recovered=await sweepWatermarkInputs(h.db,{now:NOW+RETENTION_MS+1});
  assert.equal(recovered.deleted,1);assert.equal(h.objects.size,0);
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW+RETENTION_MS+2})).deleted,0);
});
test('delayed overwrite refreshes updated_at and is not prematurely removed', async () => {
  const h=storageFixture([{bucket:'reference-images',prefix:'watermark-inputs',row:item(RETENTION_MS*2,{updated_at:new Date(NOW-1000).toISOString()})}]);
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW})).deleted,0);
});
test('pagination collects before deletion so shifted objects are not skipped', async () => {
  const h=storageFixture(Array.from({length:250},()=>({bucket:'reference-images',prefix:'watermark-inputs',row:item()})));
  const result=await sweepWatermarkInputs(h.db,{now:NOW});
  assert.equal(result.deleted,250);assert.equal(h.objects.size,0);
  const firstDelete=h.calls.findIndex(c=>c[0]==='remove');
  assert.ok(h.calls.slice(firstDelete).every(c=>c[0]==='remove'));
});
test('per-run cap drains backlog across subsequent runs', async () => {
  const h=storageFixture(Array.from({length:550},()=>({bucket:'reference-images',prefix:'watermark-inputs',row:item()})));
  const first=await sweepWatermarkInputs(h.db,{now:NOW});
  assert.equal(first.deleted,500);assert.equal(first.hasMore,true);
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW})).deleted,50);
});
test('list error cannot trigger deletion', async () => {
  const h=storageFixture([{bucket:'reference-images',prefix:'watermark-inputs',row:item()}]);
  const original=h.db.storage.from;
  h.db.storage.from=bucket=>{const api=original(bucket),list=api.list;api.list=(prefix,opts)=>prefix==='watermark-inputs'?Promise.resolve({error:new Error('private error')}):list(prefix,opts);return api;};
  const result=await sweepWatermarkInputs(h.db,{now:NOW});
  assert.equal(result.ok,false);assert.equal(result.failedTargets,1);assert.equal(result.deleted,0);
  assert.doesNotMatch(JSON.stringify(result),/private error/);
});
test('remove failure remains retryable and never claims deletion success', async () => {
  const h=storageFixture([{bucket:'reference-images',prefix:'watermark-inputs',row:item()}]);
  const original=h.db.storage.from;
  h.db.storage.from=bucket=>({...original(bucket),remove:async()=>({error:new Error('remove failed')})});
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW})).deleted,0);assert.equal(h.objects.size,1);
  h.db.storage.from=original;
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW})).deleted,1);
});
test('hanging SDK operations are bounded; no detached retry loops', async () => {
  let lists=0,removes=0;
  const db={storage:{from:()=>({download:async()=>({error:{statusCode:404}}),list:()=>{lists++;return new Promise(()=>{});},remove:()=>{removes++;}})}};
  const start=Date.now();const r=await sweepWatermarkInputs(db,{now:NOW,operationTimeoutMs:10,budgetMs:100});
  assert.equal(r.ok,false);assert.equal(lists,1);assert.equal(removes,0);assert.ok(Date.now()-start<500);
});
test('seedance custom bucket is server-configured; prefix stays fixed', async () => {
  const h=storageFixture([{bucket:'custom-video',prefix:'watermark-inputs',row:item()}]);
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW,videoBucket:'custom-video'})).deleted,1);
  const count=h.calls.length;
  assert.equal((await sweepWatermarkInputs(h.db,{now:NOW,videoBucket:'../other'})).ok,false);
  assert.equal(h.calls.length,count);
});
function loadCron({ fetchError = false, watermarkOk = true } = {}) {
  const calls=[];
  const query={select(){return this;},eq(){return this;},in(){return this;},lt(){return this;},order(){return this;},async limit(){calls.push('tasks');return {data:[],error:fetchError?{message:'mock failure'}:null};}};
  const sandbox={module:{exports:{}},console:{log(){},error(){}},process:{env:{SUPABASE_SERVICE_ROLE_KEY:'synthetic',CRON_SECRET:'synthetic-cron'}},require(name){
    if(name==='@supabase/supabase-js')return{createClient:()=>({from:()=>query})};
    if(name.includes('watermark-input-cleanup'))return{sweepWatermarkInputs:async()=>{calls.push('watermarks');return{ok:watermarkOk,deleted:0};}};
    throw Error(name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/openrouter-reconcile.js'),'utf8'),sandbox);
  return{calls,async run(auth='Bearer synthetic-cron',method='GET') {const res={status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await sandbox.module.exports({method,headers:{authorization:auth},query:{prefix:'watermarked',maxAge:'0'}},res);return res;}};
}
test('existing cron authentication/method guard protects cleanup; request cannot choose paths',async()=>{
  const h=loadCron();assert.equal((await h.run('wrong')).code,403);assert.equal((await h.run('Bearer synthetic-cron','POST')).code,405);assert.deepEqual(h.calls,[]);
  const result=await h.run();assert.equal(result.code,200);assert.equal(result.body.refunded,0);assert.ok(result.body.watermarkCleanup);assert.ok(h.calls.includes('watermarks'));
});
test('failed task lookup does not suppress temporary watermark recovery',async()=>{
  const h=loadCron({fetchError:true});assert.equal((await h.run()).code,500);assert.ok(h.calls.includes('watermarks'));
});
test('cleanup failure is observable without changing existing refund response',async()=>{
  const h=loadCron({watermarkOk:false});const r=await h.run();assert.equal(r.code,200);assert.equal(r.body.watermarkCleanup.ok,false);assert.equal(r.body.refunded,0);assert.ok(h.calls.includes('tasks'));
});
test('actual Storage SDK wrapped missing cursor is accepted, other failures stop deletion',async()=>{
  const { StorageClient } = require('@supabase/storage-js');
  for(const status of [404,401,500]) {
    let lists=0;
    const storage=new StorageClient('https://storage.invalid',{}, async(url)=>{
      if(String(url).includes('/object/list/')) {lists++;return new Response('[]',{status:200,headers:{'Content-Type':'application/json'}});}
      return new Response('mock error',{status});
    });
    const r=await sweepWatermarkInputs({storage},{now:NOW});
    assert.equal(r.ok,status===404);assert.equal(lists,status===404?1:0);assert.equal(r.deleted,0);
  }
});

test('persistent scan cursor passes 500 unknown files without deleting them', async () => {
  const entries=Array.from({length:500},(_,i)=>({bucket:'reference-images',prefix:'watermark-inputs',row:item(RETENTION_MS+5000,{name:'unknown-'+i})}));
  const target=item(); entries.push({bucket:'reference-images',prefix:'watermark-inputs',row:target});
  const h=storageFixture(entries);
  const first=await sweepWatermarkInputs(h.db,{now:NOW});
  assert.equal(first.deleted,0);assert.equal(first.hasMore,true);
  assert.equal(JSON.parse(h.cursors.get('reference-images/watermark-cleanup-state/watermark-inputs.json')).nextOffset,500);
  const second=await sweepWatermarkInputs(h.db,{now:NOW});
  assert.equal(second.deleted,1);assert.equal(h.objects.size,500);
  assert.equal(JSON.parse(h.cursors.get('reference-images/watermark-cleanup-state/watermark-inputs.json')).nextOffset,0);
});
test('invalid or unreadable cursor cannot broaden deletion targets', async () => {
  for (const body of ['not json',JSON.stringify({version:1,nextOffset:-1}),JSON.stringify({version:2,nextOffset:0}),'x'.repeat(257)]) {
    const h=storageFixture([{bucket:'reference-images',prefix:'watermark-inputs',row:item()}]);
    h.cursors.set('reference-images/watermark-cleanup-state/watermark-inputs.json',body);
    assert.equal((await sweepWatermarkInputs(h.db,{now:NOW})).ok,false);
    assert.equal(h.objects.size,1);
  }
});
test('cursor persistence failure is reported and leaves safe retry available',async()=>{
  const h=storageFixture(Array.from({length:500},(_,i)=>({bucket:'reference-images',prefix:'watermark-inputs',row:item(undefined,{name:'unknown-'+i})})));
  const original=h.db.storage.from;
  h.db.storage.from=bucket=>({...original(bucket),upload:async()=>({error:{message:'write failure'}})});
  const result=await sweepWatermarkInputs(h.db,{now:NOW});
  assert.equal(result.ok,false);assert.equal(result.deleted,0);assert.equal(h.objects.size,500);
});
