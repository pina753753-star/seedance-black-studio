import test from 'node:test';import assert from 'node:assert/strict';import {Readable} from 'node:stream';
import {createBrokerInteraction} from '../broker-interaction.mjs';
function fixture(){
 const state={finished:[],saved:0,user:{userId:'alice',emailConfirmed:true,accountStatus:'active'},diagnostics:[],details:{uid:'interaction',params:{client_id:'pina',resource:'https://pina.invalid/mcp',scope:'credits:read generation:write'}}};
 const provider={interactionDetails:async()=>state.details,interactionResult:async(req,res,result)=>{if(state.onFinish)state.onFinish(req);if(state.finishHeadersSent){res.headersSent=true;res.writableEnded=state.finishEnded;throw Object.assign(new Error('private header details'),{code:'ERR_HTTP_HEADERS_SENT'});}if(state.finishError)throw (state.finishError instanceof Error?state.finishError:new Error('dummy persistence failure'));state.finished.push(result);return state.returnTo||'https://pina.invalid/mcp/oauth/auth/dummy';},Grant:class{constructor(p){this.params=p;}addResourceScope(){}addOIDCScope(){}async save(){state.saved++;return 'grant';}}};
 const handler=createBrokerInteraction({provider,origin:'https://pina.invalid',clientId:'pina',resource:'https://pina.invalid/mcp',verifyPinaBrowserSession:async()=>state.user,issueCsrf:async()=>'<dummy>',verifyCsrf:async(v,b)=>v==='dummy'&&b.userId==='alice'&&b.interactionId==='interaction',diagnostic:code=>state.diagnostics.push(code)});
 async function call({method='POST',origin='https://pina.invalid',body='csrf=dummy&decision=allow',parsedBody,parsed=false,socket={}}={}){const req=Readable.from([body]);state.request=req;req.socket=socket;if(parsed){for await(const c of req){}req.body=parsedBody;}req.method=method;req.headers={origin,'content-type':'application/x-www-form-urlencoded'};const res={status:200,writes:0,ends:0,setHeader(k,v){if(state.responseError)throw Error('private response detail');this.headers??={};this.headers[k]=v;},writeHead(s,h){if(this.headersSent)throw Error('second write');this.writes++;this.status=s;this.headers=h;},end(body){this.ends++;this.writableEnded=true;this.body=body;}};await handler(req,res);return res;}
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
 const f=fixture();f.state.finishError=true;const result=await f.call();assert.equal(result.status,403);assert.equal(result.body,'interaction_denied');assert.equal(f.state.saved,1);assert.equal(f.state.finished.length,0);assert.deepEqual(f.state.diagnostics,['consent_result_socket_present_other','consent_finalize_result_failed']);
});

test('consent accepts Vercel parsed form without changing validation or accepting duplicates',async()=>{
 for(const parsedBody of [{csrf:'dummy',decision:'allow'},Object.assign(Object.create(null),{csrf:'dummy',decision:'allow'}),'csrf=dummy&decision=allow',Buffer.from('csrf=dummy&decision=allow')]){
  const f=fixture();const r=await f.call({parsed:true,parsedBody});assert.equal(r.statusCode,200);assert.equal(r.headers.Location,undefined);assert.match(r.body,/接続はまだ完了していません/);assert.equal(f.state.saved,1);
 }
 for(const parsedBody of [{csrf:['dummy','wrong'],decision:'allow'},{csrf:'dummy',decision:['allow']},{csrf:'dummy',decision:'allow',extra:'user'},['dummy'],{csrf:7,decision:'allow'},{csrf:'x'.repeat(4097),decision:'allow'},'csrf=dummy&csrf=dummy&decision=allow']){
  const f=fixture();assert.equal((await f.call({parsed:true,parsedBody})).status,403);assert.equal(f.state.saved,0);
 }
 for(const args of [{origin:'https://wrong.invalid'},{parsedBody:{csrf:'wrong',decision:'allow'}}]){const f=fixture();assert.equal((await f.call({parsed:true,parsedBody:{csrf:'dummy',decision:'allow'},...args})).status,403);assert.equal(f.state.saved,0);}
});

