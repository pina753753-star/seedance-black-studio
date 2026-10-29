'use strict';
// Run with the already installed Playwright and Chromium. No server, installs,
// credentials, production services or outbound request is required.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const reportPath = process.env.PINA_BROWSER_REPORT || '/workspace/pina-deliverables/integration-browser-report.json';
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
 if(options.savedMode)await context.addInitScript(mode=>{try{localStorage.setItem('flowvidGenerateMode',mode)}catch(_){}},options.savedMode);
 if(options.authFailure)await context.addInitScript(()=>{if(!sessionStorage.getItem('synthetic-auth-recovered'))sessionStorage.setItem('synthetic-auth-failure','1')});
 const starts = [], finishes = [], pageErrors = [];
 const rev = {serverPrice:null,revised:false};
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
  if(url.pathname==='/api/seedance-start') {starts.push({headers:request.headers(),body:request.postDataJSON()});if(options.priceRevision){const est=request.postDataJSON().estimated_credits;if(rev.serverPrice===null)rev.serverPrice=est+5;if(est<rev.serverPrice){rev.revised=true;return json({ok:false,error:'credit_cost_changed',credits:rev.serverPrice,estimatedCredits:est},409);}}
  if(options.costChanged)return json({ok:false,error:'credit_cost_changed',credits:999,estimatedCredits:request.postDataJSON().estimated_credits},409);
  return json({ok:false,error:'mock_insufficient_balance',balance:0,required:100},402);}
  if(url.pathname==='/api/seedance-status') {
   finishes.push({query:url.searchParams.get('jobId'),authorization:request.headers().authorization});
   if(options.finishFailure)return json({ok:true,done:false,watermarkPending:true});
   completed=true;return json({ok:true,done:true,videoUrl:origin+'/watermarked.mp4'});
  }
  if(url.pathname.startsWith('/api/')) {unexpectedApi.push(url.pathname);return json({ok:false,error:'unmocked_api'},503);}
  const name=url.pathname.slice(1);
  if(options.priceRevision&&rev.revised&&name==='flowvid-open-inline.js'){const src=fs.readFileSync(path.join(root,name),'utf8');assert.equal(src.split('function calculateCredits(){').length,2);return route.fulfill({contentType:'application/javascript',body:src.replace('function calculateCredits(){','function calculateCredits(){return calculateCreditsBase()+5}function calculateCreditsBase(){')});}
  if(allowedFiles.has(name))return route.fulfill({contentType:name.endsWith('.html')?'text/html':'application/javascript',body:fs.readFileSync(path.join(root,name),'utf8')});
  // Images and synthetic media are inert; never fetch the real assets/CDNs.
  return route.fulfill({status:204,body:''});
 });
 const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto(origin+'/'+(options.profile?'profile.html':'generate-prod.html')+(options.query||''),{waitUntil:'networkidle'});
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
 await run('2.0 1080 aspect prices persist through history refresh and storyboard estimates',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:false,storyboard25:false,watermarkRequired:false});
  try{
   await model(f.page,'bytedance/seedance-2.0','1080p');
   await f.page.locator('#duration').selectOption('15');
   for(const [aspect,credits] of [['16:9',535],['1:1',335],['4:3',405],['9:16',535]]){
    await f.page.locator('#aspect').selectOption(aspect);await f.page.waitForTimeout(850);
    assert.match(await f.page.locator('#create').textContent(),new RegExp(credits+'$'));
    assert.equal(await f.page.evaluate(()=>creditEstimate()),credits);
   }
   await f.page.locator('#create').click();await f.page.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   assert.equal(f.starts.length,1);assert.equal(f.starts[0].body.estimated_credits,535);assert.equal(f.starts[0].body.aspect_ratio,'9:16');
   await f.page.locator('[data-mode="storyboard"]').evaluate(el=>el.click());await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.0');await f.page.locator('#sbResolution').selectOption('1080p');await f.page.locator('#sbDuration').selectOption('15');
   for(const [aspect,credits] of [['16:9',535],['1:1',400],['4:3',405]]){await f.page.locator('#sbAspect').selectOption(aspect);assert.equal(await f.page.locator('#sbCreditEstimateValue').textContent(),String(credits));}
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('storyboard and video-edit entrances are hidden, skipped by Tab, remaining modes fill the row (DOM/ids/data-mode kept)',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false});
  try{
   const p=f.page;
   for(const mode of ['storyboard','video_edit'])assert.equal(await p.locator('.tabs button[data-mode="'+mode+'"]').count(),1);
   assert.equal(await p.locator('#videoEditTab').count(),1);
   assert.equal(await p.locator('.tabs button[data-mode="storyboard"]').isVisible(),false);
   assert.equal(await p.locator('#videoEditTab').isVisible(),false);
   const visible=await p.locator('.tabs button:visible').evaluateAll(b=>b.map(x=>x.dataset.mode));
   assert.deepEqual(visible,['reference_to_video','image_to_video','text_to_video']);
   const seen=new Set();await p.locator('.tabs button:visible').first().focus();
   for(let i=0;i<14;i++){const m=await p.evaluate(()=>document.activeElement?.closest?.('.tabs')?document.activeElement.dataset.mode:null);if(m)seen.add(m);await p.keyboard.press('Tab');}
   assert.deepEqual([...seen].sort(),['image_to_video','reference_to_video','text_to_video']);
   const box=await p.evaluate(()=>{const t=document.querySelector('.tabs').getBoundingClientRect();const b=[...document.querySelectorAll('.tabs button')].filter(x=>x.offsetParent).map(x=>x.getBoundingClientRect());return{left:t.left,right:t.right,first:b[0].left,last:b[b.length-1].right,widths:b.map(x=>Math.round(x.width))}});
   assert.ok(Math.abs(box.first-box.left)<=1&&Math.abs(box.last-box.right)<=1,'visible tabs fill the row: '+JSON.stringify(box));
   assert.ok(Math.max(...box.widths)-Math.min(...box.widths)<=1,'equal widths: '+JSON.stringify(box));
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   assert.equal(await p.locator('#history').count(),1);
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 for(const [label,opts,section] of [['?mode=storyboard',{query:'?mode=storyboard'},'sbSection'],['saved mode storyboard',{savedMode:'storyboard'},'sbSection']]){
  await run('restore from '+label+' still works and returns to ordinary generation via a visible tab',async()=>{
   const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false},opts);
   try{
    const p=f.page;
    await p.waitForFunction(id=>document.getElementById(id)&&getComputedStyle(document.getElementById(id)).display!=='none',section);
    assert.equal(await p.locator('#mainCard').isVisible(),false);
    assert.equal(await p.locator('.tabs button[data-mode="storyboard"]').isVisible(),false);
    await p.locator('.tabs button[data-mode="text_to_video"]').click();
    assert.equal(await p.locator('#mainCard').isVisible(),true);assert.equal(await p.locator('#'+section).isVisible(),false);
    assert.equal(await p.evaluate(()=>mode),'text_to_video');
    assert.equal(await p.locator('#create').isVisible(),true);
    assert.deepEqual(f.pageErrors,[]);
   }finally{await f.context.close()}
  });
 }
 await run('restore from ?mode=video_edit still shows the edit section and returns to ordinary generation via a visible tab',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false},{query:'?mode=video_edit'});
  try{
   const p=f.page;
   await p.waitForFunction(()=>getComputedStyle(document.getElementById('videoEditSection')).display!=='none');
   assert.equal(await p.locator('#mainCard').isVisible(),false);
   assert.equal(await p.locator('#videoEditTab').isVisible(),false);
   await p.locator('.tabs button[data-mode="reference_to_video"]').click();
   assert.equal(await p.locator('#videoEditSection').isVisible(),false);assert.equal(await p.locator('#mainCard').isVisible(),true);
   assert.equal(await p.evaluate(()=>mode),'reference_to_video');
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('2.0 / Fast 480p right-sized: displayed estimate, button and sent estimate agree; 720p stays as before',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false});
  try{
   const p=f.page;
   const expectAt=async(m,res,dur,aspect,credits)=>{
    await model(p,m,res);await p.locator('#duration').selectOption(String(dur));await p.locator('#aspect').selectOption(aspect);await p.waitForTimeout(850);
    assert.equal(await p.evaluate(()=>creditEstimate()),credits,[m,res,dur,aspect].join('/'));
    assert.match(await p.locator('#create').textContent(),new RegExp(credits+'$'),[m,res,dur,aspect,'button'].join('/'));
   };
   await expectAt('bytedance/seedance-2.0-fast','480p',5,'16:9',20);
   await expectAt('bytedance/seedance-2.0-fast','480p',10,'9:16',40);
   await expectAt('bytedance/seedance-2.0-fast','480p',15,'16:9',60);
   await expectAt('bytedance/seedance-2.0','480p',5,'16:9',35);
   await expectAt('bytedance/seedance-2.0','480p',10,'9:16',65);
   await expectAt('bytedance/seedance-2.0','480p',15,'16:9',100);
   await expectAt('bytedance/seedance-2.0-fast','480p',5,'1:1',15);
   await expectAt('bytedance/seedance-2.0','480p',5,'1:1',20);
   await expectAt('bytedance/seedance-2.0-fast','480p',8,'16:9',35);
   await expectAt('bytedance/seedance-2.0','480p',8,'16:9',55);
   await expectAt('bytedance/seedance-2.0-fast','720p',5,'16:9',70);
   await expectAt('bytedance/seedance-2.0-fast','480p',5,'16:9',20);
   await p.locator('#create').click();await p.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   assert.equal(f.starts.length,1);assert.equal(f.starts[0].body.estimated_credits,20);assert.equal(f.starts[0].body.resolution,'480p');
   assert.deepEqual(f.pageErrors,[]);
   await p.screenshot({path:process.env.PINA_SHOT_DIR?process.env.PINA_SHOT_DIR+'/fast480-'+(await p.evaluate(()=>innerWidth))+'.png':undefined,fullPage:true}).catch(()=>{});
  }finally{await f.context.close()}
 });
 await run('storyboard-origin 2.0 Fast 480p keeps the legacy 70: storyboard tab estimate, locked main form, button and sent estimate agree; unlocking returns to 20',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false},{query:'?mode=storyboard'});
  try{
   const p=f.page;
   await p.waitForFunction(()=>getComputedStyle(document.getElementById('sbSection')).display!=='none');
   await p.locator('#sbModel').selectOption('bytedance/seedance-2.0-fast');await p.locator('#sbResolution').selectOption('480p');await p.locator('#sbDuration').selectOption('5');await p.locator('#sbAspect').selectOption('16:9');
   assert.equal(await p.locator('#sbCreditEstimateValue').textContent(),'70','storyboard tab estimate keeps the old price');
   await p.locator('#sbModel').selectOption('bytedance/seedance-2.0');
   assert.equal(await p.locator('#sbCreditEstimateValue').textContent(),'90');
   // prepared / locked storyboard flow uses the main form with mode reference_to_video
   await p.evaluate(()=>{setMode('reference_to_video')});
   await model(p,'bytedance/seedance-2.0-fast','480p');await p.locator('#duration').selectOption('5');await p.locator('#aspect').selectOption('16:9');await p.waitForTimeout(850);
   assert.equal(await p.evaluate(()=>creditEstimate()),20,'ordinary reference generation uses the new price');
   await p.evaluate(()=>{sbGenerationImageUrl='https://example.test/sb.png';sbApplyLock(true)});await p.waitForTimeout(850);
   assert.equal(await p.evaluate(()=>creditEstimate()),70,'locked storyboard flow keeps the legacy price');
   assert.match(await p.locator('#create').textContent(),/70$/);
   await p.locator('#create').click();await p.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   assert.equal(f.starts.length,1);assert.equal(f.starts[0].body.estimated_credits,70);assert.equal(f.starts[0].body.ui_origin,'storyboard');assert.equal(f.starts[0].body.resolution,'480p');
   await p.locator('.tabs button[data-mode="reference_to_video"]').click();await p.waitForTimeout(850);
   assert.equal(await p.evaluate(()=>sbLocked),false);
   assert.equal(await p.evaluate(()=>creditEstimate()),20,'leaving the storyboard flow via a visible tab returns to the ordinary new price');
   assert.match(await p.locator('#create').textContent(),/20$/);
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('tab switching keeps each tab saved prompt and the storyboard reset does not leak its prompt into a normal draft (sbApplyLock must not persist drafts)',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false});
  try{
   const p=f.page;
   await p.evaluate(()=>{const d=readDraft();d.prompt_image_to_video='SAVED-I2V';localStorage.setItem('flowvidGenerateDraft',JSON.stringify(d));setMode('text_to_video');$('prompt').value='TYPED-T2V';setMode('image_to_video')});
   assert.equal(await p.locator('#prompt').inputValue(),'SAVED-I2V','the target tab keeps its own saved prompt');
   await p.evaluate(()=>{setMode('reference_to_video');$('prompt').value='NORMAL-REF';persistDraft();sbGenerationImageUrl='https://example.test/sb.png';sbApplyLock(true);$('prompt').value='STORYBOARD-PROMPT';resetStoryboardInputs()});
   const draft=await p.evaluate(()=>JSON.parse(localStorage.getItem('flowvidGenerateDraft')||'{}'));
   assert.notEqual(draft.prompt_reference_to_video,'STORYBOARD-PROMPT','storyboard prompt must not leak into the normal reference draft');
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('no launch-price notice on the generation screen; 2.5 Turbo 1080p estimate and button stay in sync',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false});
  try{
   const p=f.page;
   await model(p,'bytedance/seedance-2.5','1080p');await p.locator('#duration').selectOption('15');await p.waitForTimeout(850);
   assert.equal(await p.locator('#seedance25Promo').count(),0);
   assert.equal(/公開記念|終了前にサイト内/.test(await p.locator('body').innerText()),false);
   const est=await p.evaluate(()=>creditEstimate());
   assert.equal(est,300,'2.5 Turbo 1080p 15s keeps its real price');
   assert.match(await p.locator('#create').textContent(),new RegExp(est+'$'));
   await p.locator('#create').click();await p.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   assert.equal(f.starts.length,1);assert.equal(f.starts[0].body.estimated_credits,300);
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('credit_cost_changed (409) shows the old and new amount without a shortage prompt or a started job',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false},{costChanged:true});
  try{
   await model(f.page,'bytedance/seedance-2.0','1080p');
   await f.page.locator('#create').click();await f.page.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   const text=await f.page.locator('#creditStatus').textContent();
   assert.match(text,/消費クレジットが変わりました/);assert.match(text,/999 cr/);assert.doesNotMatch(text,/クレジットが足りません/);
   assert.match(text,/再読み込み/);assert.equal(await f.page.locator('#creditStatus button:has-text("再読み込みして確認")').count(),1);
   assert.equal(f.starts.length,1);assert.equal(await f.page.locator('#create').isDisabled(),false);
   await f.page.waitForTimeout(1500);assert.equal(f.starts.length,1,'no automatic resend');
   await f.page.locator('#create').click();await f.page.waitForTimeout(500);assert.equal(f.starts.length,2,'explicit resend after confirming');
   assert.equal(await f.page.locator('#create').isDisabled(),false);
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('simulated price revision: 409, reload re-quotes the displayed and sent amount, explicit click resends once',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false},{priceRevision:true});
  try{
   await model(f.page,'bytedance/seedance-2.0','1080p');
   const before=await f.page.evaluate(()=>creditEstimate());
   await f.page.locator('#create').click();await f.page.waitForFunction(()=>/消費クレジットが変わりました/.test(document.getElementById('creditStatus').textContent));
   assert.equal(f.starts.length,1);assert.equal(f.starts[0].body.estimated_credits,before);
   assert.match(await f.page.locator('#creditStatus').textContent(),new RegExp((before+5)+' cr'));
   await f.page.waitForTimeout(1200);assert.equal(f.starts.length,1,'no automatic resend');
   await f.page.locator('#creditStatus button:has-text("再読み込みして確認")').click();
   await f.page.waitForLoadState('networkidle');
   await f.page.waitForFunction(()=>typeof generationAccessLoaded!=='undefined'&&generationAccessLoaded===true);
   await model(f.page,'bytedance/seedance-2.0','1080p');await f.page.waitForTimeout(850);
   const after=await f.page.evaluate(()=>creditEstimate());
   assert.equal(after,before+5);assert.match(await f.page.locator('#create').textContent(),new RegExp(after+'$'));
   assert.equal(f.starts.length,1,'reload alone sends nothing');
   await f.page.locator('#create').click();await f.page.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   assert.equal(f.starts.length,2);assert.equal(f.starts[1].body.estimated_credits,before+5);
   assert.doesNotMatch(await f.page.locator('#creditStatus').textContent(),/消費クレジットが変わりました/);
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('active subscriber saved1080 survives qualification loading; expired storyboard requotes',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:true,storyboard25:true,watermarkRequired:false});
  try{
   await f.page.evaluate(()=>localStorage.setItem('flowvidGenerateDraft',JSON.stringify({model:'bytedance/seedance-2.0',resolution:'1080p',duration:15,aspect:'16:9',mode:'text_to_video',prompt_text_to_video:'Dummy'})));
   await f.page.reload({waitUntil:'networkidle'});
   assert.equal(await f.page.locator('#resolution').inputValue(),'1080p');assert.equal(await f.page.evaluate(()=>creditEstimate()),535);
   await f.page.locator('[data-mode="storyboard"]').evaluate(el=>el.click());await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.0');await f.page.locator('#sbResolution').selectOption('1080p');await f.page.locator('#sbDuration').selectOption('15');
   const before=await f.page.locator('#sbCreditEstimateValue').textContent();
   await f.page.evaluate(()=>{generationAccessLoaded=true;resolution1080Access=false;syncSeedance25PlanUi()});
   assert.equal(await f.page.locator('#sbResolution').inputValue(),'720p');assert.notEqual(await f.page.locator('#sbCreditEstimateValue').textContent(),before);assert.match(await f.page.locator('#sbFastResolutionNotice').textContent(),/720pに変更/);
   assert.equal(f.starts.length,0);assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 for(const prepared of [false,true])await run('Fast saved 1080p restores visibly to 720p, prepared='+prepared,async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:false,storyboard25:false,watermarkRequired:false});
  try{
   await f.page.evaluate(prepared=>{localStorage.setItem(prepared?'flowvidStoryboardDraft':'flowvidGenerateDraft',JSON.stringify({model:'bytedance/seedance-2.0-fast',resolution:'1080p',duration:5,aspect:'16:9',mode:'text_to_video',prompt_text_to_video:'A paper boat',prompt:'A paper boat',prepared,imageUrl:prepared?'https://synthetic.invalid/image.png':undefined}));},prepared);
   await f.page.reload({waitUntil:'networkidle'});
   assert.equal(await f.page.locator('#resolution').inputValue(),'720p');
   assert.equal(await f.page.locator('#resolution option[value="1080p"]').evaluate(el=>el.disabled&&el.hidden),true);
   assert.equal(await f.page.locator('#fastResolutionNotice').evaluate(el=>!el.hidden),true);
   assert.match(await f.page.locator('#fastResolutionNotice').textContent(),/720pに変更/);
   assert.equal(f.starts.length,0);
   await f.page.locator('#mainCard details.settings').evaluate(el=>{el.open=true});
   await f.page.locator('#model').selectOption('bytedance/seedance-2.0');
   assert.equal(await f.page.locator('#resolution option[value="1080p"]').evaluate(el=>el.disabled||el.hidden),false);
   await f.page.locator('[data-mode="storyboard"]').evaluate(el=>el.click());
   await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.0');
   await f.page.locator('#sbResolution').selectOption('1080p');
   await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.0-fast');
   assert.equal(await f.page.locator('#sbResolution').inputValue(),'720p');
   assert.equal(await f.page.locator('#sbResolution option[value="1080p"]').evaluate(el=>el.disabled&&el.hidden),true);
   assert.equal(await f.page.locator('#sbFastResolutionNotice').evaluate(el=>!el.hidden),true);
   assert.equal(f.starts.length,0);assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('purchase: 2.5 Turbo enabled, audio/storyboard restricted, ordinary start sends one authenticated mock request',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,referenceAudio:false,storyboard25:false,watermarkRequired:true});
  try{
   await model(f.page,'bytedance/seedance-2.5','720p');assert.equal(await f.page.locator('#resolution option[value="1080p"]').evaluate(e=>e.disabled&&e.hidden),true);assert.equal(await f.page.locator('#create').isDisabled(),false);assert.equal(await f.page.locator('#audioFile').isDisabled(),true);
   await f.page.locator('#create').click();await f.page.waitForFunction(()=>document.getElementById('creditStatus').style.display!=='none');
   assert.equal(f.starts.length,1);assert.equal(f.starts[0].body.model,'bytedance/seedance-2.5');assert.equal(f.starts[0].headers.authorization,'Bearer synthetic-browser-session');assert.equal(f.starts[0].body.reference_audio_paths,undefined);
   await f.page.locator('[data-mode="storyboard"]').evaluate(el=>el.click());await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.5');assert.equal(await f.page.locator('#sbAnalyzeBtn').isDisabled(),true);assert.match(await f.page.locator('#sbAnalyzeBtn').textContent(),/Premium/);
   assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });

 for(const selected of ['bytedance/seedance-2.0','bytedance/seedance-2.5'])await run('purchase/expired saved1080 resets visibly '+selected,async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:false,referenceAudio:false,storyboard25:false,watermarkRequired:true});
  try{
   await f.page.evaluate(model=>localStorage.setItem('flowvidGenerateDraft',JSON.stringify({model,resolution:'1080p',duration:5,aspect:'16:9',mode:'text_to_video',prompt_text_to_video:'Dummy'})),selected);
   await f.page.reload({waitUntil:'networkidle'});
   assert.equal(await f.page.locator('#resolution').inputValue(),'720p');
   assert.equal(await f.page.locator('#resolution option[value="1080p"]').evaluate(e=>e.disabled&&e.hidden),true);
   assert.match(await f.page.locator('#fastResolutionNotice').textContent(),/720pに変更/);
   assert.equal(f.starts.length,0);assert.deepEqual(f.pageErrors,[]);
  }finally{await f.context.close()}
 });
 await run('free-only: 2.5 blocked, 2.0 and Fast remain usable',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:false,referenceAudio:false,storyboard25:false,watermarkRequired:true});
  try{await model(f.page,'bytedance/seedance-2.5');assert.equal(await f.page.locator('#create').isDisabled(),true);for(const value of ['bytedance/seedance-2.0','bytedance/seedance-2.0-fast']){await model(f.page,value,'720p');assert.equal(await f.page.locator('#create').isDisabled(),false)}assert.equal(f.starts.length,0);assert.deepEqual(f.pageErrors,[])}finally{await f.context.close()}
 });
 await run('active Premium: 2.5, audio, and storyboard capabilities preserved',async()=>{
  const f=await fixture(browser,{ok:true,resolution1080:true,seedance25:true,referenceAudio:true,storyboard25:true,watermarkRequired:false});
  try{await model(f.page,'bytedance/seedance-2.5','1080p');assert.equal(await f.page.locator('#create').isDisabled(),false);assert.equal(await f.page.locator('#audioFile').isDisabled(),false);await f.page.locator('[data-mode="storyboard"]').evaluate(el=>el.click());await f.page.locator('#sbModel').selectOption('bytedance/seedance-2.5');await f.page.evaluate(()=>{sbFile={name:'synthetic-no-upload'};sbSyncPlanAccess()});assert.equal(await f.page.locator('#sbAnalyzeBtn').isDisabled(),false);assert.deepEqual(f.pageErrors,[])}finally{await f.context.close()}
 });
 await run('active Standard plus purchase: normal 2.5 enabled, high-tier extras remain blocked',async()=>{
  const f=await fixture(browser,{ok:true,seedance25:true,resolution1080:true,referenceAudio:false,storyboard25:false,watermarkRequired:false});
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
