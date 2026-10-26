import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createBrokerInteraction} from '../broker-interaction.mjs';
function fixture(){
 const state={finished:[],saved:0,user:{userId:'alice',emailConfirmed:true,accountStatus:'active'},details:{uid:'interaction',params:{client_id:'pina',resource:'https://pina.invalid/mcp',scope:'credits:read generation:write'}}};
 const provider={interactionDetails:async()=>state.details,interactionFinished:async(req,res,result)=>{state.finished.push(result);res.end('finished');},Grant:class{constructor(p){this.params=p;}addResourceScope(){}addOIDCScope(){}async save(){state.saved++;return 'grant';}}};
 const handler=createBrokerInteraction({provider,origin:'https://pina.invalid',clientId:'pina',resource:'https://pina.invalid/mcp',verifyPinaBrowserSession:async()=>state.user,issueCsrf:async()=>'<dummy>',verifyCsrf:async(v,b)=>v==='dummy'&&b.userId==='alice'&&b.interactionId==='interaction'});
 async function call({method='POST',origin='https://pina.invalid',body='csrf=dummy&decision=allow'}={}){const req=Readable.from([body]);req.method=method;req.headers={origin,'content-type':'application/x-www-form-urlencoded'};const res={status:200,writeHead(s,h){this.status=s;this.headers=h;},end(body){this.body=body;}};await handler(req,res);return res;}
 return {state,call};
}
test('first party consent requires session, CSRF, Origin and correct client/resource/account',async()=>{
 for(const change of [f=>f.state.user=null,f=>f.state.user.emailConfirmed=false,f=>f.state.details.params.client_id='other',f=>f.state.details.params.resource='https://evil.invalid',f=>f.state.details.session={accountId:'bob'}]){const f=fixture();change(f);assert.equal((await f.call()).status,403);assert.equal(f.state.saved,0);}
 for(const args of [{origin:'https://evil.invalid'},{body:'csrf=wrong&decision=allow'},{body:'csrf=dummy&decision=allow&userId=bob'},{body:'csrf=dummy&decision=allow&csrf=dummy'}]){const f=fixture();assert.equal((await f.call(args)).status,403);assert.equal(f.state.saved,0);}
});
test('safe consent HTML has no purchase links; allow creates grant, deny creates none',async()=>{
 const f=fixture(),page=await f.call({method:'GET'});assert.equal(page.status,200);assert.match(page.body,/&lt;dummy&gt;/);assert.match(page.body,/接続するアカウント: alice/);assert.match(page.body,/mcp-session.html/);assert.doesNotMatch(page.body,/checkout|pricing\.html|アップグレード/);assert.equal(f.state.saved,0);
 await f.call();assert.equal(f.state.saved,1);assert.equal(f.state.finished[0].login.accountId,'alice');
 const denied=fixture();await denied.call({body:'csrf=dummy&decision=deny'});assert.equal(denied.state.saved,0);assert.equal(denied.state.finished[0].error,'access_denied');
});
test('first-party consent never grants unsupported OpenID or offline scopes',async()=>{
 for(const scope of ['credits:read openid','credits:read offline_access','credits:read admin']){
  const f=fixture();f.state.details.params.scope=scope;assert.equal((await f.call()).status,403);assert.equal(f.state.saved,0);assert.equal(f.state.finished.length,0);
 }
});
