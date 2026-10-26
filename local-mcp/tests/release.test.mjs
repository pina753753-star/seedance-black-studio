import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import http from 'node:http';import {generateKeyPairSync,createHash} from 'node:crypto';
import {createReleaseApp} from '../release-app.mjs';import {createRealDb,literal} from './real-db.mjs';import fixtureModule from './fixture.js';import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
const root=resolve(import.meta.dirname,'../..'),container='pina-mcp-test-release'+process.pid,origin='https://pina.example.invalid',resource=origin+'/api/mcp',clientId='chatgpt-local',redirectUri='https://chatgpt.example.invalid/callback',owner='00000000-0000-4000-8000-000000000001';let running=false,dir,db,api,app,server,socket;const clients=[];let coldRequests=false,detachSocket=false,interactionRequest;
const docker=(...a)=>execFileSync('docker',a,{encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']});
const sql=s=>docker('exec',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pina_mcp_test','-c',s).trim();
const tokenFor=id=>Buffer.from('{}').toString('base64url')+'.'+Buffer.from(JSON.stringify({sub:id,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.dummy';
const other='00000000-0000-4000-8000-000000000002';const normalToken=tokenFor(owner),otherToken=tokenFor(other);
before(async()=>{
 docker('run','--pull=never','--detach','--name',container,'--network','none','--memory','512m','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=pina_mcp_test','postgres:17.11-bookworm','-c','listen_addresses=');running=true;
 for(let i=0;i<100;i++){try{if(!docker('logs',container).includes('PostgreSQL init process complete'))throw Error();sql('select 1');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 docker('exec',container,'mkdir','-p','/tmp/pina/tests/postgres','/tmp/pina/supabase');docker('cp',join(root,'tests/postgres/fixture.sql'),container+':/tmp/pina/tests/postgres/fixture.sql');docker('cp',join(root,'supabase/setup-01-tables.sql'),container+':/tmp/pina/supabase/setup-01-tables.sql');docker('cp',join(root,'supabase/migrations'),container+':/tmp/pina/supabase/migrations');docker('exec',container,'psql','-Xq','-v','ON_ERROR_STOP=1','-U','postgres','-d','pina_mcp_test','-f','/tmp/pina/tests/postgres/fixture.sql');
 sql(readFileSync(join(root,'docs/sql/basic-credit-access-atomic.sql'),'utf8'));sql(readFileSync(join(root,'supabase/migrations/20260803080000_add_generation_control.sql'),'utf8'));sql('ALTER TABLE generation_tasks ADD COLUMN polling_url text;');
 sql(readFileSync(join(root,'local-mcp/release/migration.sql'),'utf8'));
 sql(`INSERT INTO auth.users(id) VALUES('${owner}');INSERT INTO profiles(id,email,plan) VALUES('${owner}','dummy@example.invalid','free');INSERT INTO credit_balances(user_id,free_credits,purchased_credits,purchased_expires_at) VALUES('${owner}',0,1000,now()+interval '1 year');INSERT INTO stripe_payment_ledger(user_id,purchase_type,grant_status,charge_id,payment_intent_id) VALUES('${owner}','credit_pack','granted','ch_test','pi_test');`);
 sql(`INSERT INTO auth.users(id) VALUES('${other}');INSERT INTO profiles(id,email,plan) VALUES('${other}','other@example.invalid','free');INSERT INTO credit_balances(user_id,free_credits) VALUES('${other}',20);`);
 db=createRealDb(container);const rpc=db.rpc.bind(db);db.rpc=async(name,args)=>{const r=await rpc(name,args);if(detachSocket&&name==='pina_mcp_oauth_store'&&args.op==='upsert'&&args.p.kind==='Grant'&&interactionRequest){await new Promise(r=>setImmediate(r));interactionRequest.socket=null;}return r;};
 // Only Auth response and external provider/storage/worker are mock. SQL is real.
 db.auth={getUser:async token=>[normalToken,otherToken].includes(token)?{data:{user:{id:token===normalToken?owner:other,email_confirmed_at:'2026-01-01'}}}:{data:{user:null},error:{name:'AuthApiError',code:'bad_jwt'}},admin:{getUserById:async id=>[owner,other].includes(id)?{data:{user:{id,email_confirmed_at:'2026-01-01'}}}:{data:{user:null},error:{code:'user_not_found'}}}};
 api=fixtureModule.apiFixture(db);
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwks={keys:[{...privateKey.export({format:'jwk'}),kid:'dummy',alg:'RS256',use:'sig'}]};
 const options={allowGeneration:true,origin,clientId,redirectUri,db,confirmedAuth:api.confirmedAuth,startModule:api.startModule,statusModule:api.statusModule,pricedModule:api.pricedModule,quoteKey:Buffer.alloc(32,1),csrfKey:Buffer.alloc(32,2),browserKey:Buffer.alloc(32,3),storageKey:Buffer.alloc(32,4),cookieKeys:['dummy-only-cookie-key'],jwks,artifactHosts:['storage.example.invalid'],timeoutMs:15000};
 app=createReleaseApp(options);app.restart=(extra={})=>createReleaseApp({...options,...extra});
 dir=mkdtempSync(join(tmpdir(),'pina-release-'));socket=join(dir,'http');server=http.createServer((req,res)=>{if(req.url.startsWith('/interaction/'))interactionRequest=req;if(coldRequests){const restart=app.restart;app=restart();app.restart=restart;}return app.handler(req,res);});await new Promise(r=>server.listen(socket,r));
});
after(async()=>{for(const c of clients)await c.close().catch(()=>{});if(server)await new Promise(r=>server.close(r));if(dir)rmSync(dir,{recursive:true,force:true});if(running)docker('rm','-f',container);});
function request(path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const req=http.request({socketPath:socket,path,method,headers:{host:new URL(origin).host,'x-forwarded-proto':'https',...headers}},res=>{let data='';res.on('data',c=>data+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:data}));});req.on('error',reject);req.end(body);});}
async function browser(user=owner){const cookies=new Map();const call=async(path,form,extra={})=>{const r=await request(path,{method:form?'POST':'GET',headers:{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),origin,...(form?{'content-type':'application/x-www-form-urlencoded'}:{}),...extra},body:form?new URLSearchParams(form).toString():undefined});for(const line of r.headers['set-cookie']||[]){const kv=line.split(';')[0],i=kv.indexOf('=');cookies.set(kv.slice(0,i),kv.slice(i+1));}return r;};assert.equal((await call('/mcp/browser-session',{}, {authorization:'Bearer '+(user===owner?normalToken:otherToken)})).status,204);return call;}
async function connect(user=owner){const discovery=await request('/.well-known/oauth-authorization-server/mcp/oauth');assert.equal(discovery.status,200);const metadata=JSON.parse(discovery.body);const b=await browser(user),v='p'.repeat(64),params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read generation:read generation:write',resource,code_challenge_method:'S256',code_challenge:createHash('sha256').update(v).digest('base64url'),state:'state'};
 let r=await b(new URL(metadata.authorization_endpoint).pathname+'?'+new URLSearchParams(params));assert.ok(r.headers.location,JSON.stringify(r));let path=new URL(r.headers.location,origin).pathname;let page=await b(path);assert.equal(page.status,200,page.body);const csrf=page.body.match(/name="csrf" value="([^"]+)"/)[1];r=await b(path,{csrf,decision:'allow'});assert.ok(r.headers.location,JSON.stringify(r));const resume=new URL(r.headers.location,origin);r=await b(resume.pathname+resume.search);assert.ok(r.headers.location,JSON.stringify(r));const callback=new URL(r.headers.location);assert.ok(callback.searchParams.get('code'),JSON.stringify(r));
 r=await request(new URL(metadata.token_endpoint).pathname,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,resource,code:callback.searchParams.get('code'),code_verifier:v}).toString()});assert.equal(r.status,200,r.body);const tokens=JSON.parse(r.body);assert.equal(tokens.id_token,undefined);assert.ok(!r.body.includes(normalToken));
 const client=new Client({name:'release-test',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(resource),{requestInit:{headers:{Authorization:'Bearer '+tokens.access_token}},fetch:async(url,init={})=>{const u=new URL(url),r=await request(u.pathname+u.search,{method:init.method||'GET',headers:Object.fromEntries(new Headers(init.headers)),body:init.body});return new Response(r.body,{status:r.status,headers:r.headers});}}));return {b,client,tokens,code:callback.searchParams.get('code'),verifier:v};}
