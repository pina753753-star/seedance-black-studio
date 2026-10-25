'use strict';
// Run with the already installed Playwright and Chromium. No server, installs,
// credentials, production services or outbound request is required.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const reportPath = '/workspace/pina-deliverables/integration-browser-report.json';
const origin = 'http://pina.local';
const passed = [], failures = [];
let blockedExternal = 0, unexpectedApi = [];
const allowedFiles = new Set(['generate-prod.html','profile.html','flowvid-history.js','flowvid-open-inline.js','auth-guard.js']);
const syntheticAuth = `(function(){
 if(window.__syntheticClientReady)return;window.__syntheticClientReady=true;
 window.__authCounts={getUser:0,signOut:0};
 const user={id:'browser-owner',email:'browser@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'};
 const session={access_token:'synthetic-browser-session',user};
 const balance={free_credits:1000,subscription_credits:0,purchased_credits:1000,subscription_expires_at:'2999-01-01T00:00:00Z'};
 const client={auth:{getSession:async()=>({data:{session}}),getUser:async(token)=>{window.__authCounts.getUser++;if(sessionStorage.getItem('synthetic-auth-failure'))return {data:{user:null},error:{name:'AuthRetryableFetchError',message:'synthetic transient failure'}};return {data:{user:token===session.access_token||!token?user:null}}},signOut:async()=>{window.__authCounts.signOut++},onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from(table){const chain={select(){return chain},eq(){return chain},maybeSingle:async()=>({data:table==='profiles'?{plan:'free',role:'user'}:balance,error:null})};return chain}};
 window.FLOWVID_AUTH={supabaseUrl:'https://synthetic.invalid',supabaseAnonKey:'synthetic-only'};
 window.supabase={createClient:()=>client};window.flowvidSupabaseClient=()=>client;
})();`;
async function fixture(browser, capabilities, options = {}) {
 const context = await browser.newContext({serviceWorkers:'block',viewport:{width:1100,height:1000}});
 await context.addInitScript(syntheticAuth);
 if(options.authFailure)await context.addInitScript(()=>{if(!sessionStorage.getItem('synthetic-auth-recovered'))sessionStorage.setItem('synthetic-auth-failure','1')});
 const starts = [], finishes = [], pageErrors = [];
 let completed = false;
 await context.route('**/*', async route => {
  const request=route.request(),url=new URL(request.url());
  if(url.hostname!=='pina.local') {
   // Dependency JS is a locally synthesized stub; it never reaches its URL.
   if(url.pathname.includes('@supabase/supabase-js')) return route.fulfill({contentType:'application/javascript',body:syntheticAuth});
   blockedExternal++;return route.abort('blockedbyclient');
  }
  if(url.pathname==='/auth-config.js') return route.fulfill({contentType:'application/javascript',body:syntheticAuth});
  const json=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
  if(url.pathname==='/api/reference-dance-access')return json({ok:true,allowed:false});
  if(url.pathname==='/api/credit-access') return json(capabilities,options.capabilityFailure?503:200);
  if(url.pathname==='/api/generated-videos') return json({ok:true,rows:completed?[{id:'legacy-job',job_id:'legacy-job',video_url:origin+'/watermarked.mp4',prompt:'Stored owned video',status:'completed',model:'bytedance/seedance-2.0',mode:'text_to_video'}]:[],watermarkPending:options.pending&&!completed?[{jobId:'legacy-job',prompt:'Stored owned video',createdAt:'2026-10-25T00:00:00Z'}]:[]});
  if(url.pathname==='/api/pending-tasks')return json({ok:true,tasks:[]});
  if(url.pathname==='/api/seedance-start') {starts.push({headers:request.headers(),body:request.postDataJSON()});return json({ok:false,error:'mock_insufficient_balance',balance:0,required:100},402);}
  if(url.pathname==='/api/seedance-status') {
   finishes.push({query:url.searchParams.get('jobId'),authorization:request.headers().authorization});
   if(options.finishFailure)return json({ok:true,done:false,watermarkPending:true});
   completed=true;return json({ok:true,done:true,videoUrl:origin+'/watermarked.mp4'});
  }
  if(url.pathname.startsWith('/api/')) {unexpectedApi.push(url.pathname);return json({ok:false,error:'unmocked_api'},503);}
  const name=url.pathname.slice(1);
  if(allowedFiles.has(name))return route.fulfill({contentType:name.endsWith('.html')?'text/html':'application/javascript',body:fs.readFileSync(path.join(root,name),'utf8')});
  // Images and synthetic media are inert; never fetch the real assets/CDNs.
  return route.fulfill({status:204,body:''});
 });
 const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto(origin+'/'+(options.profile?'profile.html':'generate-prod.html'),{waitUntil:'networkidle'});
 if(options.authFailure)await page.locator('#authConnectionBlocked').waitFor();
 else if(options.profile)await page.evaluate(()=>window.showHistorySection());
 else {await page.waitForFunction(()=>typeof generationAccessLoaded!=='undefined');if(!options.capabilityFailure)await page.waitForFunction(()=>generationAccessLoaded===true);}
 assert.equal(await page.evaluate(()=>typeof window.FlowVidAuthGuard.verify),'function');
 return {context,page,starts,finishes,pageErrors};
}
async function run(name, fn) {try{await fn();passed.push(name);console.log('PASS '+name)}catch(error){failures.push({name,error:String(error.stack||error)});console.log('FAIL '+name+': '+error.message)}}
async function model(page,value,resolution) {
 await page.locator('#mainCard details.settings').evaluate(el=>{el.open=true});
 await page.locator('#model').selectOption(value);
 if(resolution)await page.locator('#resolution').selectOption(resolution);
 await page.locator('#prompt').fill('A paper boat at sunset');
}
(async()=>{
 let browser;
 try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-background-networking','--disable-component-update','--disable-sync','--host-resolver-rules=MAP * ~NOTFOUND']});
 await run('purchase: 2.5 Turbo enabled, audio/storyboard restricted, ordinary start sends one authenticated mock request',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,referenceAudio:false,storyboard25:false,watermarkRequired:true});
  try{
   await model(f.page,'bytedance/seedance-2.5','1080p');assert.equal(await f.page.locator('#create').isDisabled(),false);assert.equal(await f.page.locator('#audioFile').isDisabled(),true);
   await f.page.locator('#create').click();await f.page.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   assert.equal(f.starts.length,1);assert.equal(f.starts[0].body.model,'bytedance/seedance-2.5');assert.equal(f.starts[0].headers.authorization,'Bearer synthetic-browser-session');assert.equal(f.starts[0].body.reference_audio_paths,undefined);
   await f.page.locator('[data-mode="storyboard"]').click();await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.5');assert.equal(await f.page.locator('#sbAnalyzeBtn').isDisabled(),true);assert.match(await f.page.locator('#sbAnalyzeBtn').textContent(),/Premium/);
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('free-only: 2.5 blocked, 2.0 and Fast remain usable',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:false,referenceAudio:false,storyboard25:false,watermarkRequired:true});
  try{await model(f.page,'bytedance/seedance-2.5');assert.equal(await f.page.locator('#create').isDisabled(),true);for(const value of ['bytedance/seedance-2.0','bytedance/seedance-2.0-fast']){await model(f.page,value,'720p');assert.equal(await f.page.locator('#create').isDisabled(),false)}assert.equal(f.starts.length,0);assert.deepEqual(f.pageErrors,[])}finally{await f.context.close()}
 });
 await run('active Premium: 2.5, audio, and storyboard capabilities preserved',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,referenceAudio:true,storyboard25:true,watermarkRequired:false});
  try{await model(f.page,'bytedance/seedance-2.5','1080p');assert.equal(await f.page.locator('#create').isDisabled(),false);assert.equal(await f.page.locator('#audioFile').isDisabled(),false);await f.page.locator('[data-mode="storyboard"]').click();await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.5');await f.page.evaluate(()=>{sbFile={name:'synthetic-no-upload'};sbSyncPlanAccess()});assert.equal(await f.page.locator('#sbAnalyzeBtn').isDisabled(),false);assert.deepEqual(f.pageErrors,[])}finally{await f.context.close()}
 });
 await run('active Standard plus purchase: normal 2.5 enabled, high-tier extras remain blocked',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,referenceAudio:false,storyboard25:false,watermarkRequired:false});
  try{await model(f.page,'bytedance/seedance-2.5-standard','720p');assert.equal(await f.page.locator('#create').isDisabled(),false);await model(f.page,'bytedance/seedance-2.5','1080p');assert.equal(await f.page.locator('#audioFile').isDisabled(),true);assert.deepEqual(f.pageErrors,[])}finally{await f.context.close()}
 });
 await run('capability API unavailable: restricted model fails closed and 2.0 remains available',async()=>{
  const f=await fixture(browser,{ok:false,error:'entitlement_unavailable'},{capabilityFailure:true});
  try{await model(f.page,'bytedance/seedance-2.5');assert.equal(await f.page.locator('#create').isDisabled(),true);await model(f.page,'bytedance/seedance-2.0','720p');assert.equal(await f.page.locator('#create').isDisabled(),false);assert.deepEqual(f.pageErrors,[])}finally{await f.context.close()}
 });
 for(const profile of [false,true])await run((profile?'profile':'generation')+' history: finish is explicit, calls once, replaces pending with watermarked output',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,referenceAudio:false,storyboard25:false,watermarkRequired:true},{pending:true,profile});
  try{
   const button=f.page.locator(profile?'.ph-finish-watermark':'.fv-finish-watermark');await button.waitFor();assert.equal(f.finishes.length,0);
   assert.equal(await f.page.locator(profile?'#histList video':'#history video').count(),0);
   await button.click();await f.page.locator((profile?'#histList':'#history')+' video').waitFor();assert.equal(f.finishes.length,1);assert.equal(f.finishes[0].query,'legacy-job');assert.equal(f.finishes[0].authorization,'Bearer synthetic-browser-session');assert.match(await f.page.locator((profile?'#histList':'#history')+' video').first().getAttribute('src'),/watermarked\.mp4/);assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('unfinished watermark shows manual retry without automatic polling',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,referenceAudio:false,storyboard25:false,watermarkRequired:true},{pending:true,finishFailure:true});
  try{await f.page.locator('.fv-finish-watermark').click();await f.page.waitForFunction(()=>document.querySelector('[data-watermark-message]')?.textContent.includes('もう一度'));assert.equal(f.finishes.length,1);assert.equal(await f.page.locator('.fv-finish-watermark').isDisabled(),false);assert.equal(await f.page.locator('#history video').count(),0);assert.deepEqual(f.pageErrors,[])}finally{await f.context.close()}
 });
 await run('actual auth guard: transient lookup blocks profile, preserves session and recovers on explicit retry',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,referenceAudio:false,storyboard25:false,watermarkRequired:true},{profile:true,authFailure:true});
  try{
   assert.match(f.page.url(),/profile[.]html/);
   assert.equal(await f.page.evaluate(()=>window.__authCounts.signOut),0);
   assert.ok(await f.page.evaluate(()=>window.__authCounts.getUser)>0);
   assert.equal(await f.page.evaluate(()=>document.querySelector('.wrap')?.inert),true);
   assert.equal(f.starts.length,0);assert.equal(f.finishes.length,0);
   await f.page.evaluate(()=>{sessionStorage.removeItem('synthetic-auth-failure');sessionStorage.setItem('synthetic-auth-recovered','1')});
   await Promise.all([f.page.waitForNavigation({waitUntil:'networkidle'}),f.page.getByRole('button',{name:'接続を再確認'}).click()]);
   assert.equal(await f.page.locator('#authConnectionBlocked').count(),0);
   assert.match(f.page.url(),/profile[.]html/);
   assert.equal(await f.page.evaluate(()=>window.FlowVidAuthGuard.getVerifiedToken(window.flowvidSupabaseClient())), 'synthetic-browser-session');
   assert.equal(await f.page.evaluate(()=>window.__authCounts.signOut),0);assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 }catch(error){failures.push({name:'browser setup',error:String(error.stack||error)})}
 finally{if(browser)await browser.close();fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify({date:new Date().toISOString(),browser:'/usr/bin/chromium',network:'Every browser request intercepted; nonlocal requests aborted or fulfilled with synthetic dependency stubs. DNS disabled. No external request continued.',passed,failures,blockedExternal,unexpectedApi,limits:['Actual merged auth-guard.js; synthetic Supabase SDK/session/getUser and capabilities/API responses. All original eight scenarios plus transient auth recovery.','No real Supabase, Stripe, provider, OAuth, watermark server, media processing or paid generation invoked.','No packages installed.']},null,2));console.log(JSON.stringify({passed:passed.length,failed:failures.length,unexpectedApi,reportPath}));process.exitCode=failures.length||unexpectedApi.length?1:0}
})();
