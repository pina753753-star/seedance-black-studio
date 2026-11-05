'use strict';
// Execute the real PL/pgSQL against an isolated, in-memory PostgreSQL engine.
// npm install --prefix /tmp/standard-access-testdeps @electric-sql/pglite
// NODE_PATH=/tmp/standard-access-testdeps/node_modules node --test tests/standard-monthly-debit-postgres.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch (_) { /* explicit skip below */ }
const sql = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';

test('Standard debit PostgreSQL integration (isolated fixture, no production access)', { skip: !PGlite && 'Install @electric-sql/pglite outside repo and set NODE_PATH (see file header)' }, async t => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table profiles (id uuid primary key, plan text, account_status text);
      create table credit_balances (user_id uuid primary key, subscription_credits integer, free_credits integer, purchased_credits integer, subscription_expires_at timestamptz, purchased_expires_at timestamptz, updated_at timestamptz);
      create table generation_tasks (id uuid primary key, user_id uuid, status text, credit_cost integer, api_provider text, api_task_id text, settings jsonb, updated_at timestamptz, error_message text);
      create table credit_transactions (user_id uuid, amount integer, credit_type text, reason text, related_task_id uuid);
      create unique index refunds on credit_transactions(related_task_id,reason,credit_type) where reason='generation_refund';
      create table stripe_payment_ledger (id text primary key, user_id uuid, purchase_type text, grant_status text, charge_id text, payment_intent_id text);
      create table payment_risk_events (user_id uuid, status text, charge_id text, payment_intent_id text);
    `);
    await db.exec(sql('docs/sql/basic-credit-access-atomic.sql'));
    await db.exec(sql('docs/sql/standard-monthly-access-atomic.sql'));
    await db.exec(sql('supabase/migrations/20260821000000_allow_wavespeed_atomic_refund.sql'));
    async function reset({ sub = 100, free = 20, purchased = 200, grant = 'granted', risk = null, expiry = '2999-01-01', account = 'active' } = {}) {
      await db.exec('truncate profiles, credit_balances, generation_tasks, credit_transactions, stripe_payment_ledger, payment_risk_events');
      await db.query('insert into profiles values ($1, $2, $3)', [USER, 'standard', account]);
      await db.query('insert into credit_balances values ($1,$2,$3,$4,$5,$6,now())', [USER,sub,free,purchased,expiry,'2999-01-01']);
      await db.query("insert into generation_tasks values ($1,$2,'queued',100,null,null,$3,now(),null)", [TASK,USER,{standard_subscription_access:true,purchase_access_required:false}]);
      if (grant) await db.query("insert into stripe_payment_ledger values ('grant',$1,'credit_pack',$2,'charge','intent')",[USER,grant]);
      if (risk) await db.query("insert into payment_risk_events values ($1,$2,'charge','intent')",[USER,risk]);
    }
    async function debit(cost=100, user=USER) {
      await db.query('update generation_tasks set credit_cost=$1 where id=$2',[cost,TASK]);
      return (await db.query('select deduct_standard_generation_credits_atomic($1,$2,$3) as result',[TASK,user,cost])).rows[0].result;
    }
    const balance = async () => (await db.query('select subscription_credits,free_credits,purchased_credits from credit_balances')).rows[0];
    const ledger = async () => (await db.query('select amount,credit_type,reason from credit_transactions order by reason,credit_type')).rows;
    for (const grant of ['granted','held','reversed',null]) for (const risk of [null,'open','reviewing']) {
      await t.test(`monthly-only charge works with grant=${grant}, risk=${risk}; purchase untouched and refund exact`, async () => {
        await reset({grant,risk});
        const result=await debit(); assert.equal(result.code,'deducted'); assert.equal(result.from_subscription,100); assert.equal(result.from_purchased,0);
        assert.deepEqual(await balance(),{subscription_credits:0,free_credits:20,purchased_credits:200});
        assert.equal((await debit()).code,'already_deducted'); assert.equal((await ledger()).length,1);
        const refund=async()=> (await db.query('select refund_generation_task_atomic($1) as result',[TASK])).rows[0].result;
        assert.equal((await refund()).code,'refunded'); assert.equal((await refund()).code,'already_refunded');
        assert.deepEqual(await balance(),{subscription_credits:100,free_credits:20,purchased_credits:200});
        assert.deepEqual((await ledger()).map(x=>x.amount).sort((a,b)=>a-b),[-100,100]);
      });
    }
    await t.test('clean spillover debits subscription, free, purchased and restores each pool exactly',async()=>{
      await reset({sub:40,free:20});const result=await debit();
      assert.equal(result.from_subscription,40);assert.equal(result.from_free,20);assert.equal(result.from_purchased,40);
      await db.query('select refund_generation_task_atomic($1)',[TASK]);
      assert.deepEqual(await balance(),{subscription_credits:40,free_credits:20,purchased_credits:200});
      assert.equal((await ledger()).length,6);
    });
    for (const opts of [{grant:'held'},{grant:'reversed'},{risk:'open'},{risk:'reviewing'},{grant:null}]) {
      await t.test(`risky/unproven spillover denied atomically ${JSON.stringify(opts)}`,async()=>{
        await reset({sub:40,free:20,...opts});const before=await balance();
        assert.equal((await debit()).ok,false);assert.deepEqual(await balance(),before);assert.deepEqual(await ledger(),[]);
      });
    }
    await t.test('risk linked by charge with no user id blocks spillover',async()=>{
      await reset({sub:40});await db.exec("insert into payment_risk_events values(null,'open','charge',null)");
      assert.equal((await debit()).code,'payment_risk_hold');assert.deepEqual(await ledger(),[]);
    });
    for (const account of ['risk_hold','frozen']) await t.test(`${account} subscription cannot spend even with sufficient monthly credits`,async()=>{
      await reset({account});assert.equal((await debit()).code,'account_restricted');assert.deepEqual(await ledger(),[]);
    });
    await t.test('expiry between capability read and debit fails closed',async()=>{
      await reset({expiry:'2000-01-01'});assert.equal((await debit()).code,'subscription_access_revoked');assert.deepEqual(await ledger(),[]);
    });
    await t.test('other owner and terminal task cannot debit',async()=>{
      await reset();assert.equal((await debit(100,OTHER)).code,'task_owner_mismatch');
      await db.exec("update generation_tasks set status='completed'");assert.equal((await debit()).code,'task_not_chargeable');assert.deepEqual(await ledger(),[]);
    });
    await t.test('missing server policy cannot debit',async()=>{
      await reset();await db.exec("update generation_tasks set settings='{}'");assert.equal((await debit()).code,'subscription_access_required');assert.deepEqual(await ledger(),[]);
    });
    await t.test('expired purchased pool cannot fund spillover; funds are not confiscated',async()=>{
      await reset({sub:40});await db.exec("update credit_balances set purchased_expires_at='2000-01-01'");
      assert.equal((await debit()).code,'purchase_access_revoked');assert.equal((await balance()).purchased_credits,200);assert.deepEqual(await ledger(),[]);
    });
    await t.test('wrong provider and cost mismatch cannot change balances or ledger',async()=>{
      await reset();const before=await balance();
      await db.exec("update generation_tasks set api_provider='wavespeed'");
      assert.equal((await debit()).code,'wrong_provider');
      await db.exec("update generation_tasks set api_provider=null");
      await assert.rejects(db.query('select deduct_standard_generation_credits_atomic($1,$2,50)',[TASK,USER]),/credit_cost_mismatch/);
      assert.deepEqual(await balance(),before);assert.deepEqual(await ledger(),[]);
    });
    await t.test('replay after risk/status changes returns original charge without a second debit',async()=>{
      await reset();assert.equal((await debit()).code,'deducted');
      await db.exec("update stripe_payment_ledger set grant_status='reversed'; update profiles set account_status='risk_hold'");
      const before=await balance();assert.equal((await debit()).code,'already_deducted');
      assert.deepEqual(await balance(),before);assert.equal((await ledger()).length,1);
      await db.query('select refund_generation_task_atomic($1)',[TASK]);
      assert.deepEqual(await balance(),{subscription_credits:100,free_credits:20,purchased_credits:200});
    });
    await t.test('normalized Standard plan and exhausted pools keep their expected boundaries',async()=>{
      await reset();await db.exec("update profiles set plan=' STANDARD '");assert.equal((await debit()).ok,true);
      await reset({sub:0,free:0,purchased:0,grant:null});assert.equal((await debit()).ok,false);assert.deepEqual(await ledger(),[]);
    });
    await t.test('execution grants exclude public clients',async()=>{
      for(const role of ['anon','authenticated']) assert.equal((await db.query("select has_function_privilege($1,'deduct_standard_generation_credits_atomic(uuid,uuid,integer)','EXECUTE') as allowed",[role])).rows[0].allowed,false);
    });
  } finally { await db.close(); }
});
