'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const lib=require('../api/_lib/reference-dance');
async function read(profile,rows){
 const filters=[];let limit=1;
 const query={select(){return this},eq(k,v){filters.push(r=>r[k]===v);return this},in(k,vs){filters.push(r=>vs.includes(r[k]));return this},is(k,v){filters.push(r=>r[k]===v);return this},or(s){const max=Number(s.match(/lte\.(\d+)/)[1]);filters.push(r=>r.duration_ms===null||r.duration_ms<=max);return this},gt(k,v){filters.push(r=>r[k]>v);return this},order(){return this},limit(n){limit=n;return this},async maybeSingle(){return {data:rows.filter(r=>filters.every(f=>f(r))).slice(0,limit)[0]||null}}};
 const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/reference-dance-latest.js'),'utf8'),{module:m,Date,console,require(n){if(n.includes('confirmed-auth'))return {requireConfirmedAuth:async()=>({ok:true,user:{id:'owner'},supabase:{from:()=>query}})};if(n.includes('reference-dance'))return lib;throw Error(n)}});
 const res={setHeader(){},status(n){this.code=n;return this},json(b){this.body=b;return this}};await m.exports({method:'GET',query:profile===undefined?{}:{profile}},res);return res;
}
const row=(x={})=>({id:'stored',user_id:'owner',status:'ready',last_task_id:null,duration_ms:30000,billable_seconds:30,inspection_error:'MOTION_MASTER',expires_at:'2999-01-01T00:00:00Z',...x});
test('30s motion asset restores only in motion profile, with existing ownership and expiry gates',async()=>{
 const a=await read('motion',[row()]);assert.equal(a.code,200);assert.equal(a.body.asset.durationMs,30000);assert.equal(a.body.asset.billableSeconds,30);
 assert.equal((await read(undefined,[row()])).body.asset,null);
 for(const change of [{user_id:'other'},{expires_at:'2000-01-01T00:00:00Z'},{duration_ms:30001},{inspection_error:null},{status:'blocked'},{last_task_id:'used'}])assert.equal((await read('motion',[row(change)])).body.asset,null,JSON.stringify(change));
 assert.equal((await read('unknown',[row()])).code,400);
});
