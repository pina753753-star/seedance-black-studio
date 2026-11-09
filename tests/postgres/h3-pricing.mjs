// Isolated in-memory Postgres only; install PGlite outside the repository.
// node tests/postgres/h3-pricing.mjs /tmp/h3-sql-test/node_modules/@electric-sql/pglite/dist/index.js
const { PGlite } = await import(process.argv[2]);
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('../../', import.meta.url).pathname;
const db=new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key); create schema storage; create table storage.buckets(id text primary key,name text, public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
for (const file of ['supabase/setup-01-tables.sql']) await db.exec(fs.readFileSync(root+file,'utf8'));
await db.exec(`alter table credit_balances add column subscription_expires_at timestamptz, add column purchased_expires_at timestamptz;`);
for(const file of ['20260831090000_create_h3_live_slice.sql','20260905000000_fix_h3_live_image_upload_limit.sql','20260906000000_create_h3_director_slice.sql','20260911000000_h3_beta_pricing.sql','20260912000000_h3_max_reference_storyboard.sql']) {await db.exec(fs.readFileSync(root+'supabase/migrations/'+file,'utf8'));}
await db.exec(`update h3_live_controls set enabled=true;`);
const scalar=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
let counter=0;
async function job(price=null){
 const {id}=await scalar('select gen_random_uuid() id');
 await db.query('insert into auth.users values ($1)',[id]);
 await db.query("insert into profiles(id,email,plan) values ($1,'test@example.test','ultimate')",[id]);
 await db.query('insert into credit_balances(user_id,subscription_credits,free_credits,purchased_credits) values ($1,70,20,1000)',[id]);
 const j=await scalar("select * from reserve_h3_live_job_atomic($1,gen_random_uuid(),'test','text',null)",[id]);
 if(price!==null)await db.query('update h3_live_jobs set credit_cost=$1 where id=$2',[price,j.job_id]);
 return {id,jid:j.job_id};
}
async function debit(j,price){return (await scalar('select deduct_h3_live_credits_quoted_atomic($1,$2,$3) r',[j.jid,j.id,price])).r;}
async function refund(j){return (await scalar("select refund_h3_live_job_atomic($1,'test','test') r",[j.jid])).r;}
// Capture real pre-change reservations and charges, then apply the candidate.
const legacy = [];
for (const price of [60, 110, 130]) {
  for (const charged of [false, true]) {
    const old = await job(price);
    if (charged) assert.equal((await scalar('select deduct_h3_live_credits_atomic($1,$2) r', [old.jid,old.id])).r.deducted,price);
    legacy.push({old,price,charged});
  }
}
await db.exec(fs.readFileSync(root+'supabase/migrations/20261101013403_h3_text_cost_pricing.sql','utf8'));
for (const {old,price,charged} of legacy) {
  assert.equal((await scalar('select credit_cost from h3_live_jobs where id=$1',[old.jid])).credit_cost,price);
  const d=await debit(old,price);
  assert.equal(d.code, charged ? 'already_deducted' : 'deducted');
  assert.equal(d.deducted,price);
  assert.equal((await refund(old)).refunded_amount,price);
  assert.equal((await refund(old)).code,'already_refunded');
  assert.deepEqual(await scalar('select subscription_credits,free_credits,purchased_credits from credit_balances where user_id=$1',[old.id]),{subscription_credits:70,free_credits:20,purchased_credits:1000});
  counter++;
}
// New UI quote against a legacy 130-credit reservation stops before charging.
const stale = await job(130);
assert.equal((await debit(stale,120)).code,'price_changed');
assert.equal((await scalar('select count(*)::int n from credit_transactions where user_id=$1',[stale.id])).n,0);
counter++;
for(const price of [60,110,120,130]){
 const j=await job(price);const d=await debit(j,price);assert.equal(d.deducted,price); assert.equal((await debit(j,price)).code,'already_deducted');
 const r=await refund(j);assert.equal(r.refunded_amount,price);assert.equal((await refund(j)).code,'already_refunded');
 assert.deepEqual(await scalar('select subscription_credits,free_credits,purchased_credits from credit_balances where user_id=$1',[j.id]),{subscription_credits:70,free_credits:20,purchased_credits:1000});counter++;
}
for(const quote of [130,null,0]){const j=await job();assert.equal((await debit(j,quote)).code,'price_changed');assert.equal((await scalar('select count(*)::int n from credit_transactions where user_id=$1',[j.id])).n,0);assert.equal((await scalar('select status from h3_live_jobs where id=$1',[j.jid])).status,'failed');counter++;}
const j=await job();assert.equal((await scalar('select credit_cost from h3_live_jobs where id=$1',[j.jid])).credit_cost,120);await debit(j,120);assert.equal((await debit(j,130)).code,'price_changed');assert.equal((await scalar('select charged_at is not null as charged, refunded_at is null as unrefunded from h3_live_jobs where id=$1',[j.jid])).charged,true);assert.equal((await scalar('select refunded_at is null as unrefunded from h3_live_jobs where id=$1',[j.jid])).unrefunded,true);counter++;
assert.equal((await scalar('select h3_max_credit_cost() price')).price,130);
assert.equal((await scalar('select h3_max_live_credit_cost() price')).price,440);
for(const role of ['anon','authenticated'])assert.equal((await scalar("select has_function_privilege($1,'public.deduct_h3_live_credits_quoted_atomic(uuid,uuid,integer)','EXECUTE') ok",[role])).ok,false);
for (const mode of ['image', 'reference', 'storyboard']) {
  const j = await job();
  await db.query('delete from h3_live_jobs where id=$1', [j.jid]);
  let upload;
  if (mode === 'image') {
    upload = await scalar("insert into h3_live_image_uploads(user_id,object_path,content_type,byte_size,moderation_status,moderated_at,delete_after) values ($1::uuid,'uploads/'||($1::uuid)::text||'/frame','image/png',100,'passed',now(),now()+interval '1 day') returning id", [j.id]);
    j.jid = (await scalar("select * from reserve_h3_live_job_atomic($1,gen_random_uuid(),'test','image',$2)", [j.id,upload.id])).job_id;
  } else {
    upload = await scalar("insert into h3_max_reference_uploads(user_id,storage_path,mime_type,byte_size,slot,moderation_status,moderation_checked_at,delete_after) values ($1::uuid,'uploads/'||($1::uuid)::text||'/frame','image/png',100,1,'passed',now(),now()+interval '1 day') returning id", [j.id]);
    j.jid = (await scalar("select * from reserve_h3_reference_job_atomic($1,gen_random_uuid(),'test',$2,$3)", [j.id,mode,[upload.id]])).job_id;
  }
  assert.ok(j.jid);
  assert.equal((await debit(j,130)).deducted,130);
  assert.equal((await refund(j)).refunded_amount,130);
  counter++;
}
console.log(`PASS ${counter} accounting scenarios + unchanged reference/Director helpers + RPC privileges (PGlite disposable database)`);
await db.close();
