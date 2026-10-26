'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const policy=require('../../mcp-return');
const approval='/mcp/approve?proposal_id=00000000-0000-4000-8000-000000000001';
test('login return permits only exact local interaction and proposal paths',()=>{
 for(const next of ['/interaction/test_123-A',approval]){
  const search='?mcpNext='+encodeURIComponent(next);
  assert.equal(policy.loginTarget(search),'/mcp-session.html?next='+encodeURIComponent(next));
 }
 for(const next of ['https://evil.invalid','//evil.invalid','/\\evil.invalid','/profile.html','/interaction/x?token=secret','/interaction/x#secret','/interaction/../profile','/interaction/%78','/interaction/x\n',approval+'&token=secret',approval+'#secret','/mcp/approve?proposal_id=%31','/interaction/'+'a'.repeat(129)])assert.equal(policy.loginTarget('?mcpNext='+encodeURIComponent(next)),'./profile.html');
 assert.equal(policy.loginTarget('?mcpNext=/interaction/x&mcpNext=/interaction/y'),'./profile.html');
 assert.equal(policy.loginTarget(''),'./profile.html');
});
test('session builds same-tab login round trip and requires explicit identity confirmation',async()=>{
 const elements={message:{},continue:{},login:{}};let verified=0,posted=0,replaced;
 const context={URLSearchParams,window:{PinaMcpReturn:policy,FLOWVID_AUTH:{supabaseUrl:'dummy',supabaseAnonKey:'dummy'},supabase:{createClient:()=>({})},FlowVidAuthGuard:{verify:async()=>{verified++;return {state:'confirmed',token:'dummy-test-only'};}}},document:{getElementById:id=>elements[id]},location:{search:'?next='+encodeURIComponent(approval),replace:value=>replaced=value},fetch:async(path,opts)=>{posted++;assert.equal(path,'/mcp/browser-session');assert.equal(opts.redirect,'error');return {ok:true};}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../../mcp-session.js'),'utf8'),context);
 assert.equal(verified,0);assert.equal(posted,0);assert.equal(elements.login.href,'/login.html?mcpNext='+encodeURIComponent(approval));
 assert.equal(policy.loginTarget(new URL('https://pina.invalid'+elements.login.href).search),'/mcp-session.html?next='+encodeURIComponent(approval));
 await elements.continue.onclick();assert.equal(verified,1);assert.equal(posted,1);assert.equal(replaced,approval);
});
test('malicious or duplicate session next disables continuation without a login return target',()=>{
 for(const search of ['?next=https://evil.invalid','?next=/interaction/x&next=/interaction/y','?next=/interaction/x%3Ftoken%3Dsecret']){
  const els={message:{},continue:{},login:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../mcp-session.js'),'utf8'),{window:{PinaMcpReturn:policy},document:{getElementById:id=>els[id]},location:{search}});
  assert.equal(els.continue.disabled,true);assert.equal(els.login.href,undefined);
 }
});
test('login success and existing confirmed session both use validated destination; ordinary signup stays unchanged',()=>{
 const html=fs.readFileSync(require.resolve('../../login.html'),'utf8');
 assert.match(html,/location.replace\(loginDestination\)/);assert.match(html,/location.href=loginDestination/);
 assert.ok(html.indexOf('const loginDestination=')<html.indexOf('showRedirectMessage();'));
 assert.match(html,/emailRedirectTo:'https:\/\/www.pinastudio.jp\/profile.html'/);
 const session=fs.readFileSync(require.resolve('../../mcp-session.html'),'utf8');assert.doesNotMatch(session,/target="_blank"/);assert.match(session,/id="login"/);
});
