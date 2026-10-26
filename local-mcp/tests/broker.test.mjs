import test from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import http from 'node:http';
import coreModule from '../core.js';import storeModule from '../mock-store.js';import quoteModule from '../quote-integrity.js';
import {createBrokerInteraction} from '../broker-interaction.mjs';
import {createBrokerStore} from '../broker-sqlite.mjs';import {createBroker,createOpaqueAuthenticator} from '../broker.mjs';
const issuer='https://broker.example.invalid',resource='https://pina.example.invalid/api/mcp',clientId='pina-test',redirectUri='https://chatgpt.example.invalid/callback',owner='dummy-user';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'pina-broker-')),key=Buffer.alloc(32,3),file=join(dir,'state.sqlite');
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwks={keys:[{...privateKey.export({format:'jwk'}),kid:'dummy',alg:'RS256',use:'sig'}]};
 const stores=[],servers=[];
 const instance=async()=>{const store=createBrokerStore(file,key);stores.push(store);const provider=createBroker({issuer,resource,clientId,redirectUri,Adapter:store.Adapter,cookieKeys:['test-only-cookie-material'],jwks,findAccount:async(ctx,id)=>id===owner?{accountId:id,claims:async()=>({sub:id})}:undefined});const interaction=createBrokerInteraction({provider,origin:issuer,clientId,resource,verifyPinaBrowserSession:async()=>({userId:owner,emailConfirmed:true,accountStatus:'active'}),issueCsrf:async()=> 'dummy-csrf',verifyCsrf:async value=>value==='dummy-csrf'});const callback=provider.callback();const server=http.createServer((req,res)=>req.url.startsWith('/interaction/')?interaction(req,res):callback(req,res));servers.push(server);const socket=join(dir,'s'+servers.length);await new Promise(r=>server.listen(socket,r));return {provider,store,socket};};
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
 const f=await fixture(t),cookies=new Map();
 const browser=async(path,data)=>{const r=await f.request(f.socket,path,data,{cookie:[...cookies].map(([k,v])=>k+'='+v).join('; '),origin:issuer});for(const line of r.headers['set-cookie']||[]){const kv=line.split(';')[0],i=kv.indexOf('=');cookies.set(kv.slice(0,i),kv.slice(i+1));}return r;};
 const verifier='x'.repeat(64),params={client_id:clientId,response_type:'code',redirect_uri:redirectUri,scope:'credits:read generation:write',resource,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:'dummy-state'};
 let r=await browser('/auth?'+new URLSearchParams(params));assert.ok(r.headers.location?.includes('/interaction/'),JSON.stringify(r));
 const path=new URL(r.headers.location,issuer).pathname;assert.equal((await browser(path)).status,200);
 r=await browser(path,{csrf:'dummy-csrf',decision:'allow'});assert.ok(r.headers.location);
 r=await browser(new URL(r.headers.location,issuer).pathname+new URL(r.headers.location,issuer).search);
 const callback=new URL(r.headers.location);assert.equal(callback.origin+callback.pathname,redirectUri);assert.equal(callback.searchParams.get('state'),'dummy-state');assert.ok(callback.searchParams.get('code'),JSON.stringify(r));
 const token=await f.exchange({code:callback.searchParams.get('code'),verifier});assert.equal(token.status,200,JSON.stringify(token.data));
 const authenticate=createOpaqueAuthenticator({provider:f.provider,resource,clientId,authorize:async({userId})=>({userId,active:true,emailConfirmed:true,accountStatus:'active',capabilities:['credits:read','generation:write']})});
 const context={accessToken:token.data.access_token};let starts=0;
 const core=coreModule.createCore({authenticate,store:storeModule.createMockStore(),integrity:quoteModule.createQuoteIntegrity(Buffer.alloc(32,9)),backend:{readAccess:async userId=>({userId,allowed:true,availableCredits:1000,watermarkRequired:true,models:['bytedance/seedance-2.0']}),start:async()=>{starts++;}},artifactHosts:[]});
 assert.equal((await core.dispatch('pina_get_balance',{},context)).available_credits,1000);
 await assert.rejects(core.dispatch('pina_start_generation',{proposal_id:'unapproved',request_id:'r'},context));assert.equal(starts,0);
 await assert.rejects(core.dispatch('pina_get_balance',{}, {accessToken:'normal.supabase.jwt'}));

});
