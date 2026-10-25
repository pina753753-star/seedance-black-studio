'use strict';
const test=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('auth-guard.js','utf8');
function harness() {
 const redirects=[], calls={signOut:0,session:0,user:0}, events=[];
 const window={}; const client={auth:{onAuthStateChange:fn=>events.push(fn),getSession:async()=>{calls.session++;return {data:{session:{access_token:'synthetic',user:{id:'user'}}}}},getUser:async()=>{calls.user++;return {data:{user:{id:'user',email_confirmed_at:'synthetic'}}}},signOut:async()=>calls.signOut++}};
 vm.runInNewContext(source,{window,WeakMap,Set,setTimeout,clearTimeout,location:{replace:x=>redirects.push(x)}});
 return {guard:window.FlowVidAuthGuard,client,calls,redirects,events};
}
for(const stage of ['getSession','getUser'])test(stage+' transient and unknown failures retain sessions but grant nothing',async()=>{
 for(const error of [{name:'AuthRetryableFetchError',status:0},{name:'AuthApiError',status:429},{name:'AuthApiError',status:503},{name:'AuthApiError',status:401},{name:'AuthApiError',code:'bad_jwt',status:401},new Error('unknown')]){
 const h=harness();h.client.auth[stage]=async()=>({error,data:{}});
 assert.equal(await h.guard.requireConfirmedUser(h.client),null);assert.equal(h.calls.signOut,0);assert.equal(h.redirects.length,0);
 await assert.rejects(h.guard.getVerifiedToken(h.client),{name:'AuthVerificationUnavailable'});
 }
});
test('confirmed session passes server-verified user and token; refresh result works without global logout',async()=>{
 const h=harness();assert.equal((await h.guard.requireConfirmedUser(h.client)).id,'user');assert.equal(await h.guard.getVerifiedToken(h.client),'synthetic');assert.equal(h.calls.signOut,0);
});
test('explicit invalid session, missing session and unconfirmed email deny without global signout',async()=>{
 for(const kind of ['missing','invalid','unconfirmed']){const h=harness();
 if(kind==='missing')h.client.auth.getSession=async()=>({data:{session:null}});
 if(kind==='invalid')h.client.auth.getUser=async()=>({error:{name:'AuthApiError',code:'session_not_found',status:401}});
 if(kind==='unconfirmed')h.client.auth.getUser=async()=>({data:{user:{id:'user'}}});
 assert.equal(await h.guard.requireConfirmedUser(h.client),null);assert.equal(h.calls.signOut,0);assert.equal(h.redirects.length,1);
 }
});
test('concurrent checks share one request and transient recovery permits later retry',async()=>{
 const h=harness();let release;h.client.auth.getUser=()=>{h.calls.user++;return new Promise(resolve=>{release=resolve})};
 const a=h.guard.verify(h.client),b=h.guard.verify(h.client);await new Promise(setImmediate);release({error:{name:'AuthRetryableFetchError'}});
 assert.equal((await a).state,'unavailable');assert.equal((await b).state,'unavailable');assert.equal(h.calls.user,1);
 h.client.auth.getUser=async()=>({data:{user:{id:'user',confirmed_at:'yes'}}});assert.equal((await h.guard.verify(h.client)).state,'confirmed');
});
test('cross-tab logout or user change invalidates an in-flight successful result',async()=>{
 for(const event of ['SIGNED_OUT','SIGNED_IN','USER_UPDATED']){const h=harness();let release;
 h.client.auth.getUser=()=>new Promise(resolve=>{release=resolve});const pending=h.guard.verify(h.client);await new Promise(setImmediate);
 h.events[0](event);release({data:{user:{id:'user',confirmed_at:'yes'}}});assert.equal((await pending).state,'unavailable');assert.equal(h.calls.signOut,0);}
});
test('one tab encountering transient error cannot sign out another tab',async()=>{
 const a=harness(),b=harness();a.client.auth.getUser=async()=>{throw new Error('network')};
 assert.equal(await a.guard.requireConfirmedUser(a.client),null);assert.equal((await b.guard.requireConfirmedUser(b.client)).id,'user');assert.equal(a.calls.signOut+b.calls.signOut,0);
});
test('unmatched stored user and remotely verified user never grant token',async()=>{
 const h=harness();h.client.auth.getUser=async()=>({data:{user:{id:'different',confirmed_at:'yes'}}});await assert.rejects(h.guard.getVerifiedToken(h.client));assert.equal(h.redirects.length,0);
});
test('generation getToken propagates unavailable rather than converting it into login redirect',async()=>{
 const html=fs.readFileSync('generate-prod.html','utf8');const fn=html.match(/async function getToken\(\)\{[^\n]+/)[0];const redirects=[];
 const ctx={window:{FlowVidAuthGuard:{getVerifiedToken:async()=>{throw Object.assign(new Error(),{name:'AuthVerificationUnavailable'})}},flowvidSupabaseClient:()=>({})},location:{set href(x){redirects.push(x)}}};vm.createContext(ctx);vm.runInContext(fn,ctx);await assert.rejects(ctx.getToken());assert.equal(redirects.length,0);
});
test('explicit logout remains unchanged and guarded page scripts remain valid',()=>{
 assert.match(fs.readFileSync('logout.html','utf8'),/await client.auth.signOut\(\)/);
 for(const file of ['generate-prod.html','profile.html','login.html','h3-live.html','cancel-subscription.html']){
 for(const match of fs.readFileSync(file,'utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(match[1]);
 }
});

test('SDK normal getSession refresh event preserves a valid newly verified session',async()=>{
 const h=harness();h.client.auth.getSession=async()=>{h.events[0]('TOKEN_REFRESHED');return {data:{session:{access_token:'refreshed-synthetic',user:{id:'user'}}}}};
 assert.equal(await h.guard.getVerifiedToken(h.client),'refreshed-synthetic');assert.equal(h.calls.signOut,0);assert.equal(h.redirects.length,0);
});
test('server auth denies transient failures with503, definitive invalid JWT with401, and unconfirmed with403',async()=>{
 const code=fs.readFileSync('api/_lib/confirmed-auth.js','utf8');
 for(const [result,status] of [[{error:{name:'AuthRetryableFetchError',status:0}},503],[{error:{name:'AuthApiError',status:429}},503],[{error:{name:'AuthApiError',status:503}},503],[{error:{name:'AuthApiError',status:401}},503],[{error:{name:'AuthApiError',code:'bad_jwt',status:401}},401],[{data:{user:{id:'user'}}},403],[{data:{user:{id:'user',confirmed_at:'yes'}}},undefined]]){
 const module={exports:{}};vm.runInNewContext(code,{module,process:{env:{SUPABASE_SERVICE_ROLE_KEY:'synthetic'}},require:()=>({createClient:()=>({auth:{getUser:async()=>result}})})});
 const response=await module.exports.requireConfirmedAuth({headers:{authorization:'Bearer synthetic'}});assert.equal(response.status,status);assert.equal(response.ok,status===undefined);
 if(status)assert.equal(response.user,undefined);
 }
});
test('blocked page is inert and retry double-click sends one check; recovery reloads instead of replaying protected action',async()=>{
 const nodes=new Map(),content={inert:false};
 const make=()=>({style:{},children:[],setAttribute(){},append(...xs){this.children.push(...xs)},focus(){}});
 const body={children:[content],append(node){this.children.push(node);nodes.set(node.id,node)}};
 const window={},redirects=[];let reloads=0,calls=0,release;
 const client={auth:{getSession:()=>{calls++;return new Promise(resolve=>{release=resolve})},getUser:async()=>({data:{user:{id:'u',confirmed_at:'yes'}}})}};
 vm.runInNewContext(source,{window,WeakMap,Set,setTimeout,clearTimeout,document:{body,getElementById:id=>nodes.get(id),createElement:make},location:{replace:x=>redirects.push(x),reload:()=>reloads++}});
 window.FlowVidAuthGuard.showUnavailable(client);window.FlowVidAuthGuard.showUnavailable(client);
 assert.equal(body.children.length,2);assert.equal(content.inert,true);
 const retry=nodes.get('authConnectionBlocked').children[1];const first=retry.onclick();await retry.onclick();assert.equal(calls,1);
 release({data:{session:{access_token:'synthetic',user:{id:'u'}}}});await first;
 assert.equal(reloads,1);assert.equal(redirects.length,0);
});
test('hung auth lookup times out fail-closed and late completion cannot grant a token',async()=>{
 let timeout,release;const window={},callbacks=[];const client={auth:{getSession:async()=>({data:{session:{access_token:'synthetic',user:{id:'u'}}}}),getUser:()=>new Promise(resolve=>{release=resolve})}};
 vm.runInNewContext(source,{window,WeakMap,Set,setTimeout:fn=>{timeout=fn;return 1},clearTimeout(){},location:{replace:x=>callbacks.push(x)}});
 const pending=window.FlowVidAuthGuard.verify(client);await new Promise(setImmediate);timeout();assert.equal((await pending).state,'unavailable');
 release({data:{user:{id:'u',confirmed_at:'yes'}}});await new Promise(setImmediate);assert.equal(callbacks.length,0);
 client.auth.getUser=async()=>({data:{user:{id:'u',confirmed_at:'yes'}}});assert.equal((await window.FlowVidAuthGuard.verify(client)).state,'confirmed');
});
