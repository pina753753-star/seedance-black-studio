'use strict';
const {test,before,after}=require('node:test');const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');const fs=require('node:fs');const path=require('node:path');
const {Client,StreamableHTTPClientTransport}=require('@modelcontextprotocol/client');
const {createCore}=require('../core'),{createQuoteIntegrity}=require('../quote-integrity');
const {createPostgresStore}=require('../postgres-store'),{createDockerQuery}=require('../local-docker-db');
const {createApprovalUI}=require('../approval-ui'),{createMcpHttpHandler}=require('../sdk-transport');
const {issuerFixture,apiFixture}=require('./fixture');
const container='pina-mcp-test-'+process.pid;let running=false;const clients=[];
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']});
const sql=s=>docker('exec',container,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','pina_mcp_test','-c',s);
before(async()=>{
 docker('run','--pull=never','--detach','--name',container,'--network','none','--memory','512m','--tmpfs','/var/lib/postgresql/data:rw','-e','POSTGRES_HOST_AUTH_METHOD=trust','-e','POSTGRES_DB=pina_mcp_test','postgres:17.11-bookworm','-c','listen_addresses=');running=true;
 for(let i=0;i<60;i++){try{if(!docker('logs',container).includes('PostgreSQL init process complete'))throw new Error('initializing');docker('exec',container,'pg_isready','-U','postgres');break;}catch{await new Promise(r=>setTimeout(r,100));}}
 sql(fs.readFileSync(path.resolve(__dirname,'../ledger.sql'),'utf8'));
});
after(async()=>{for(const c of clients)await c.close().catch(()=>{});if(running)docker('rm','-f',container);});
const input={prompt:'A quiet tree <script>alert(1)</script>',model:'bytedance/seedance-2.0',duration:5,resolution:'720p',aspect_ratio:'16:9'};
async function setup(){
 sql('TRUNCATE pina_mcp.requests,pina_mcp.proposals CASCADE');
 const auth=issuerFixture(),api=apiFixture(),token=auth.mint(),context={accessToken:token};
 const makeCore=()=>createCore({authenticate:auth.authenticate,store:createPostgresStore({query:createDockerQuery(container)}),backend:api.backend,integrity:createQuoteIntegrity(Buffer.alloc(32,7)),artifactHosts:['storage.example.invalid'],approvalBaseUrl:'https://pina.example.invalid'});
 let core=makeCore();const origin='https://pina.example.invalid';
 const sessions={browser:{id:'browser-session',userId:'user-a',expiresAt:Date.now()+600000,context},other:{id:'other',userId:'user-b',expiresAt:Date.now()+600000,context:{accessToken:auth.mint({sub:'user-b'})}}};
 const ui=createApprovalUI({core,resolveBrowserSession:async r=>sessions[r.headers.cookie],csrfKey:Buffer.alloc(32,8),origin});
 async function clientFor(accessToken=token,c=core){
  const handler=createMcpHttpHandler({core:c,authenticate:auth.authenticate,resource:auth.audience,issuer:auth.issuer});
  const client=new Client({name:'local-contract',version:'1'});clients.push(client);
  const transport=new StreamableHTTPClientTransport(new URL(auth.audience),{requestInit:{headers:{Authorization:'Bearer '+accessToken}},fetch:async(url,init)=>handler(new Request(url,init))});
  await client.connect(transport);return client;
 }
 const client=await clientFor();
 const call=async(name,args={},c=client)=>c.callTool({name,arguments:args});
 const quote=async()=>{const r=await call('pina_estimate_generation',input);assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;};
 async function form(q,cookie='browser'){
  const r=await ui({method:'GET',url:q.approval_url,headers:{cookie}});
  const params=new URLSearchParams();for(const m of r.body.matchAll(/name="([^"]+)" value="([^"]*)"/g))params.set(m[1],m[2]);params.set('decision','approve');return {r,params};
 }
 const post=(params,extra={})=>ui({method:'POST',url:'/approve',headers:{cookie:'browser',origin,'content-type':'application/x-www-form-urlencoded',...extra},body:params.toString()});
 const approve=async q=>{const {r,params}=await form(q);assert.equal(r.status,200);assert.equal((await post(params)).status,200);};
 return {auth,api,core,makeCore,clientFor,client,call,quote,form,post,approve,ui,sessions,context};
}
test('isolated Postgres has no network/ports; schema denies public role',()=>{
 const inspect=JSON.parse(docker('inspect',container))[0];assert.equal(inspect.HostConfig.NetworkMode,'none');assert.equal(Object.keys(inspect.HostConfig.PortBindings||{}).length,0);
 sql('CREATE ROLE mcp_untrusted');assert.throws(()=>sql("SET ROLE mcp_untrusted; SELECT pina_mcp.dispatch('get','{}');"));
});
test('SDK HTTP initialize/list -> signed quote -> browser approve -> single existing API start -> owned artifact',async()=>{
 const f=await setup();assert.equal((await f.client.listTools()).tools.length,5);
 const q=await f.quote();const {r}=await f.form(q);assert.match(r.body,/&lt;script&gt;/);assert.doesNotMatch(r.body,/<script>/);assert.equal(r.headers['Cache-Control'],'no-store');
 await f.approve(q);const args={proposal_id:q.proposal_id,request_id:'once'};
 const results=await Promise.all(Array.from({length:5},()=>f.call('pina_start_generation',args)));
 const started=results.find(r=>r.structuredContent?.state==='started');assert.ok(started,JSON.stringify(results));
 assert.equal(f.api.counters.deduct,1);assert.equal(f.api.counters.provider,1);assert.equal(f.api.counters.reserve,1);assert.equal(f.api.counters.moderation,1);assert.ok(f.api.counters.auth>=2);
 const task=started.structuredContent.task_id;
 assert.equal((await f.call('pina_get_generation',{task_id:task})).structuredContent.status,'processing');
 f.api.complete();assert.equal((await f.call('pina_get_generation',{task_id:task})).structuredContent.status,'completed');assert.equal(f.api.counters.watermark,1);
 assert.equal((await f.call('pina_get_artifact',{task_id:task})).structuredContent.url,'https://storage.example.invalid/watermarked.mp4');
 const restarted=await f.clientFor(undefined,f.makeCore());assert.equal((await f.call('pina_start_generation',args,restarted)).structuredContent.task_id,task);assert.equal(f.api.counters.provider,1);
 const other=await f.clientFor(f.auth.mint({sub:'user-b'}));assert.equal((await f.call('pina_get_artifact',{task_id:task},other)).isError,true);
});
test('MCP cannot approve; browser requires same owner, valid session, origin, csrf, exact fingerprint and budget',async()=>{
 const f=await setup(),q=await f.quote();
 assert.equal((await f.call('pina_start_generation',{proposal_id:q.proposal_id,request_id:'no'})).isError,true);
 assert.equal((await f.call('approveProposal',{proposal_id:q.proposal_id})).isError,true);
 const {params}=await f.form(q);
 for(const headers of [{origin:'https://evil.example.invalid'},{cookie:'other'},{cookie:'missing'},{'sec-fetch-site':'cross-site'},{'content-type':'application/json'}])assert.notEqual((await f.post(params,headers)).status,200);
 for(const [key,value] of [['csrf','bad'],['fingerprint','bad'],['max_credits','1'],['decision','false']]){const p=new URLSearchParams(params);p.set(key,value);assert.equal((await f.post(p)).status,403);}
 const duplicate=new URLSearchParams(params);duplicate.append('max_credits','9999');assert.equal((await f.post(duplicate)).status,403);
 f.sessions.browser.expiresAt=0;assert.equal((await f.post(params)).status,401);assert.equal(f.api.counters.provider,0);
});
test('expired or altered stored quote fails approval and does not invoke existing API',async()=>{
 const f=await setup(),q=await f.quote();const {params}=await f.form(q);
 sql("UPDATE pina_mcp.proposals SET quote=jsonb_set(quote,'{credits}','1')");assert.equal((await f.post(params)).status,403);
 const q2=await f.quote(),p2=(await f.form(q2)).params;
 sql("UPDATE pina_mcp.proposals SET quote=jsonb_set(quote,'{expiresAt}','0')");assert.equal((await f.post(p2)).status,403);assert.equal(f.api.counters.provider,0);
});
test('different request IDs racing the same approved quote consume once',async()=>{
 const f=await setup(),q=await f.quote();await f.approve(q);
 const r=await Promise.all(['one','two'].map(request_id=>f.call('pina_start_generation',{proposal_id:q.proposal_id,request_id})));
 assert.equal(r.filter(x=>x.structuredContent?.state==='started').length,1);assert.equal(f.api.counters.deduct,1);
});
test('timeout survives adapter restart; new request and new proposal cannot resend unresolved owner start',async()=>{
 const f=await setup(),q=await f.quote();await f.approve(q);f.api.timeout();const args={proposal_id:q.proposal_id,request_id:'timeout'};
 assert.equal((await f.call('pina_start_generation',args)).structuredContent.state,'uncertain');
 const c=await f.clientFor(undefined,f.makeCore());assert.equal((await f.call('pina_start_generation',args,c)).structuredContent.state,'uncertain');
 assert.equal((await f.call('pina_start_generation',{...args,request_id:'other'},c)).isError,true);
 const q2=await f.quote();await f.approve(q2);assert.equal((await f.call('pina_start_generation',{proposal_id:q2.proposal_id,request_id:'third'},c)).isError,true);
 assert.equal(f.api.counters.provider,1);assert.equal(f.api.counters.deduct,1);
});
test('crash after durable claim, before API invocation, stays pending after restart',async()=>{
 const f=await setup(),q=await f.quote();await f.approve(q);const store=createPostgresStore({query:createDockerQuery(container)}),saved=await store.getProposal(q.proposal_id);
 await store.claim('user-a','crash',q.proposal_id,q.fingerprint,Date.now(),saved);
 const child=execFileSync(process.execPath,['-e',`const {createPostgresStore}=require('./local-mcp/postgres-store');const {createDockerQuery}=require('./local-mcp/local-docker-db');createPostgresStore({query:createDockerQuery('${container}')}).getRequest('user-a','crash').then(r=>process.stdout.write(JSON.stringify(r)));`],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'});assert.equal(JSON.parse(child).state,'pending');
 const c=await f.clientFor(undefined,f.makeCore());assert.equal((await f.call('pina_start_generation',{proposal_id:q.proposal_id,request_id:'crash'},c)).structuredContent.state,'pending');assert.equal(f.api.counters.provider,0);
});
test('existing emergency stop and moderation run before reservation/deduction/provider',async()=>{
 for(const flag of ['stop','block']){const f=await setup(),q=await f.quote();await f.approve(q);f.api[flag]();await f.call('pina_start_generation',{proposal_id:q.proposal_id,request_id:flag});assert.equal(f.api.counters.reserve,0,flag);assert.equal(f.api.counters.deduct,0,flag);assert.equal(f.api.counters.provider,0,flag);}
});
test('missing or invalid bearer HTTP challenge, origin and audience boundary',async()=>{
 const f=await setup(),h=createMcpHttpHandler({core:f.core,authenticate:f.auth.authenticate,resource:f.auth.audience,issuer:f.auth.issuer});
 for(const token of ['',f.auth.mint({aud:'wrong'}),f.auth.mint({iss:'wrong'}),f.auth.mint({exp:0}),f.auth.mint({nbf:9999999999}),f.auth.mint({}, {alg:'none'}),f.auth.mint({}, {kid:'unknown'}),f.auth.mint({}, {jku:'https://evil.invalid'})]){const r=await h(new Request(f.auth.audience,{method:'POST',headers:{Authorization:'Bearer '+token}}));assert.equal(r.status,401);assert.match(r.headers.get('WWW-Authenticate'),/resource_metadata/);}
 const meta=await h(new Request('https://pina.example.invalid/.well-known/oauth-protected-resource'));assert.equal((await meta.json()).resource,f.auth.audience);
 assert.equal((await h(new Request(f.auth.audience,{headers:{Origin:'https://evil.invalid'}}))).status,403);
 const token=f.auth.mint();const chunks=token.split('.');chunks[1]=Buffer.from(JSON.stringify({sub:'user-b'})).toString('base64url');assert.equal((await h(new Request(f.auth.audience,{headers:{Authorization:'Bearer '+chunks.join('.')}}))).status,401);
});

test('existing status handler drives provider failure through existing atomic refund RPC',async()=>{
 const f=await setup(),q=await f.quote();await f.approve(q);const r=await f.call('pina_start_generation',{proposal_id:q.proposal_id,request_id:'failed-task'});f.api.fail();
 const status=await f.call('pina_get_generation',{task_id:r.structuredContent.task_id});assert.equal(status.structuredContent.status,'failed');assert.equal(status.structuredContent.refunded,true);assert.equal(f.api.counters.refund,1);assert.equal(f.api.row.free_credits,10000);
 await f.call('pina_get_generation',{task_id:r.structuredContent.task_id});assert.equal(f.api.counters.refund,1);
});

test('composed app serves approval URL and SDK HTTP with separate browser cookie session',async()=>{
 sql('TRUNCATE pina_mcp.requests,pina_mcp.proposals CASCADE');
 const {createLocalApp}=require('../app');const auth=issuerFixture(),api=apiFixture(),token=auth.mint();
 const app=createLocalApp({query:createDockerQuery(container),issuer:auth.issuer,resource:auth.audience,loadJwks:async()=>({keys:[auth.jwk]}),resolveIdentity:async({subject})=>subject==='user-a'?{userId:subject,emailConfirmed:true,accountStatus:'active'}:null,
 resolveBrowserSession:async r=>r.headers.cookie==='browser'?{id:'browser',userId:'user-a',expiresAt:Date.now()+60000,context:{accessToken:token}}:null,
 resolvePinaSession:async userId=>({userId,accessToken:'pina-test-session'}),confirmedAuth:api.confirmedAuth,startHandler:api.startHandler,statusHandler:api.statusHandler,quoteKey:Buffer.alloc(32,7),csrfKey:Buffer.alloc(32,8),artifactHosts:['storage.example.invalid']});
 const c=new Client({name:'composed-test',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(new URL(auth.audience),{requestInit:{headers:{Authorization:'Bearer '+token}},fetch:async(u,i)=>app(new Request(u,i))}));
 const q=(await c.callTool({name:'pina_estimate_generation',arguments:input})).structuredContent;
 assert.equal((await app(new Request(q.approval_url,{headers:{Authorization:'Bearer '+token}}))).status,401);
 const page=await app(new Request(q.approval_url,{headers:{Cookie:'browser'}}));assert.equal(page.status,200);const html=await page.text(),params=new URLSearchParams();for(const m of html.matchAll(/name="([^"]+)" value="([^"]*)"/g))params.set(m[1],m[2]);params.set('decision','approve');
 assert.equal((await app(new Request('https://pina.example.invalid/approve',{method:'POST',headers:{Cookie:'browser',Origin:'https://pina.example.invalid','Content-Type':'application/x-www-form-urlencoded'},body:params}))).status,200);
 const start=(await c.callTool({name:'pina_start_generation',arguments:{proposal_id:q.proposal_id,request_id:'composed'}})).structuredContent;assert.equal(start.state,'started');
 api.complete();assert.equal((await c.callTool({name:'pina_get_generation',arguments:{task_id:start.task_id}})).structuredContent.status,'completed');
 assert.match((await c.callTool({name:'pina_get_artifact',arguments:{task_id:start.task_id}})).structuredContent.url,/watermarked/);
 assert.equal(api.counters.deduct,1);assert.equal(api.counters.provider,1);
});