test('private release SQL denies anon/authenticated and allows service RPC only',()=>{for(const role of ['anon','authenticated'])for(const s of ["SELECT public.pina_mcp_oauth_store('find','{}')","SELECT public.pina_mcp_dispatch('get','{}')","SELECT * FROM pina_mcp.broker_state"])assert.throws(()=>sql('SET ROLE '+role+';'+s));assert.equal(sql("SET ROLE service_role;SELECT public.pina_mcp_oauth_store('find','{}');").trim(),'null');});
test('real Auth wrapper -> encrypted browser session -> OAuth/Postgres -> signed quote -> approval -> real accounting API',async()=>{
 const f=await connect(),call=(name,args={})=>f.client.callTool({name,arguments:args});
 assert.equal((await call('pina_get_balance')).structuredContent.available_credits,1000);
 const q=(await call('pina_estimate_generation',{prompt:'quiet paper boat',model:'bytedance/seedance-2.0',duration:5,resolution:'720p',aspect_ratio:'16:9'})).structuredContent;assert.ok(q,q?.error);
 const args={proposal_id:q.proposal_id,request_id:'once'};assert.equal((await call('pina_start_generation',args)).isError,true);
 const page=await f.b(new URL(q.approval_url).pathname+new URL(q.approval_url).search);assert.equal(page.status,200,page.body);const form={};for(const m of page.body.matchAll(/name="([^"]+)" value="([^"]*)"/g))form[m[1]]=m[2];form.decision='approve';
 assert.equal((await f.b('/mcp/approve',{...form,max_credits:'1'})).status,403);assert.equal((await f.b('/mcp/approve',form,{origin:'https://evil.invalid'})).status,403);assert.equal((await f.b('/mcp/approve',form)).status,200);
 const results=await Promise.all([call('pina_start_generation',args),call('pina_start_generation',args)]);const started=results.find(x=>x.structuredContent?.state==='started');assert.ok(started,JSON.stringify({results,errors:db.errors}));assert.equal(api.counters.provider,1);
 assert.equal(JSON.parse(sql(`SELECT purchased_credits FROM credit_balances WHERE user_id='${owner}'`)),915);
 assert.equal(JSON.parse(sql("SELECT count(*) FROM credit_transactions WHERE reason='video_generation'")),1);
 const task=started.structuredContent.task_id;api.complete();const status=await call('pina_get_generation',{task_id:task});assert.equal(status.structuredContent?.status,'completed',JSON.stringify(status));const artifact=await call('pina_get_artifact',{task_id:task});assert.equal(artifact.structuredContent?.url,'https://storage.example.invalid/watermarked.mp4',JSON.stringify(artifact));
 const restart=app.restart;app=restart();app.restart=restart;assert.equal((await call('pina_start_generation',args)).structuredContent.task_id,task);assert.equal(api.counters.provider,1);
});

