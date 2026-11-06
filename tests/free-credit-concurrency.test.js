'use strict';
// OPT-IN: disposable local PostgreSQL only, Unix socket, no network/production URL.
// NODE_PATH=/tmp/standard-access-testdeps/node_modules FREE_LOCAL_PG_TEST=1 \
//   node --test tests/standard-monthly-concurrency.test.js
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
let Client;try{({Client}=require('pg'));}catch{}
const enabled=process.env.FREE_LOCAL_PG_TEST==='1';
const SOCKET='/tmp/free-credit-pg-socket';
const USER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const TASK='33333333-3333-4333-8333-333333333333',TASK2='44444444-4444-4444-8444-444444444444';
const root=path.join(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const sqlFiles=[
 'supabase/migrations/20260624000000_initial_flowvid_schema.sql',
 'supabase/migrations/20260714000000_restrict_profile_self_update.sql',
 'supabase/migrations/20260714010000_remove_generation_tasks_user_update_policy.sql',
 'supabase/migrations/20260714010200_remove_generation_tasks_user_insert_policy.sql',
 'supabase/migrations/20260830000000_add_chargeback_fraud_schema.sql',
 'docs/sql/basic-credit-access-atomic.sql',
 'docs/sql/free-credit-access-atomic.sql',
 'supabase/migrations/20260821000000_allow_wavespeed_atomic_refund.sql',
 'supabase/migrations/20260908070000_fix_payment_risk_ledger_lock_order.sql'
];
test('real PostgreSQL concurrency and effective privilege/RLS boundaries', {skip:!enabled?'opt-in disposable local PostgreSQL test':!Client?'Install pg outside repo and set NODE_PATH':false,timeout:120000},async t=>{
 const clients=[];
 async function connect(user='postgres'){
  const c=new Client({host:SOCKET,port:5432,user,database:'postgres',application_name:'free-local-review',connectionTimeoutMillis:5000});
  await c.connect();clients.push(c);await c.query("set statement_timeout='10s';set lock_timeout='8s'");return c;
 }
 const owner=await connect();
 try{
  // This test is deliberately for a newly initialized, disposable cluster.
  assert.equal((await owner.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n,0,'refuse a nonempty cluster');
  await owner.query(read('tests/fixtures/standard-monthly-postgres-bootstrap.sql'));
  for(const f of sqlFiles){
   if(f==='docs/sql/basic-credit-access-atomic.sql'){
    // Columns normally installed by broader feature migrations. No RPC logic is
    // rewritten. Fixture scope intentionally excludes unrelated app schemas.
    await owner.query(`alter table credit_balances add column subscription_expires_at timestamptz,add column purchased_expires_at timestamptz;
      alter table generation_tasks add column settings jsonb default '{}';
      alter table payment_risk_events add column payment_intent_id text;
      create unique index credit_transactions_generation_refund_unique on credit_transactions(related_task_id,reason,credit_type) where reason='generation_refund';`);
   }
   await owner.query(read(f));
  }
  // The latest refund migration assumes prior service-only grants. Reproduce
  // the original migration's grants after loading the exact current body.
  await owner.query(`revoke all on function refund_generation_task_atomic(uuid,text) from public,anon,authenticated;
    grant execute on function refund_generation_task_atomic(uuid,text) to service_role;
    grant select,insert,update,delete on all tables in schema public to service_without_bypass;
    grant execute on function deduct_free_generation_credits_atomic(uuid,uuid,integer) to service_without_bypass;`);
  const a=await connect('service_role'),b=await connect('service_role'),auth=await connect('authenticated'),anon=await connect('anon'),noBypass=await connect('service_without_bypass');
  const pid=async c=>(await c.query('select pg_backend_pid() pid')).rows[0].pid;
  const aid=await pid(a),bid=await pid(b);
  console.log('SERVER',JSON.stringify((await owner.query('select version() version,current_setting(\'transaction_isolation\') isolation')).rows[0]));
  console.log('ROLES',JSON.stringify((await owner.query("select rolname,rolsuper,rolbypassrls,rolinherit from pg_roles where rolname in ('postgres','service_role','anon','authenticated','service_without_bypass') order by rolname")).rows));
  console.log('FUNCTIONS',JSON.stringify((await owner.query("select proname,prosecdef,proconfig,pg_get_userbyid(proowner) owner,proacl from pg_proc where proname in ('deduct_free_generation_credits_atomic','deduct_generation_credits_atomic','check_purchase_credit_access_locked','refund_generation_task_atomic','record_payment_risk_event_atomic') order by proname")).rows));
  console.log('RLS',JSON.stringify((await owner.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('profiles','credit_balances','credit_transactions','generation_tasks','stripe_payment_ledger','payment_risk_events') order by relname")).rows));
  async function reset({sub=100,free=20,purchased=200,grant='granted',cost=100}={}){
   await owner.query('truncate auth.users cascade');
   await owner.query('truncate payment_risk_events,stripe_payment_ledger');
   await owner.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'one@local.invalid','{}'),($2,'two@local.invalid','{}')",[USER,OTHER]);
   await owner.query("update profiles set plan='free',account_status='active'");
   await owner.query("update credit_balances set subscription_credits=$1,free_credits=$2,purchased_credits=$3,subscription_expires_at='2999-01-01',purchased_expires_at='2999-01-01' where user_id=$4",[sub,free,purchased,USER]);
   await owner.query("insert into generation_tasks(id,user_id,mode,prompt,credit_cost,status,settings) values($1,$2,'text_to_video','fixture',$3,'queued',$4),($5,$2,'text_to_video','fixture',$3,'queued',$4)",[TASK,USER,cost,{free_credit_access:true,purchase_access_required:false},TASK2]);
   await owner.query("insert into stripe_payment_ledger(user_id,purchase_type,grant_status,charge_id,payment_intent_id) values($1,'credit_pack',$2,'ch_local','pi_local'),($3,'credit_pack','granted','ch_other','pi_other')",[USER,grant,OTHER]);
  }
  const debit=async(c,task=TASK,cost=100)=>(await c.query('select deduct_free_generation_credits_atomic($1,$2,$3) r',[task,USER,cost])).rows[0].r;
  const refund=async(c,task=TASK)=>(await c.query('select refund_generation_task_atomic($1) r',[task])).rows[0].r;
  const risk=async c=>(await c.query("select record_payment_risk_event_atomic('evt_local','charge.dispute.created','dp_local','dispute','ch_local','pi_local','fixture') r")).rows[0].r;
  const balance=async()=>(await owner.query('select subscription_credits,free_credits,purchased_credits from credit_balances where user_id=$1',[USER])).rows[0];
  async function conserved(initial){
   const bal=await balance();const tx=(await owner.query("select credit_type,sum(amount)::int total from credit_transactions where user_id=$1 group by credit_type",[USER])).rows;
   for(const [pool,n]of Object.entries(initial))assert.equal(bal[pool+'_credits'],n+(tx.find(x=>x.credit_type===pool)?.total||0),pool+' conservation');
   assert.ok(Object.values(bal).every(n=>n>=0));
  }
  async function blocked(waiter,blocker){
   const end=Date.now()+4000;
   do{
    const r=(await owner.query('select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1',[waiter])).rows[0];
    if(r?.wait_event_type==='Lock'&&r.blockers.includes(blocker)){console.log('OBSERVED_LOCK',JSON.stringify({waiter,blocker,...r}));return;}
    await new Promise(r=>setTimeout(r,20));
   }while(Date.now()<end);assert.fail('expected real lock wait was not observed');
  }
  async function pending(fn){let result;const done=fn().then(x=>result={value:x},e=>result={error:e});return {done,get result(){return result}};}
  async function finish(p){await p.done;if(p.result.error)throw p.result.error;return p.result.value;}
  await t.test('service role uses monthly/free pools when held purchase exists',async()=>{
   await reset({sub:80,free:20,grant:'held'});const d=await debit(a);assert.equal(d.ok,true);assert.equal(d.from_subscription,80);assert.equal(d.from_free,20);assert.equal(d.from_purchased,0);
   assert.equal((await balance()).purchased_credits,200);await conserved({subscription:80,free:20,purchased:200});
  });
  await t.test('risk first: spillover debit waits for risk transaction then is denied without charges',async()=>{
   await reset({sub:40});await a.query('begin');assert.equal((await risk(a)).code,'recorded');
   const p=await pending(()=>debit(b));await blocked(bid,aid);await a.query('commit');assert.equal((await finish(p)).code,'payment_risk_hold');
   assert.equal((await owner.query('select count(*)::int n from credit_transactions')).rows[0].n,0);await conserved({subscription:40,free:20,purchased:200});
  });
  await t.test('risk first: sufficient subscription/free debit waits then succeeds without spending held funds',async()=>{
   await reset({sub:80});await a.query('begin');await risk(a);const p=await pending(()=>debit(b));await blocked(bid,aid);await a.query('commit');
   assert.equal((await finish(p)).from_purchased,0);await conserved({subscription:80,free:20,purchased:200});
  });
  await t.test('debit first: risk arrival waits; committed clean spillover is charged once then new spending is held',async()=>{
   await reset({sub:40});await a.query('begin');const d=await debit(a);assert.equal(d.from_purchased,40);
   const p=await pending(()=>risk(b));await blocked(bid,aid);await a.query('commit');assert.equal((await finish(p)).held,1);
   assert.equal((await debit(b,TASK2)).code,'free_access_revoked');await conserved({subscription:40,free:20,purchased:200});
  });
  await t.test('same task concurrent debits serialize and return already_deducted, never double charge',async()=>{
   await reset();await a.query('begin');await debit(a);const p=await pending(()=>debit(b));await blocked(bid,aid);await a.query('commit');assert.equal((await finish(p)).code,'already_deducted');
   assert.equal((await owner.query('select count(*)::int n from credit_transactions')).rows[0].n,1);await conserved({subscription:100,free:20,purchased:200});
  });
  await t.test('different tasks compete for held-purchase user monthly pools without overdraft',async()=>{
   await reset({grant:'held'});await a.query('begin');await debit(a);const p=await pending(()=>debit(b,TASK2));await blocked(bid,aid);await a.query('commit');assert.equal((await finish(p)).code,'payment_risk_hold');
   await conserved({subscription:100,free:20,purchased:200});assert.equal((await balance()).purchased_credits,200);
  });
  await t.test('two tasks racing on free-only funds cannot spend held purchase after exhaustion',async()=>{
   await reset({sub:0,free:100,grant:'held'});await a.query('begin');await debit(a);
   const p=await pending(()=>debit(b,TASK2));await blocked(bid,aid);await a.query('commit');
   assert.equal((await finish(p)).code,'free_access_revoked');await conserved({subscription:0,free:100,purchased:200});
  });
  await t.test('debit then concurrent refund waits and restores every mixed pool',async()=>{
   await reset({sub:40});await a.query('begin');await debit(a);const p=await pending(()=>refund(b));await blocked(bid,aid);await a.query('commit');assert.equal((await finish(p)).code,'refunded');
   assert.deepEqual(await balance(),{subscription_credits:40,free_credits:20,purchased_credits:200});await conserved({subscription:40,free:20,purchased:200});
  });
  await t.test('refund first blocks debit replay, which sees failed task and cannot charge again',async()=>{
   await reset({sub:40});await debit(a);await a.query('begin');await refund(a);const p=await pending(()=>debit(b));await blocked(bid,aid);await a.query('commit');assert.equal((await finish(p)).code,'task_not_chargeable');
   assert.deepEqual(await balance(),{subscription_credits:40,free_credits:20,purchased_credits:200});await conserved({subscription:40,free:20,purchased:200});
  });
  await t.test('two concurrent refunds return refunded/already_refunded and conserve balance',async()=>{
   await reset({sub:40});await debit(a);await a.query('begin');await refund(a);const p=await pending(()=>refund(b));await blocked(bid,aid);await a.query('commit');assert.equal((await finish(p)).code,'already_refunded');await conserved({subscription:40,free:20,purchased:200});
   assert.equal((await owner.query("select count(*)::int n from credit_transactions where reason='generation_refund'")).rows[0].n,3);
  });
  await t.test('fresh account restriction is enforced; profile-only updates are NOT row-locked by wrapper',async()=>{
   await reset();await a.query('begin');await debit(a);
   await b.query("update profiles set account_status='risk_hold' where id=$1",[USER]);
   assert.equal((await owner.query('select pg_blocking_pids($1) p',[bid])).rows[0].p.length,0);
   await a.query('commit');assert.equal((await debit(b,TASK2)).code,'account_restricted');await conserved({subscription:100,free:20,purchased:200});
   console.log('PROFILE_LIMITATION: no profile row lock; a concurrent profile-only update can commit while debit transaction remains open');
  });
  await t.test('anon/authenticated cannot execute wrapper/helper/debit/refund/risk RPCs',async()=>{
   await reset();
   const calls=[()=>debit(auth),()=>debit(anon),()=>refund(auth),()=>refund(anon),()=>risk(auth),()=>risk(anon),()=>auth.query('select check_purchase_credit_access_locked($1)',[USER]),()=>anon.query('select check_purchase_credit_access_locked($1)',[USER]),()=>auth.query('select deduct_generation_credits_atomic($1,$2,100)',[TASK,USER]),()=>anon.query('select deduct_generation_credits_atomic($1,$2,100)',[TASK,USER])];
   for(const fn of calls)await assert.rejects(fn,e=>e.code==='42501');
   await conserved({subscription:100,free:20,purchased:200});
  });
  await t.test('authenticated sees own rows only; cannot forge policy/cost or mutate credits/risk/profile plan',async()=>{
   await reset();await auth.query("select set_config('request.jwt.claim.sub',$1,false)",[USER]);
   for(const table of ['profiles','credit_balances','stripe_payment_ledger'])assert.equal((await auth.query('select * from '+table)).rowCount,1,table);
   assert.equal((await auth.query('select * from generation_tasks')).rowCount,2);
   assert.equal((await auth.query("update generation_tasks set settings='{}',credit_cost=0 returning id")).rowCount,0);
   assert.equal((await auth.query('update credit_balances set purchased_credits=999999 returning user_id')).rowCount,0);
   await assert.rejects(auth.query("insert into generation_tasks(user_id,mode,prompt) values($1,'text_to_video','forged')",[USER]),e=>e.code==='42501');
   await assert.rejects(auth.query('insert into credit_transactions(user_id,amount,credit_type,reason) values($1,100,\'purchased\',\'forged\')',[USER]),e=>e.code==='42501');
   for(const query of ['select * from payment_risk_events',"update stripe_payment_ledger set grant_status='granted'", "update profiles set plan='premium'"])await assert.rejects(auth.query(query),e=>e.code==='42501');
   assert.equal((await auth.query("update profiles set display_name='permitted' where id=$1 returning id",[USER])).rowCount,1);
   assert.equal((await anon.query('select * from credit_balances')).rowCount,0);
   await assert.rejects(anon.query('select * from stripe_payment_ledger'),e=>e.code==='42501');
   await assert.rejects(anon.query('select * from payment_risk_events'),e=>e.code==='42501');
   await conserved({subscription:100,free:20,purchased:200});
  });
  await t.test('SECURITY INVOKER requires table grants and RLS bypass despite EXECUTE permission',async()=>{
   await reset();assert.equal((await debit(noBypass)).code,'task_not_found');
   await owner.query('revoke select on payment_risk_events from service_role');
   try{await assert.rejects(debit(a),e=>e.code==='42501');}finally{await owner.query('grant select on payment_risk_events to service_role');}
   assert.equal((await owner.query('select count(*)::int n from credit_transactions')).rows[0].n,0);
   assert.equal((await debit(a)).ok,true);await conserved({subscription:100,free:20,purchased:200});
  });
 }finally{
  for(const c of clients){try{await c.query('rollback');}catch{}await c.end();}
 }
});