test('finalization response failure never rewrites headers or repeats grant save',async()=>{
 for(const ended of [false,true]){const f=fixture();f.state.finishHeadersSent=true;f.state.finishEnded=ended;const r=await f.call();assert.equal(r.writes,0);assert.equal(r.ends,ended?0:1);assert.equal(f.state.saved,1);assert.deepEqual(f.state.diagnostics,['consent_result_socket_present_other','consent_response_failed','consent_response_failed']);assert.equal(f.state.finished.length,0);}
});

test('diagnostics distinguish saved interaction result from response failure',async()=>{
 const f=fixture();f.state.responseError=true;const r=await f.call();assert.equal(r.status,403);assert.equal(f.state.saved,1);assert.equal(f.state.finished.length,1);assert.deepEqual(f.state.diagnostics,['consent_finalize_response_failed']);assert.equal(r.body,'interaction_denied');
});

test('finalization emits only fixed socket and allowlisted exception categories',async()=>{
 for(const socket of [undefined,null,{}])for(const [ErrorType,type] of [[TypeError,'type_error'],[RangeError,'range_error'],[Error,'other']]){
  const f=fixture();f.state.finishError=new ErrorType('private token URL and stack must not be logged');
  f.state.onFinish=()=>{f.state.request.socket=socket;};const r=await f.call();assert.equal(r.status,403);assert.equal(f.state.saved,1);assert.equal(f.state.finished.length,0);
  assert.deepEqual(f.state.diagnostics,['consent_result_socket_'+(socket==null?'missing':'present')+'_'+type,'consent_finalize_result_failed']);
 }
 const f=fixture();const forged=new Error('private');forged.name='TypeError';f.state.finishError=forged;await f.call();assert.equal(f.state.diagnostics[0],'consent_result_socket_present_other');
});

 test('provider metadata retains only the original transport and leaves the real request detached',async()=>{
  const f=fixture(),socket={encrypted:false,remoteAddress:'127.0.0.1'};
  f.state.onFinish=req=>{f.state.request.socket=null;assert.equal(req.socket,socket);assert.equal(req.headers,f.state.request.headers);assert.equal(req.socket.encrypted,false);};
  const r=await f.call({socket});assert.equal(r.statusCode,200);assert.equal(f.state.request.socket,null);assert.equal(f.state.saved,1);
 });
 test('missing original transport fails closed before grant or finalization',async()=>{
  const f=fixture();const r=await f.call({socket:null});assert.equal(r.status,403);assert.equal(f.state.saved,0);assert.equal(f.state.finished.length,0);
 });


test('continuation has same-tab trusted resume link only, and retains restrictive CSP',async()=>{
 const f=fixture(),r=await f.call();assert.equal(r.statusCode,200);assert.match(r.body,/href="\/mcp\/oauth\/auth\/dummy"/);assert.doesNotMatch(r.body,/target=|<script|<form|http-equiv|code=|state=/i);
 assert.match(r.headers['Content-Security-Policy'],/form-action 'self'/);assert.equal(r.headers['Referrer-Policy'],'no-referrer');assert.equal(r.headers['Cache-Control'],'no-store');
 const d=fixture(),denied=await d.call({body:'csrf=dummy&decision=deny'});assert.match(denied.body,/キャンセル/);assert.equal(d.state.saved,0);
});
test('continuation rejects external, alternate, encoded and query-bearing resume locations',async()=>{
 for(const returnTo of ['https://evil.invalid/mcp/oauth/auth/x','//evil.invalid/mcp/oauth/auth/x','https://pina.invalid/mcp/oauth/token','https://pina.invalid/mcp/oauth/auth/x?code=x','https://pina.invalid/mcp/oauth/auth/x#x','https://pina.invalid/mcp/oauth/auth/x%2fy','https://user@pina.invalid/mcp/oauth/auth/x','javascript:alert(1)']){
  const f=fixture();f.state.returnTo=returnTo;const r=await f.call();assert.equal(r.status,403);assert.equal(r.body,'interaction_denied');assert.equal(r.headers.Location,undefined);
 }
});