const exchange=values=>request('/mcp/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,resource,...values}).toString()});
const input={prompt:'paper boat',model:'bytedance/seedance-2.0',duration:5,resolution:'720p',aspect_ratio:'16:9'};
async function approved(f){const result=await f.client.callTool({name:'pina_estimate_generation',arguments:input});const q=result.structuredContent;assert.ok(q,JSON.stringify(result));const page=await f.b(new URL(q.approval_url).pathname+new URL(q.approval_url).search);assert.equal(page.status,200,page.body);const form={};for(const m of page.body.matchAll(/name="([^"]+)" value="([^"]*)"/g))form[m[1]]=m[2];form.decision='approve';assert.equal((await f.b('/mcp/approve',form)).status,200);return q;}
function resetAccounting(){sql("TRUNCATE generation_tasks,credit_transactions CASCADE;UPDATE credit_balances SET purchased_credits=1000;");}
test('enabled provider metadata matches mounted routes and only supported OAuth capabilities',async()=>{
 const paths=['/.well-known/oauth-authorization-server/mcp/oauth','/.well-known/openid-configuration/mcp/oauth','/mcp/oauth/.well-known/openid-configuration','/mcp/oauth/.well-known/oauth-authorization-server'];
 for(const path of paths){const r=await request(path);assert.equal(r.status,200,r.body);const m=JSON.parse(r.body);
  assert.equal(m.issuer,origin+'/mcp/oauth');
  for(const [key,suffix] of [['authorization_endpoint','/auth'],['token_endpoint','/token'],['jwks_uri','/jwks'],['revocation_endpoint','/token/revocation']])assert.equal(m[key],origin+'/mcp/oauth'+suffix);
  assert.deepEqual(m.scopes_supported,['credits:read','generation:read','generation:write']);assert.deepEqual(m.response_types_supported,['code']);assert.deepEqual([...m.grant_types_supported].sort(),['authorization_code','refresh_token']);assert.deepEqual(m.token_endpoint_auth_methods_supported,['none']);assert.deepEqual(m.code_challenge_methods_supported,['S256']);assert.equal(m.registration_endpoint,undefined);assert.equal(m.id_token_signing_alg_values_supported,undefined);assert.equal(m.claims_supported,undefined);
  const jwks=await request(new URL(m.jwks_uri).pathname);assert.equal(jwks.status,200);for(const key of JSON.parse(jwks.body).keys)assert.equal(key.d,undefined);
  const auth=await request(new URL(m.authorization_endpoint).pathname);assert.notEqual(auth.status,404);
  const token=await request(new URL(m.token_endpoint).pathname,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'grant_type=authorization_code'});assert.equal(token.status,400);
 }
 assert.equal((await request('/auth')).status,404);assert.equal((await request('/token')).status,404);
});
test('discovery and mutual rejection: normal token cannot enter MCP, opaque cannot enter Pina API/browser',async()=>{
 for(const path of ['/.well-known/oauth-authorization-server/mcp/oauth','/.well-known/oauth-protected-resource/api/mcp']){const r=await request(path);assert.equal(r.status,200,r.body);}
 const f=await connect();assert.equal((await request('/api/mcp',{method:'POST',headers:{authorization:'Bearer '+normalToken,'content-type':'application/json'},body:'{}'})).status,401);
 let status=0;const res={status(n){status=n;return this},json(){return this},setHeader(){}};await api.startHandler({method:'POST',headers:{authorization:'Bearer '+f.tokens.access_token},body:input},res);assert.equal(status,401);
 assert.equal((await request('/mcp/browser-session',{method:'POST',headers:{origin,authorization:'Bearer '+f.tokens.access_token}})).status,403);
 assert.equal((await db.auth.getUser(f.tokens.access_token)).data.user,null); // Auth mock response, not Hosted proof.
 const stored=sql("SELECT coalesce(json_agg(payload),'[]'::json) FROM pina_mcp.broker_state");assert.ok(!stored.includes(f.tokens.access_token));assert.ok(!stored.includes(normalToken));
});
test('Postgres code replay, refresh rotation/replay and revocation invalidate MCP',async()=>{
 const f=await connect();const replay=await exchange({grant_type:'authorization_code',code:f.code,code_verifier:f.verifier,redirect_uri:redirectUri});assert.equal(replay.status,400);await assert.rejects(f.client.callTool({name:'pina_get_balance',arguments:{}}));
 const g=await connect();const rotated=await exchange({grant_type:'refresh_token',refresh_token:g.tokens.refresh_token});assert.equal(rotated.status,200,rotated.body);const next=JSON.parse(rotated.body);assert.notEqual(next.refresh_token,g.tokens.refresh_token);
 assert.equal((await exchange({grant_type:'refresh_token',refresh_token:g.tokens.refresh_token})).status,400);assert.equal(await app.provider.AccessToken.find(next.access_token),undefined);
 const h=await connect();assert.equal((await request('/mcp/oauth/token/revocation',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,token:h.tokens.access_token}).toString()})).status,200);assert.equal(await app.provider.AccessToken.find(h.tokens.access_token),undefined);
});
test('production start gate fails before durable claim and accounting',async()=>{
 resetAccounting();const f=await connect(),q=await approved(f),restart=app.restart;app=restart({allowGeneration:false});app.restart=restart;
 const before=sql('SELECT count(*) FROM pina_mcp.requests');const r=await f.client.callTool({name:'pina_start_generation',arguments:{proposal_id:q.proposal_id,request_id:'disabled'}});assert.equal(r.content[0].text,'generation_not_enabled');assert.equal(sql('SELECT count(*) FROM pina_mcp.requests'),before);assert.equal(sql(`SELECT purchased_credits FROM credit_balances WHERE user_id='${owner}'`),'1000');app=restart();app.restart=restart;
});
test('real failed provider refund is idempotent on the existing SQL path',async()=>{
 resetAccounting();const f=await connect(),q=await approved(f);const r=await f.client.callTool({name:'pina_start_generation',arguments:{proposal_id:q.proposal_id,request_id:'fail'}});assert.equal(r.structuredContent?.state,'started',JSON.stringify({r,errors:db.errors}));api.fail();
 const args={task_id:r.structuredContent.task_id};for(let i=0;i<2;i++)await f.client.callTool({name:'pina_get_generation',arguments:args});assert.equal(sql(`SELECT purchased_credits FROM credit_balances WHERE user_id='${owner}'`),'1000');assert.equal(sql("SELECT count(*) FROM credit_transactions WHERE reason='generation_refund'"),'1');
});
test('unknown provider outcome survives app restart, new request/proposal cannot double debit',async()=>{
 resetAccounting();const f=await connect(),q=await approved(f),restart=app.restart;app=restart({timeoutMs:8000});app.restart=restart;api.timeout();const prior=api.counters.provider;
 const args={proposal_id:q.proposal_id,request_id:'unknown'};const r=await f.client.callTool({name:'pina_start_generation',arguments:args});assert.equal(r.structuredContent?.state,'uncertain',JSON.stringify(r));assert.equal(api.counters.provider,prior+1);
 app=restart();app.restart=restart;assert.equal((await f.client.callTool({name:'pina_start_generation',arguments:args})).structuredContent.state,'uncertain');assert.equal((await f.client.callTool({name:'pina_start_generation',arguments:{...args,request_id:'resend'}})).isError,true);
 const q2=await approved(f);assert.equal((await f.client.callTool({name:'pina_start_generation',arguments:{proposal_id:q2.proposal_id,request_id:'other'}})).isError,true);assert.equal(sql("SELECT count(*) FROM credit_transactions WHERE reason='video_generation'"),'1');assert.equal(api.counters.provider,prior+1);
});

