'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const lib = require('../api/_lib/reference-dance.js');
const USER = '11111111-1111-4111-8111-111111111111';
const ASSET = '22222222-2222-4222-8222-222222222222';
function harness({ authenticated = true, allowed = true, count = 0, signedFailure = false, insertFailure = false } = {}) {
  const writes = [], updates = [], paths = [];
  let authCalls = 0;
  const q = { select() { return q; }, eq() { return q; }, gte() { return q; },
    insert: async row => { writes.push(row); return { error: insertFailure ? new Error('DB insert failed') : null }; },
    update(row) { updates.push(row); return q; },
    then(resolve, reject) { return Promise.resolve({ count }).then(resolve, reject); }
  };
  const db = { from: () => q, storage: { from: () => ({ createSignedUploadUrl: async p => {
    paths.push(p); return signedFailure ? { error: new Error('sign failed') } : { data: { token: 'mock' } };
  } }) } };
  const module = { exports: {} };
  vm.runInNewContext(read('api/reference-dance-upload-url.js'), { module, Date, console: { error() {} }, require(name) {
    if (name === 'node:crypto') return { randomUUID: () => ASSET };
    if (name.includes('confirmed-auth')) return { requireConfirmedAuth: async () => authenticated ? { ok: true, user: { id: USER }, supabase: db } : { ok: false, status: 401, body: {} } };
    if (name.includes('reference-dance')) return { ...lib, authorizeReferenceMotion: async () => { authCalls++; return { ok: allowed }; } };
    throw new Error('unexpected import');
  } });
  return { writes, updates, paths, get authCalls() { return authCalls; }, async call(fields = {}, method = 'POST') {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await module.exports({ method, body: { filename: 'dance.mp4', contentType: 'video/mp4', byteSize: 1024, ...fields } }, res);
    return res;
  } };
}
for (const value of [undefined, false, null, 'true', 1, true]) {
  test(`upload accepts legacy rightsConfirmed=${String(value)} without inventing attestation`, async () => {
    const h = harness(), before = Date.now();
    const fields = value === undefined ? {} : { rightsConfirmed: value };
    const res = await h.call({ ...fields, rights_confirmed_at: '2000-01-01' });
    assert.equal(res.code, 200); assert.equal(h.writes.length, 1);
    const stamp = h.writes[0].rights_confirmed_at;
    if (value === true) assert.ok(Date.parse(stamp) >= before && Date.parse(stamp) <= Date.now());
    else assert.equal(stamp, null);
    assert.equal(h.writes[0].status, 'uploading');
    assert.equal(h.writes[0].user_id, USER);
    assert.deepEqual(h.paths, [lib.stagingPath(USER, ASSET)]);
  });
}
test('no checkbox does not bypass authentication, entitlement, limits or file admission', async () => {
  for (const [options, body, status] of [
    [{authenticated:false}, {}, 401], [{allowed:false}, {}, 403],
    [{count:lib.REFERENCE_DANCE_MAX_PER_HOUR}, {}, 429],
    [{}, {byteSize:0}, 413], [{}, {byteSize:50*1024*1024+1}, 413],
    [{}, {filename:'x.webm',contentType:'video/webm'}, 415]
  ]) {
    const h=harness(options); assert.equal((await h.call(body)).code,status);
    assert.equal(h.writes.length,0); assert.equal(h.paths.length,0);
  }
  const h=harness(); assert.equal((await h.call({},'GET')).code,405); assert.equal(h.authCalls,0);
});
test('storage and DB failures remain failures; retry does not fabricate confirmation', async () => {
  const h=harness({signedFailure:true});
  assert.equal((await h.call()).code,500);
  assert.equal(h.updates[0].status,'failed'); assert.equal(h.writes[0].rights_confirmed_at,null);
  const bad=harness({insertFailure:true}); assert.equal((await bad.call()).code,500); assert.equal(bad.paths.length,0);
  const retry=harness(); assert.equal((await retry.call()).code,200); assert.equal(retry.writes[0].rights_confirmed_at,null);
});
test('null and historical timestamps use identical ownership, inspection and expiry validation', () => {
  const row={id:ASSET,user_id:USER,status:'ready',approved_path:lib.approvedPath(USER,ASSET),size_bytes:1024,duration_ms:5000,billable_seconds:5,width:1280,height:720,video_codec:'h264',sha256:'a'.repeat(64),expires_at:new Date(Date.now()+3600000).toISOString()};
  for(const stamp of [null,'2026-01-01T00:00:00Z']) {
    const ready={...row,rights_confirmed_at:stamp}; assert.equal(lib.validateReadyReferenceDance(ready,USER).assetId,ASSET);
    assert.equal(ready.rights_confirmed_at,stamp);
    for(const bad of [{user_id:ASSET},{status:'blocked'},{approved_path:'approved/other/file.mp4'},{expires_at:'2000-01-01'},{video_codec:'hevc'},{sha256:null},{duration_ms:999999},{size_bytes:0}]) assert.throws(()=>lib.validateReadyReferenceDance({...ready,...bad},USER));
  }
});
test('both browser entry points omit fabricated assertions and preserve explicit trim choice',()=>{
  const html=read('generate-prod.html'), js=read('dance-kling.js');
  assert.doesNotMatch(html+js,/rightsConfirmed:true|reference_video_rights_confirmed|id="(?:kdRights|danceRights)"/);
  assert.match(html,/id="danceTrim"/); assert.match(html,/allowBoundaryTrim:\$\('danceTrim'\)\?\.checked===true/);
});
test('legacy restore and eligibility do not synthesize a checked checkbox', async()=>{
  const html=read('generate-prod.html');
  const ctx={LEGACY_REFERENCE_DANCE_ENABLED:true,referenceDanceAccess:true,referenceDanceAsset:null,generationRequestInFlight:false,
    SEEDANCE_25_TURBO_MODEL:'turbo',mode:'reference_to_video',sbLocked:false,
    $:id=>({model:{value:'turbo'},resolution:{value:'720p'}}[id] || null),
    getToken:async()=> 'mock',syncReferenceDanceUi(){},updateCreditUi(){},
    fetch:async()=>({ok:true,json:async()=>({asset:{id:ASSET,status:'ready',durationMs:5000,billableSeconds:5}})})};
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('function canUseReferenceDance(){'),html.indexOf('function syncReferenceDanceUi(){')),ctx);
  vm.runInContext(html.slice(html.indexOf('async function restoreLatestReferenceDance(){'),html.indexOf('async function loadReferenceDanceAccess(){')),ctx);
  assert.equal(ctx.canUseReferenceDance(),true);
  await ctx.restoreLatestReferenceDance();assert.equal(ctx.referenceDanceAsset.id,ASSET);assert.equal(ctx.referenceDanceAsset.status,'ready');
  ctx.LEGACY_REFERENCE_DANCE_ENABLED=false;assert.equal(ctx.canUseReferenceDance(),false);
});
let PGlite; try { ({PGlite}=require('@electric-sql/pglite')); } catch {}
test('SQL draft permits NULL without rewriting history or changing private table privileges', {skip:!PGlite && 'PGlite required for isolated SQL validation'}, async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema storage; create schema auth;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table auth.users(id uuid primary key); create table generation_tasks(id uuid primary key);
      insert into auth.users values ('${USER}');`);
    await db.exec(read('supabase/migrations/20261010000000_create_seedance_reference_video_beta.sql'));
    await db.exec(read('supabase/migrations/20261101065130_allow_motion_reference_video_30s.sql'));
    const insert=`insert into seedance_reference_video_uploads(id,user_id,staging_path,rights_confirmed_at,expires_at) values ($1,$2,$3,$4,now()+interval '1 hour')`;
    await assert.rejects(db.query(insert,[ASSET,USER,lib.stagingPath(USER,ASSET),null]), /null value/);
    await db.query(insert,[ASSET,USER,lib.stagingPath(USER,ASSET),'2026-01-01T00:00:00Z']);
    await db.exec(read('docs/sql/reference-video-rights-nullable.sql'));
    const next='33333333-3333-4333-8333-333333333333';
    await db.query(insert,[next,USER,lib.stagingPath(USER,next),null]);
    // New 30-second data and an old-client timestamp both survive the expanded schema.
    await db.query("update seedance_reference_video_uploads set duration_ms=30000,billable_seconds=30 where id=$1",[next]);
    await db.query(insert,['55555555-5555-4555-8555-555555555555',USER,lib.stagingPath(USER,'55555555-5555-4555-8555-555555555555'),'2026-01-02T00:00:00Z']);
    await assert.rejects(db.exec('alter table seedance_reference_video_uploads alter column rights_confirmed_at set not null'), /null values/);
    const rows=(await db.query('select rights_confirmed_at from seedance_reference_video_uploads order by id')).rows;
    assert.equal(new Date(rows[0].rights_confirmed_at).toISOString(),'2026-01-01T00:00:00.000Z'); assert.equal(rows[1].rights_confirmed_at,null);
    assert.equal((await db.query("select relrowsecurity from pg_class where oid='seedance_reference_video_uploads'::regclass")).rows[0].relrowsecurity,true);
    for(const role of ['anon','authenticated']) assert.equal((await db.query(`select has_table_privilege('${role}','seedance_reference_video_uploads','SELECT,INSERT,UPDATE,DELETE') as allowed`)).rows[0].allowed,false);
    await assert.rejects(db.query(insert,['44444444-4444-4444-8444-444444444444',USER,'staging/other/file.mp4',null]),/check constraint/);
  } finally { await db.close(); }
});
