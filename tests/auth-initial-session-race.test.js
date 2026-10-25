'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createClient}=require('@supabase/supabase-js');
const source=fs.readFileSync('auth-guard.js','utf8');
test('real SDK recovers an existing confirmed session on page startup without false blocking',async()=>{
 const user={id:'synthetic-user',email_confirmed_at:'2026-01-01T00:00:00Z'};
 const stored={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Math.floor(Date.now()/1000)+3600,token_type:'bearer',user};
 const map=new Map([['sb-local-test-auth-token',JSON.stringify(stored)]]);const calls=[],events=[];
 const client=createClient('https://local-test.supabase.co','synthetic-public',{auth:{autoRefreshToken:false,detectSessionInUrl:false,storage:{getItem:async key=>{await new Promise(setImmediate);return map.get(key)||null},setItem:(key,v)=>map.set(key,v),removeItem:key=>map.delete(key)}},global:{fetch:async(url)=>{calls.push(new URL(url).pathname);assert.equal(new URL(url).pathname,'/auth/v1/user');return new Response(JSON.stringify(user),{status:200,headers:{'Content-Type':'application/json'}})}}});
 const window={};vm.runInNewContext(source,{window,WeakMap,Set,setTimeout,clearTimeout,location:{replace(){assert.fail('redirect')}}});
 client.auth.onAuthStateChange(event=>events.push(event));
 const result=await window.FlowVidAuthGuard.verify(client);
 assert.equal(result.state,'confirmed',JSON.stringify(events));
 assert.equal(result.user.id,user.id);assert.equal(calls.length,1);
});
function guardHarness(){
 const window={},events=[];const client={auth:{onAuthStateChange:fn=>events.push(fn),getSession:async()=>({data:{session:{access_token:'synthetic-access',user:{id:'u'}}}}),getUser:async()=>({data:{user:{id:'u',confirmed_at:'yes'}}})}};
 vm.runInNewContext(source,{window,WeakMap,Set,setTimeout,clearTimeout,location:{replace(){assert.fail('unexpected redirect')}}});return {guard:window.FlowVidAuthGuard,client,events};
}
test('same-session SIGNED_IN while checking is accepted, other token/account or logout is rejected',async()=>{
 for(const [event,session,expected] of [['SIGNED_IN',{access_token:'synthetic-access',user:{id:'u'}},'confirmed'],['SIGNED_IN',{access_token:'different',user:{id:'u'}},'unavailable'],['SIGNED_IN',{access_token:'synthetic-access',user:{id:'other'}},'unavailable'],['SIGNED_OUT',null,'unavailable']]){
 const h=guardHarness();let release;h.client.auth.getUser=()=>new Promise(resolve=>{release=resolve});const pending=h.guard.verify(h.client);await new Promise(setImmediate);h.events[0](event,session);release({data:{user:{id:'u',confirmed_at:'yes'}}});assert.equal((await pending).state,expected);
 }
});
test('normal refresh following prior sign-in is not rejected by stale event identity',async()=>{
 const h=guardHarness();await h.guard.verify(h.client);h.events[0]('SIGNED_IN',{access_token:'synthetic-access',user:{id:'u'}});
 h.client.auth.getSession=async()=>{h.events[0]('TOKEN_REFRESHED');return {data:{session:{access_token:'synthetic-new',user:{id:'u'}}}}};assert.equal((await h.guard.verify(h.client)).state,'confirmed');
});
test('profile startup with SDK-style initial and sign-in events settles without deadlock or unbounded reentry',async()=>{
 const events=[],window={},timers=[],state={loads:0,redirects:0};
 const session={access_token:'synthetic',user:{id:'u'}};let initial=true;
 const client={auth:{onAuthStateChange:fn=>events.push(fn),getSession:async()=>{if(initial){initial=false;await new Promise(setImmediate);for(const fn of events)fn('SIGNED_IN',session);for(const fn of events)fn('INITIAL_SESSION',session)}return {data:{session}}},getUser:async()=>({data:{user:{id:'u',confirmed_at:'yes'}}})}};
 const ctx={window,WeakMap,Set,setTimeout:(fn,ms)=>{if(ms===0){timers.push(fn);return 0}return setTimeout(fn,ms)},clearTimeout,client,authReady:true,loadDb:async()=>{state.loads++;return {}},checkoutRequested:()=>false,showGuest(){},location:{replace:()=>state.redirects++}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 const html=fs.readFileSync('profile.html','utf8');vm.runInContext(html.slice(html.indexOf('let _profileAuthCheckRunning='),html.indexOf('// ---- 生成履歴セクション ----')),ctx);
 await new Promise(setImmediate);await new Promise(setImmediate);
 let drained=0;while(timers.length){assert.ok(++drained<=4);timers.shift()();await new Promise(setImmediate)}
 assert.ok(state.loads>=1&&state.loads<=3);assert.equal(state.redirects,0);assert.equal(vm.runInContext('_profileAuthCheckRunning',ctx),false);
});
test('startup sign-in followed by normal refresh verifies the refreshed session',async()=>{
 const h=guardHarness();
 h.client.auth.getSession=async()=>{
  h.events[0]('SIGNED_IN',{access_token:'synthetic-old',user:{id:'u'}});
  const session={access_token:'synthetic-new',user:{id:'u'}};
  h.events[0]('TOKEN_REFRESHED',session);
  return {data:{session}};
 };
 h.client.auth.getUser=async token=>{assert.equal(token,'synthetic-new');return {data:{user:{id:'u',confirmed_at:'yes'}}}};
 assert.equal((await h.guard.verify(h.client)).state,'confirmed');
});
test('refresh/account change while getUser is pending fails closed and next check can recover',async()=>{
 const h=guardHarness();let release;
 h.client.auth.getUser=()=>new Promise(resolve=>{release=resolve});
 const pending=h.guard.verify(h.client);await new Promise(setImmediate);
 h.events[0]('TOKEN_REFRESHED',{access_token:'synthetic-new',user:{id:'u'}});
 release({data:{user:{id:'u',confirmed_at:'yes'}}});
 assert.equal((await pending).state,'unavailable');
 h.client.auth.getSession=async()=>({data:{session:{access_token:'synthetic-new',user:{id:'u'}}}});
 h.client.auth.getUser=async()=>({data:{user:{id:'u',confirmed_at:'yes'}}});
 assert.equal((await h.guard.verify(h.client)).state,'confirmed');
});
