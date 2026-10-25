'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const source=fs.readFileSync('api/reference-dance-worker-diagnostic.js','utf8');
const preview='https://flowvid-studio-git-verify-pina-worker-au-4f7aef-pina-s-projects.vercel.app';
function harness(options={}) {
 const calls=[], logs=[];
 const module={exports:{}};
 const env={VERCEL_ENV:'preview',WATERMARK_SECRET:'synthetic-only-secret',SUPABASE_URL:'https://project-test.supabase.co',...options.env};
 const code=source.replace("const PRODUCTION_WORKER_ORIGIN = 'https://seedance-black-studio-production.up.railway.app';", options.target===false?"const PRODUCTION_WORKER_ORIGIN = '';":"const PRODUCTION_WORKER_ORIGIN = 'https://worker.example.invalid';");
 vm.runInNewContext(code,{module,process:{env},URL,AbortController,setTimeout,clearTimeout,console:{log:(...x)=>logs.push(x),error:(...x)=>logs.push(x)},require(name){
  if(name.includes('confirmed-auth'))return {requireConfirmedAuth:async()=>({ok:options.auth!==false,status:401,supabase:{},user:{id:'admin'}})};
  return {authorizeReferenceDanceAdmin:async()=>({ok:options.admin!==false})};
 },fetch:async(url,init)=>{calls.push({url,init});if(options.throw)throw new Error('synthetic-only-secret');return {status:options.status??400,json:async()=>options.data??{ok:false,error:'videoUrl is required'}}}});
 return {calls,logs, async invoke(overrides={}){const res={headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.code=n;return this},json(x){this.body=x;return this}};await module.exports({method:'POST',headers:{origin:preview,'x-pina-diagnostic':'1','content-type':'application/json'},body:{},...overrides},res);assert.match(res.headers['Cache-Control'],/no-store/);assert.doesNotMatch(JSON.stringify([res.body,logs]),/synthetic-only-secret|Bearer/);return res;}};
}
test('production, missing environment and development disabled before authentication/network',async()=>{
 for(const value of ['production','development',undefined]){const h=harness({env:{VERCEL_ENV:value}});assert.equal((await h.invoke()).code,404);assert.equal(h.calls.length,0)}
});
test('unauthenticated and nonadmin denied without worker request',async()=>{
 for(const options of [{auth:false},{admin:false}]){const h=harness(options);assert.ok([401,403].includes((await h.invoke()).code));assert.equal(h.calls.length,0)}
});
test('CSRF, method, content type and payload restrictions prevent arbitrary targets',async()=>{
 for(const overrides of [{method:'GET'},{method:'OPTIONS'},{headers:{}},{headers:{origin:'https://attacker.invalid','x-pina-diagnostic':'1','content-type':'application/json'}},{headers:{origin:preview,'content-type':'application/json'}},{headers:{origin:preview,'x-pina-diagnostic':'1','content-type':'text/plain'}},{body:{url:'https://attacker.invalid'}},{body:{videoUrl:'https://attacker.invalid'}},{body:[]},{body:'malformed'}]){
 const h=harness();assert.notEqual((await h.invoke(overrides)).code,200);assert.equal(h.calls.length,0)}
});
test('unconfigured fixed target and invalid configuration fail closed',async()=>{
 for(const options of [{target:false},{env:{WATERMARK_SECRET:''}},{env:{WATERMARK_SECRET:'bad\r\nvalue'}},{env:{SUPABASE_URL:'https://attacker.invalid'}}]){const h=harness(options);assert.equal((await h.invoke()).code,503);assert.equal(h.calls.length,0)}
});
test('fixed empty-body probe verifies only exact pre-processing response without redirect or retry',async()=>{
 const h=harness({env:{WATERMARK_SERVER_URL:'https://attacker.invalid'}}),r=await h.invoke();
 assert.equal(r.body.authenticated,true);assert.equal(r.body.projectOrigin,'https://project-test.supabase.co');assert.equal(h.calls.length,1);
 const {url,init}=h.calls[0];assert.equal(url,'https://worker.example.invalid/watermark');assert.equal(init.body,'{}');assert.equal(init.redirect,'error');assert.equal(init.method,'POST');assert.ok(init.signal);
});
test('unexpected responses and transport failures never report success or echo secrets',async()=>{
 for(const options of [{status:401,data:{error:'synthetic-only-secret'}},{status:200},{status:302},{data:{ok:false,error:'different'}},{throw:true}]){const h=harness(options),r=await h.invoke();assert.notEqual(r.body.authenticated,true);assert.equal(h.calls.length,1)}
});
test('baseline watermark empty-body response stops before queue, processing and storage',async()=>{
 const server=fs.readFileSync('watermark-server/server.js','utf8');
 const start=server.indexOf("app.post('/watermark',");
 const stop=server.indexOf('// ================================================================',start);
 let handler;
 vm.runInNewContext(server.slice(start,stop),{app:{post(path,fn){assert.equal(path,'/watermark');handler=fn}},WATERMARK_SECRET:'synthetic-only-secret'});
 // Every post-validation dependency is deliberately absent: accessing it fails this test.
 const res={status(n){this.code=n;return this},json(x){this.body=x;return this}};
 await handler({headers:{authorization:'Bearer synthetic-only-secret'},body:{}},res);
 assert.equal(res.code,400);assert.equal(res.body.error,'videoUrl is required');
});
test('diagnostic page uses existing session with text-only sanitized rendering',()=>{
 const html=fs.readFileSync('reference-dance-diagnostic.html','utf8');
 assert.doesNotMatch(html,/innerHTML|console\.|localStorage\.setItem|signIn|signUp/);
 for(const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))new vm.Script(script[1]);
});
test('diagnostic session retrieval is read-only and ignores auth callbacks even with invalid or expired sessions',async()=>{
 const html=fs.readFileSync('reference-dance-diagnostic.html','utf8');
 const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1];
 for(const stored of ['invalid-json',null,JSON.stringify({access_token:'synthetic-session',expires_at:1}),JSON.stringify({access_token:'synthetic-session',expires_at:Date.now()/1000+3600})]){
  const button={}, result={}, requests=[], reads=[];
  const ctx={URL,Date,document:{getElementById:id=>id==='check'?button:result},location:{origin:preview,hash:'#access_token=must-not-consume',search:'?code=must-not-consume'},window:{FLOWVID_AUTH:{supabaseUrl:'https://project-test.supabase.co'},localStorage:{getItem(key){reads.push(key);return stored},setItem(){assert.fail('session write')},removeItem(){assert.fail('session removal')}}},fetch:async(url,init)=>{requests.push({url,init});return {json:async()=>({authenticated:true,projectOrigin:'https://project-test.supabase.co'})}}};
  vm.runInNewContext(script,ctx);await button.onclick();
  assert.deepEqual(reads,['sb-project-test-auth-token']);
  const valid=stored&&stored.includes('expires_at')&&JSON.parse(stored).expires_at>1;
  assert.equal(requests.length,valid?1:0);
  if(valid){assert.equal(requests[0].url,'/api/reference-dance-worker-diagnostic');assert.equal(requests[0].init.headers.Authorization,'Bearer synthetic-session')}
  assert.doesNotMatch(result.textContent,/synthetic-session|must-not-consume/);
  assert.equal(ctx.location.hash,'#access_token=must-not-consume');assert.equal(button.disabled,false);
 }
});
