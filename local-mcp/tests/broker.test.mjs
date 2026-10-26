import {PassThrough} from 'node:stream';import {parse as parseForm} from 'node:querystring';
import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import http from 'node:http';
import coreModule from '../core.js';import storeModule from '../mock-store.js';import quoteModule from '../quote-integrity.js';
import {createBrokerInteraction} from '../broker-interaction.mjs';
import {createBrokerStore} from '../broker-sqlite.mjs';import {createBroker,createOpaqueAuthenticator} from '../broker.mjs';
const issuer='https://broker.example.invalid',resource='https://pina.example.invalid/api/mcp',clientId='pina-test',redirectUri='https://chatgpt.example.invalid/callback',owner='dummy-user';
async function fixture(t,{mounted=false,vercelHelpers=false,cold=false,detachSocket=false,invalidateInteraction=false}={}){
 const dir=mkdtempSync(join(tmpdir(),'pina-broker-')),key=Buffer.alloc(32,3),file=join(dir,'state.sqlite');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwks={keys:[{...privateKey.export({format:'jwk'}),kid:'dummy',alg:'RS256',use:'sig'}]};
 const stores=[],servers=[];
 const instance=async()=>{const store=createBrokerStore(file,key);stores.push(store);let interactionRequest;class Adapter extends store.Adapter{async upsert(...args){await super.upsert(...args);if(detachSocket&&this.kind==='Grant'&&interactionRequest){await new Promise(r=>setImmediate(r));interactionRequest.socket=null;if(invalidateInteraction)await new store.Adapter('Interaction').destroy(interactionRequest.url.split('/').pop());}}}const provider=createBroker({issuer:mounted?issuer+'/mcp/oauth':issuer,resource,clientId,redirectUri,Adapter,cookieKeys:['test-only-cookie-material'],jwks,findAccount:async(ctx,id)=>id===owner?{accountId:id,claims:async()=>({sub:id})}:undefined});const interaction=createBrokerInteraction({provider,origin:issuer,clientId,resource,verifyPinaBrowserSession:async()=>({userId:owner,emailConfirmed:true,accountStatus:'active'}),issueCsrf:async()=> 'dummy-csrf',verifyCsrf:async value=>value==='dummy-csrf'});const callback=provider.callback();const handle=async(req,res)=>{if(vercelHelpers&&req.headers['content-type']){const chunks=[];await new Promise((resolve,reject)=>{req.on('data',c=>chunks.push(c));req.on('end',resolve);req.on('error',reject);});const raw=Buffer.concat(chunks);const replay=new PassThrough(),on=replay.on.bind(replay),originalOn=req.on.bind(req);req.read=replay.read.bind(replay);req.on=req.addListener=(name,cb)=>name==='data'||name==='end'?on(name,cb):originalOn(name,cb);replay.end(raw);Object.defineProperty(req,'body',{configurable:true,get:()=>parseForm(raw.toString())});}if(req.url.startsWith('/interaction/')){interactionRequest=req;return interaction(req,res);}if(mounted){req.originalUrl=req.url;req.url=req.url.slice('/mcp/oauth'.length);}return callback(req,res);};const server=http.createServer((req,res)=>cold?instance().then(x=>x.handle(req,res)):handle(req,res));servers.push(server);const socket=join(dir,'s'+servers.length);await new Promise(r=>server.listen(socket,r));return {provider,store,socket,handle};};
 const a=await instance();
 t.after(async()=>{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));stores.forEach(s=>s.close());rmSync(dir,{recursive:true,force:true});});
 const request=(socket,path,data,headers={})=>new Promise((resolve,reject)=>{const body=data?new URLSearchParams(data).toString():null;const req=http.request({socketPath:socket,path,method:body?'POST':'GET',headers:{host:'broker.example.invalid','x-forwarded-proto':'https',...headers,...(body?{'content-type':'application/x-www-form-urlencoded','content-length':Buffer.byteLength(body)}:{})}},res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>{let data;try{data=JSON.parse(s);}catch{data=s;}resolve({status:res.statusCode,data,headers:res.headers});});});req.on('error',reject);req.end(body);});
 const code=async()=>{const grant=new a.provider.Grant({accountId:owner,clientId});grant.addResourceScope(resource,'credits:read generation:read generation:write');const grantId=await grant.save();const verifier='a'.repeat(64);const c=new a.provider.AuthorizationCode({accountId:owner,clientId,grantId,redirectUri,scope:'credits:read generation:read generation:write',resource,codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256'});return {code:await c.save(),verifier,grantId};};
 const exchange=(q,socket=a.socket,extra={})=>request(socket,'/token',{grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code:q.code,code_verifier:q.verifier,resource,...extra});
 return {...a,instance,request,code,exchange};
}
test('actual OAuth endpoint: PKCE, callback/resource binding, opaque token and code one use',async t=>{
 const f=await fixture(t);
 for(const extra of [{code_verifier:'b'.repeat(64)},{redirect_uri:'https://evil.invalid/callback'},{resource:'https://evil.invalid'}])assert.equal((await f.exchange(await f.code(),f.socket,extra)).status,400);
 const q=await f.code();const ok=await f.exchange(q);assert.equal(ok.status,200,JSON.stringify(ok.data));assert.ok(ok.data.access_token&&!ok.data.access_token.includes('.'));assert.ok(ok.data.refresh_token);
 assert.equal((await f.exchange(q)).status,400);
});
test('opaque resource verifier rejects normal JWT, wrong owner/grant; refresh rotates and replay revokes',async t=>{
 const f=await fixture(t),r=await f.exchange(await f.code());assert.equal(r.status,200,JSON.stringify(r.data));
 const auth=createOpaqueAuthenticator({provider:f.provider,resource,clientId,authorize:async({userId})=>({userId,active:true,emailConfirmed:true,accountStatus:'active',capabilities:['credits:read']})});
 assert.deepEqual((await auth({accessToken:r.data.access_token})).scopes,['credits:read']);
 await assert.rejects(auth({accessToken:'signed.supabase.jwt'}));
 const wrongOwner=createOpaqueAuthenticator({provider:f.provider,resource,clientId,authorize:async()=>({userId:'other',active:true,emailConfirmed:true,accountStatus:'active',capabilities:['credits:read']})});
 await assert.rejects(wrongOwner({accessToken:r.data.access_token}));
 for(const extra of [{resource:'https://wrong.invalid'},{clientId:'wrong'}]){let reads=0;const reject=createOpaqueAuthenticator({provider:f.provider,resource,clientId,authorize:async()=>{reads++;throw new Error('Must not reach grant');},...extra});await assert.rejects(reject({accessToken:r.data.access_token}));assert.equal(reads,0);}
 const params={grant_type:'refresh_token',client_id:clientId,refresh_token:r.data.refresh_token,resource};
 const next=await f.request(f.socket,'/token',params);assert.equal(next.status,200,JSON.stringify(next.data));assert.notEqual(next.data.refresh_token,r.data.refresh_token);
 assert.equal((await f.request(f.socket,'/token',params)).status,400);
 await assert.rejects(auth({accessToken:next.data.access_token}));
});
test('two independent providers share persistent state and concurrent code cannot issue twice',async t=>{
 const f=await fixture(t),b=await f.instance(),q=await f.code();
 const results=await Promise.all([f.exchange(q),f.exchange(q,b.socket)]);
 assert.ok(results.filter(x=>x.status===200).length<=1);assert.ok(results.some(x=>x.status===400));
 const next=await f.code();assert.equal((await f.exchange(next,b.socket)).status,200);
});
test('revocation endpoint invalidates opaque access; authorization rejects bad callback and missing PKCE',async t=>{
 const f=await fixture(t),r=await f.exchange(await f.code());assert.equal(r.status,200);
 assert.equal((await f.request(f.socket,'/token/revocation',{client_id:clientId,token:r.data.access_token,token_type_hint:'access_token'})).status,200);
 assert.equal(await f.provider.AccessToken.find(r.data.access_token),undefined);
 const base={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read',resource};
 const bad=await f.request(f.socket,'/auth?'+new URLSearchParams({...base,redirect_uri:'https://evil.invalid'}));assert.equal(bad.status,400);
 const pkce=await f.request(f.socket,'/auth?'+new URLSearchParams(base));assert.ok(pkce.status===400||pkce.headers.location?.includes('error='));
});

test('library authorization -> first-party consent -> callback code -> token, without seeded code',async t=>{
 const f=await fixture(t,{mounted:true}),cookies=new Map();
 const browser=async(path,data)=>{const r=await f.request(f.socket,path,data,{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),origin:issuer});for(const line of r.headers['set-cookie']||[]){const kv=line.split(';')[0],i=kv.indexOf('=');cookies.set(kv.slice(0,i),kv.slice(i+1));}return r;};
 const verifier='x'.repeat(64),params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read generation:write',resource,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:'dummy-state'};
 let r=await browser('/mcp/oauth/auth?'+new URLSearchParams(params));assert.ok(r.headers.location?.includes('/interaction/'),JSON.stringify(r));
 const path=new URL(r.headers.location,issuer).pathname;assert.equal((await browser(path)).status,200);
 r=await browser(path,{csrf:'dummy-csrf',decision:'allow'});assert.equal(r.status,200);
 r=await browser(r.data.match(/href="([^"]+)"/)[1]);
 const callback=new URL(r.headers.location);assert.equal(callback.origin+callback.pathname,redirectUri);assert.equal(callback.searchParams.get('state'),'dummy-state');assert.ok(callback.searchParams.get('code'),JSON.stringify(r));
 const token=await f.request(f.socket,'/mcp/oauth/token',{grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code:callback.searchParams.get('code'),code_verifier:verifier,resource});assert.equal(token.status,200,JSON.stringify(token.data));
 const authenticate=createOpaqueAuthenticator({provider:f.provider,resource,clientId,authorize:async({userId})=>({userId,active:true,emailConfirmed:true,accountStatus:'active',capabilities:['credits:read','generation:write']})});
 const issuedRefresh=await f.provider.RefreshToken.find(token.data.refresh_token);assert.notEqual(issuedRefresh.expiresWithSession,true);
 const context={accessToken:token.data.access_token};let starts=0;
 const core=coreModule.createCore({authenticate,store:storeModule.createMockStore(),integrity:quoteModule.createQuoteIntegrity(Buffer.alloc(32,9)),backend:{readAccess:async userId=>({userId,allowed:true,availableCredits:1000,watermarkRequired:true,models:['bytedance/seedance-2.0']}),start:async()=>{starts++;}},artifactHosts:[]});
 assert.equal((await core.dispatch('pina_get_balance',{},context)).available_credits,1000);
 await assert.rejects(core.dispatch('pina_start_generation',{proposal_id:'unapproved',request_id:'r'},context));assert.equal(starts,0);
 await assert.rejects(core.dispatch('pina_get_balance',{}, {accessToken:'normal.supabase.jwt'}));

});

test('OAuth-only client rejects OpenID GET/POST and refresh scope escalation',async t=>{
 const f=await fixture(t),verifier='q'.repeat(64);
 const params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read openid',resource,prompt:'consent',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:'test'};
 for(const method of ['GET','POST']){
  const r=method==='GET'?await f.request(f.socket,'/auth?'+new URLSearchParams(params)):await f.request(f.socket,'/auth',params);
  if(method==='POST'){assert.equal(r.status,404);continue;}assert.ok(r.headers.location?.startsWith(redirectUri),JSON.stringify(r));assert.equal(new URL(r.headers.location).searchParams.get('error'),'invalid_scope');
 }
 const tokens=await f.exchange(await f.code());assert.equal(tokens.status,200);assert.equal(tokens.data.id_token,undefined);
 for(const scope of ['credits:read openid','credits:read offline_access','credits:read admin']){
  const r=await f.request(f.socket,'/token',{grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.data.refresh_token,resource,scope});assert.equal(r.status,400,JSON.stringify(r));assert.equal(r.data.error,'invalid_scope');
 }
});

// Browser-like path selection: previous harness sent every cookie on every path.
test('mounted auth uses root interaction cookie; nine minute delay expires without grants',async t=>{
 const f=await fixture(t,{mounted:true}),cookies=[];
 const params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read',resource,code_challenge_method:'S256',code_challenge:createHash('sha256').update('x'.repeat(64)).digest('base64url'),state:'dummy'};
 const start=await f.request(f.socket,'/mcp/oauth/auth?'+new URLSearchParams(params));
 const path=new URL(start.headers.location,issuer).pathname;
 assert.match(path,/^\/interaction\/[A-Za-z0-9_-]+$/);
 for(const line of start.headers['set-cookie']||[]){const parts=line.split(';').map(x=>x.trim());cookies.push({pair:parts[0],path:parts.find(x=>/^path=/i.test(x))?.slice(5)||'/',expires:parts.find(x=>/^expires=/i.test(x))?.slice(8)});}
 const interactionCookies=cookies.filter(c=>c.path===path);assert.ok(interactionCookies.length);assert.ok(interactionCookies.some(c=>Math.abs(Date.parse(c.expires)-Date.now()-300000)<2000));
 assert.ok(cookies.some(c=>c.path.startsWith('/mcp/oauth/auth/')));
 const cookie=interactionCookies.map(c=>c.pair).join('; ');
 const fresh=await f.request(f.socket,path,null,{cookie});assert.equal(fresh.status,200);
 // Cookie absent (browser expiry / cleared cookie) and expired persisted state.
 const missing=await f.request(f.socket,path);assert.equal(missing.status,403);assert.match(missing.data,/有効期限/);
 const realNow=Date.now;try{const later=realNow()+9*60*1000;Date.now=()=>later;
  const expired=await f.request(f.socket,path,null,{cookie});assert.equal(expired.status,403);assert.match(expired.data,/ChatGPTに戻り/);
  assert.doesNotMatch(expired.data,/<form|csrf|decision/);
  const denied=await f.request(f.socket,path,{csrf:'dummy-csrf',decision:'allow'},{cookie,origin:issuer});assert.equal(denied.status,403);assert.equal(denied.data,'interaction_denied');
 }finally{Date.now=realNow;}
});

for(const cold of [false,true])for(const [detachSocket,invalidateInteraction] of [[false,false],[true,false],[true,true]])test('mounted Vercel helper semantics: consent resumes OAuth; cold='+cold+' detached='+detachSocket+' invalidated='+invalidateInteraction,async t=>{
 const f=await fixture(t,{mounted:true,vercelHelpers:true,cold,detachSocket,invalidateInteraction}),cookies=new Map();
 const browser=async(path,data)=>{const cookie=[...cookies.values()].filter(c=>path.split('?')[0]===c.path||path.startsWith(c.path.endsWith('/')?c.path:c.path+'/')).map(c=>c.pair).join('; ');const r=await f.request(f.socket,path,data,{cookie,origin:issuer});
  for(const line of r.headers['set-cookie']||[]){const parts=line.split(';').map(s=>s.trim()),pair=parts[0],name=pair.slice(0,pair.indexOf('=')),path=parts.find(x=>/^path=/i.test(x))?.slice(5)||'/';cookies.set(name+path,{pair,path});}return r;};
 const verifier='x'.repeat(64),params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read',resource,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:'dummy-state'};
 let r=await browser('/mcp/oauth/auth?'+new URLSearchParams(params));const path=new URL(r.headers.location,issuer).pathname;
 assert.match(path,/^\/interaction\//);assert.equal((await browser(path)).status,200);
 r=await browser(path,{csrf:'dummy-csrf',decision:'allow'});if(invalidateInteraction){assert.equal(r.status,403);assert.equal(r.data,'interaction_denied');assert.equal(r.headers.location,undefined);return;}assert.equal(r.status,200);assert.equal(r.headers.location,undefined);assert.equal(r.headers['referrer-policy'],'no-referrer');
 const resume=new URL(r.data.match(/href="([^"]+)"/)[1],issuer);assert.match(resume.pathname,/^\/mcp\/oauth\/auth\//);
 r=await browser(resume.pathname+resume.search);assert.equal(r.status,303);const callback=new URL(r.headers.location);assert.equal(callback.origin+callback.pathname,redirectUri);assert.equal(callback.searchParams.get('state'),'dummy-state');assert.ok(callback.searchParams.get('code'));
 r=await f.request(f.socket,'/mcp/oauth/token',{grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code:callback.searchParams.get('code'),code_verifier:verifier,resource});assert.equal(r.status,200);assert.ok(r.data.access_token);assert.equal(r.data.id_token,undefined);
});

for(const scenario of ['deny','expired','double-click','parallel-click'])test('explicit continuation preserves provider '+scenario+' behavior',async t=>{
 const f=await fixture(t,{mounted:true}),cookies=new Map();
 const browser=async(path,data)=>{const r=await f.request(f.socket,path,data,{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),origin:issuer});for(const line of r.headers['set-cookie']||[]){const kv=line.split(';')[0],i=kv.indexOf('=');cookies.set(kv.slice(0,i),kv.slice(i+1));}return r;};
 const params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read',resource,code_challenge_method:'S256',code_challenge:createHash('sha256').update('x'.repeat(64)).digest('base64url'),state:'dummy-state'};
 const start=await browser('/mcp/oauth/auth?'+new URLSearchParams(params)),path=new URL(start.headers.location,issuer).pathname;
 const saved=await browser(path,{csrf:'dummy-csrf',decision:scenario==='deny'?'deny':'allow'});assert.equal(saved.status,200);assert.equal(saved.headers.location,undefined);
 const resume=saved.data.match(/href="([^"]+)"/)[1];
 if(scenario==='expired'){const adapter=new f.store.Adapter('Interaction'),uid=path.split('/').pop(),row=await adapter.find(uid);await adapter.upsert(uid,row,-1);const r=await browser(resume);assert.equal(r.status,400);assert.equal(r.headers.location,undefined);return;}
 if(scenario==='parallel-click'){const results=await Promise.all([browser(resume),browser(resume)]);assert.deepEqual(results.map(x=>x.status).sort(),[303,400]);assert.equal(results.filter(x=>x.headers.location&&new URL(x.headers.location).searchParams.has('code')).length,1);return;}
 const r=await browser(resume);assert.equal(r.status,303);const callback=new URL(r.headers.location);assert.equal(callback.origin+callback.pathname,redirectUri);
 if(scenario==='deny'){assert.equal(callback.searchParams.get('error'),'access_denied');assert.equal(callback.searchParams.has('code'),false);return;}
 assert.ok(callback.searchParams.get('code'));const again=await browser(resume);assert.equal(again.status,400);assert.equal(again.headers.location,undefined);
});


async function persistentConnection(f){
 const cookies=new Map(),browser=async(path,data)=>{const r=await f.request(f.socket,path,data,{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),origin:issuer});for(const line of r.headers['set-cookie']||[]){const kv=line.split(';')[0],i=kv.indexOf('=');cookies.set(kv.slice(0,i),kv.slice(i+1));}return r;};
 const verifier='p'.repeat(64),params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read',resource,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:'dummy'};
 let r=await browser('/mcp/oauth/auth?'+new URLSearchParams(params));const path=new URL(r.headers.location,issuer).pathname;assert.equal((await browser(path)).status,200);r=await browser(path,{csrf:'dummy-csrf',decision:'allow'});assert.equal(r.status,200);r=await browser(r.data.match(/href="([^"]+)"/)[1]);
 const callback=new URL(r.headers.location);const response=await f.request(f.socket,'/mcp/oauth/token',{grant_type:'authorization_code',client_id:clientId,redirect_uri:redirectUri,code:callback.searchParams.get('code'),code_verifier:verifier,resource});assert.equal(response.status,200);return response.data;
}
const refreshPersistent=(f,token,extra={})=>f.request(f.socket,'/mcp/oauth/token',{grant_type:'refresh_token',client_id:clientId,refresh_token:token,resource,...extra});
test('real browser grant survives session removal/restart, refreshes after1h and fails7d idle',async t=>{
 const f=await fixture(t,{mounted:true}),tokens=await persistentConnection(f),record=await f.provider.RefreshToken.find(tokens.refresh_token);assert.notEqual(record.expiresWithSession,true);
 const session=record.sessionUid&&await f.provider.Session.findByUid(record.sessionUid);if(session)await session.destroy();
 const realNow=Date.now,base=realNow();try{Date.now=()=>base+2*3600*1000;const b=await f.instance();let r=await f.request(b.socket,'/mcp/oauth/token',{grant_type:'refresh_token',client_id:clientId,refresh_token:tokens.refresh_token,resource});assert.equal(r.status,200);
  const last=r.data.refresh_token;Date.now=()=>base+(2*3600+7*86400+1)*1000;r=await refreshPersistent(f,last);assert.equal(r.status,400);assert.equal(r.data.error,'invalid_grant');
 }finally{Date.now=realNow;}
});
test('rotated refresh never extends absolute30d grant; reconnect creates new consent',async t=>{
 const f=await fixture(t,{mounted:true});let tokens=await persistentConnection(f);const first=await f.provider.RefreshToken.find(tokens.refresh_token),grant=await f.provider.Grant.find(first.grantId),deadline=grant.exp,realNow=Date.now,base=realNow();
 try{for(const day of [6,12,18,24,29]){Date.now=()=>base+day*86400000;const r=await refreshPersistent(f,tokens.refresh_token);assert.equal(r.status,200);tokens=r.data;const g=await f.provider.Grant.find(first.grantId);await g.save();assert.equal((await f.provider.Grant.find(first.grantId)).exp,deadline);const rt=await f.provider.RefreshToken.find(tokens.refresh_token);assert.ok(rt.exp<=first.iiat+30*86400);}
  Date.now=()=>base+30*86400000+1000;const denied=await refreshPersistent(f,tokens.refresh_token);assert.equal(denied.status,400);assert.equal(denied.data.error,'invalid_grant');
  const fresh=await persistentConnection(f),newRecord=await f.provider.RefreshToken.find(fresh.refresh_token);assert.notEqual(newRecord.grantId,first.grantId);
 }finally{Date.now=realNow;}
});
test('existing1h grant keeps its deadline, no automatic extension on save or refresh',async t=>{
 const f=await fixture(t,{mounted:true}),tokens=await persistentConnection(f),rt=await f.provider.RefreshToken.find(tokens.refresh_token),g=await f.provider.Grant.find(rt.grantId);const realNow=Date.now,base=realNow();g.exp=Math.floor(base/1000)+3600;await g.save();const deadline=g.exp;
 try{Date.now=()=>base+28*60000;const r=await refreshPersistent(f,tokens.refresh_token);assert.equal(r.status,200);const old=await f.provider.Grant.find(rt.grantId);await old.save();assert.equal(old.exp,deadline);Date.now=()=>base+61*60000;assert.equal((await refreshPersistent(f,r.data.refresh_token)).status,400);}finally{Date.now=realNow;}
});
test('persistent refresh retains client binding, rotation replay revocation and explicit revoke',async t=>{
 const f=await fixture(t,{mounted:true}),tokens=await persistentConnection(f);
 assert.equal((await refreshPersistent(f,tokens.refresh_token,{client_id:'different-client'})).status,401);
 const rotated=await refreshPersistent(f,tokens.refresh_token);assert.equal(rotated.status,200);assert.equal((await refreshPersistent(f,tokens.refresh_token)).status,400);assert.equal(await f.provider.AccessToken.find(rotated.data.access_token),undefined);
 const fresh=await persistentConnection(f);assert.equal((await f.request(f.socket,'/mcp/oauth/token/revocation',{client_id:clientId,token:fresh.refresh_token,token_type_hint:'refresh_token'})).status,200);assert.equal((await refreshPersistent(f,fresh.refresh_token)).status,400);
});
