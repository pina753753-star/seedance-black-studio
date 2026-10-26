import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createBrokerInteraction} from '../broker-interaction.mjs';
function fixture(){
 const state={finished:[],saved:0,user:{userId:'alice',emailConfirmed:true,accountStatus:'active'},diagnostics:[],details:{uid:'interaction',params:{client_id:'pina',resource:'https://pina.invalid/mcp',scope:'credits:read generation:write'}}};
 const provider={interactionDetails:async()=>state.details,interactionResult:async(req,res,result)=>{if(state.finishHeadersSent){res.headersSent=true;res.writableEnded=state.finishEnded;throw Object.assign(new Error('private header details'),{code:'ERR_HTTP_HEADERS_SENT'});}if(state.finishError)throw new Error('dummy persistence failure');state.finished.push(result);return 'https://pina.invalid/mcp/oauth/auth/dummy';},Grant:class{constructor(p){this.params=p;}addResourceScope(){}addOIDCScope(){}async save(){state.saved++;return 'grant';}}};
 const handler=createBrokerInteraction({provider,origin:'https://pina.invalid',clientId:'pina',resource:'https://pina.invalid/mcp',verifyPinaBrowserSession:async()=>state.user,issueCsrf:async()=>'<dummy>',verifyCsrf:async(v,b)=>v==='dummy'&&b.userId==='alice'&&b.interactionId==='interaction',diagnostic:code=>state.diagnostics.push(code)});
 async function call({method='POST',origin='https://pina.invalid',body='csrf=dummy&decision=allow',parsedBody,parsed=false}={}){const req=Readable.from([body]);if(parsed){for await(const c of req){}req.body=parsedBody;}req.method=method;req.headers={origin,'content-type':'application/x-www-form-urlencoded'};const res={status:200,writes:0,ends:0,setHeader(k,v){if(state.responseError)throw Error('private response detail');this.headers??={};this.headers[k]=v;},writeHead(s,h){if(this.headersSent)throw Error('second write');this.writes++;this.status=s;this.headers=h;},end(body){this.ends++;this.writableEnded=true;this.body=body;}};await handler(req,res);return res;}
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

test('failed interaction finalization is contained without retry or exposing details',async()=>{
 const f=fixture();f.state.finishError=true;const result=await f.call();assert.equal(result.status,403);assert.equal(result.body,'interaction_denied');assert.equal(f.state.saved,1);assert.equal(f.state.finished.length,0);assert.deepEqual(f.state.diagnostics,['consent_finalize_result_failed']);
});

test('consent accepts Vercel parsed form without changing validation or accepting duplicates',async()=>{
 for(const parsedBody of [{csrf:'dummy',decision:'allow'},Object.assign(Object.create(null),{csrf:'dummy',decision:'allow'}),'csrf=dummy&decision=allow',Buffer.from('csrf=dummy&decision=allow')]){
  const f=fixture();const r=await f.call({parsed:true,parsedBody});assert.equal(r.statusCode,303);assert.equal(r.headers['Content-Length'],'0');assert.equal(f.state.saved,1);
 }
 for(const parsedBody of [{csrf:['dummy','wrong'],decision:'allow'},{csrf:'dummy',decision:['allow']},{csrf:'dummy',decision:'allow',extra:'user'},['dummy'],{csrf:7,decision:'allow'},{csrf:'x'.repeat(4097),decision:'allow'},'csrf=dummy&csrf=dummy&decision=allow']){
  const f=fixture();assert.equal((await f.call({parsed:true,parsedBody})).status,403);assert.equal(f.state.saved,0);
 }
 for(const args of [{origin:'https://wrong.invalid'},{parsedBody:{csrf:'wrong',decision:'allow'}}]){const f=fixture();assert.equal((await f.call({parsed:true,parsedBody:{csrf:'dummy',decision:'allow'},...args})).status,403);assert.equal(f.state.saved,0);}
});

test('finalization response failure never rewrites headers or repeats grant save',async()=>{
 for(const ended of [false,true]){const f=fixture();f.state.finishHeadersSent=true;f.state.finishEnded=ended;const r=await f.call();assert.equal(r.writes,0);assert.equal(r.ends,ended?0:1);assert.equal(f.state.saved,1);assert.ok(f.state.diagnostics.every(x=>x==='consent_response_failed'));assert.equal(f.state.finished.length,0);}
});

test('diagnostics distinguish saved interaction result from response failure',async()=>{
 const f=fixture();f.state.responseError=true;const r=await f.call();assert.equal(r.status,403);assert.equal(f.state.saved,1);assert.equal(f.state.finished.length,1);assert.deepEqual(f.state.diagnostics,['consent_finalize_response_failed']);assert.equal(r.body,'interaction_denied');
});