test('real browser session/CSRF/quote binding and other-owner artifact deny',async()=>{
 const f=await connect();const result=await f.client.callTool({name:'pina_estimate_generation',arguments:input});const q=result.structuredContent;assert.ok(q,JSON.stringify(result));const page=await f.b(new URL(q.approval_url).pathname+new URL(q.approval_url).search);const form={};for(const m of page.body.matchAll(/name="([^"]+)" value="([^"]*)"/g))form[m[1]]=m[2];form.decision='approve';
 const otherBrowser=await browser(other);assert.notEqual((await otherBrowser('/mcp/approve',form)).status,200);
 const newSession=await browser();assert.equal((await newSession('/mcp/approve',form)).status,403);
 sql(`UPDATE pina_mcp.proposals SET quote=jsonb_set(quote,'{expiresAt}','0') WHERE id=${literal(q.proposal_id)}`);assert.equal((await f.b('/mcp/approve',form)).status,403);
 const otherClient=await connect(other);const task=JSON.parse(sql('SELECT to_jsonb(id) FROM generation_tasks LIMIT 1'));assert.equal((await otherClient.client.callTool({name:'pina_get_artifact',arguments:{task_id:task}})).isError,true);
});

for(const cold of [false,true])test('detached transport across Postgres grant save completes code exchange and balance; cold='+cold,async()=>{
 const before=api.counters.provider,restart=app.restart;app=restart({allowGeneration:false});app.restart=(extra={})=>restart({allowGeneration:false,...extra});
 coldRequests=cold;detachSocket=true;try{const f=await connect();const r=await f.client.callTool({name:'pina_get_balance',arguments:{}});assert.ok(Number.isInteger(r.structuredContent.available_credits));assert.equal(api.counters.provider,before);}finally{coldRequests=false;detachSocket=false;interactionRequest=undefined;app=restart();app.restart=restart;}
});
test('transport adapter retains host gate and never authenticates forwarded headers',async()=>{
 for(const path of ['/interaction/dummy','/mcp/oauth/auth','/api/mcp']){
  const r=await request(path,{headers:{host:'evil.invalid','x-forwarded-host':new URL(origin).host,'x-forwarded-proto':'https'}});assert.equal(r.status,400);assert.equal(r.body,'invalid_host');
 }
 const r=await request('/interaction/dummy',{method:'POST',headers:{origin,'content-type':'application/x-www-form-urlencoded','x-forwarded-proto':'https','x-forwarded-host':'evil.invalid'},body:'csrf=dummy&decision=allow'});assert.equal(r.status,403);
 assert.equal((await request('/api/mcp',{headers:{'x-forwarded-proto':'https'}})).status,401);
});
