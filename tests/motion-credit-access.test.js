'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAID_PLANS, MODEL_PLANS, activeSubscription, effectiveBalance,
  readSubscriptionAccess, getCreditAccess, taskRequiresWatermark
} = require('../api/_lib/credit-access');

const NOW = Date.now();
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2026-09-25T12:00:00Z';
const OWNER = 'owner';
function fixture({ plan = 'free', accountStatus = 'active', balance = {}, grants = [{ id: 'grant-1', user_id: OWNER, purchase_type: 'credit_pack', grant_status: 'granted' }], risks = [], errors = {}, throws = [] } = {}) {
  const queries = [];
  const rows = {
    profiles: [{ id: OWNER, plan, account_status: accountStatus }],
    credit_balances: [{ user_id: OWNER, free_credits: 0, subscription_credits: 0, purchased_credits: 1000, subscription_expires_at: null, purchased_expires_at: FUTURE, ...balance }],
    stripe_payment_ledger: grants,
    payment_risk_events: risks
  };
  const db = { from(table) {
    if (!Object.hasOwn(rows, table)) throw new Error(`Unexpected table ${table}`);
    const query = { table, filters: [], fields: '', limit: null };
    queries.push(query);
    const chain = {
      select(fields) { query.fields = fields; return chain; },
      eq(field, value) { query.filters.push(row => row[field] === value); return chain; },
      in(field, values) { query.filters.push(row => values.includes(row[field])); return chain; },
      limit(value) { query.limit = value; return chain; },
      async maybeSingle() {
        if (throws.includes(table)) throw new Error('mock query failed');
        if (errors[table]) return { data: null, error: new Error('mock query failed') };
        const matches = rows[table].filter(row => query.filters.every(filter => filter(row)));
        const limited = query.limit === null ? matches : matches.slice(0, query.limit);
        if (limited.length > 1) throw new Error('mock maybeSingle cardinality');
        return { data: limited[0] || null, error: null };
      }
    };
    return chain;
  }};
  return { db, queries, rows, access: (options = {}) => getCreditAccess(db, OWNER, { now: NOW, ...options }) };
}


const { authorizeReferenceMotion } = require('../api/_lib/reference-dance');
const accessFor = async (options = {}) => { const f = fixture(options); return authorizeReferenceMotion({ user: { id: OWNER }, supabase: f.db }); };
test('motion permits settled unexpired purchased credits without subscription and requires watermark', async () => {
 const a = await accessFor(); assert.equal(a.ok, true); assert.equal(a.plan, 'free'); assert.equal(a.watermarkRequired, true);
 assert.equal(a.hasPurchasedAccess, true);
});
for (const plan of ['premium','ultimate','team','scale']) test(`motion preserves active ${plan} subscription without purchase`, async () => {
 const a = await accessFor({plan, balance:{subscription_expires_at:FUTURE,purchased_credits:0}});
 assert.equal(a.ok,true); assert.equal(a.watermarkRequired,false);
});
test('Standard needs purchase; its active subscription still exempts watermark', async () => {
 assert.equal((await accessFor({plan:'standard',balance:{subscription_expires_at:FUTURE,purchased_credits:0}})).ok,false);
 const a = await accessFor({plan:'standard',balance:{subscription_expires_at:FUTURE}}); assert.equal(a.ok,true);assert.equal(a.watermarkRequired,false);
});
for (const [label, opts] of [
 ['expired',{balance:{purchased_expires_at:PAST}}],['empty',{balance:{purchased_credits:0,free_credits:1000}}],
 ['no grant',{grants:[]}],['held',{grants:[{id:'g',user_id:OWNER,purchase_type:'credit_pack',grant_status:'granted'},{id:'h',user_id:OWNER,grant_status:'held'}]}],
 ['risk',{risks:[{id:'r',user_id:OWNER,status:'open'}]}],['restricted',{accountStatus:'suspended'}],['lookup failure',{errors:{credit_balances:true}}]
]) test(`motion denies ${label}`, async()=>{assert.equal((await accessFor(opts)).ok,false)});
test('management reads/deletes remain possible after entitlement expires; no generation entitlement is granted',async()=>{
 const f=fixture({balance:{purchased_credits:0}}); const auth={user:{id:OWNER},supabase:f.db};
 assert.equal((await authorizeReferenceMotion(auth)).ok,false);
 assert.equal((await authorizeReferenceMotion(auth,{existingOnly:true})).ok,true);
 assert.equal((await authorizeReferenceMotion({},{existingOnly:true})).ok,false);
});
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
for(const route of ['access','upload-url','confirm-upload','latest','delete']){
 test(`motion ${route}: unauthenticated cannot reach DB or moderation`,async()=>{
  const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/reference-dance-'+route+'.js'),'utf8'),{
   module,console,require(n){if(n.includes('confirmed-auth'))return{requireConfirmedAuth:async()=>({ok:false,status:401,body:{ok:false}})};if(n.includes('reference-dance'))return require('../api/_lib/reference-dance');if(n.includes('openai-moderation'))return{};if(n==='node:crypto')return require(n);throw Error(n);}
  }); const res={setHeader(){},status(n){this.code=n;return this},json(b){this.body=b;return this}};
  await module.exports({method:['access','latest'].includes(route)?'GET':'POST'},res);assert.equal(res.code,401);
 });
}
for(const route of ['access','upload-url','confirm-upload'])test(`motion ${route}: ineligible account stops before storage/inspection`,async()=>{
 const f=fixture({balance:{purchased_credits:0}}),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api/reference-dance-'+route+'.js'),'utf8'),{
 module,console,require(n){if(n.includes('confirmed-auth'))return{requireConfirmedAuth:async()=>({ok:true,user:{id:OWNER},supabase:f.db})};if(n.includes('reference-dance'))return require('../api/_lib/reference-dance');if(n.includes('openai-moderation'))return {moderateContent(){throw Error('must not moderate')}};if(n==='node:crypto')return require(n);throw Error(n);}
 });const res={setHeader(){},status(n){this.code=n;return this},json(b){this.body=b;return this}};
 await module.exports({method:route==='access'?'GET':'POST',body:{}},res);
 assert.equal(res.code,route==='access'?200:403);if(route==='access')assert.equal(res.body.allowed,false);
});
