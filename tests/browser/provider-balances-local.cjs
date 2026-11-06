const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
(async()=>{
 const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 let passed=0;const unexpected=[];
 function rows(){return [{id:'wavespeed',state:'current',balance:0,currency:'USD',fetchedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),error:null},{id:'fal',state:'stale',balance:12.34,currency:'USD',fetchedAt:'2026-01-01T00:00:00Z',checkedAt:new Date().toISOString(),error:'rate_limited'}]}
 async function fixture(width){
  const page=await browser.newPage({viewport:{width,height:900}});let calls=0;let response={status:200,body:{ok:true,providers:rows()}};let delayed=null;
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.hostname==='cdn.jsdelivr.net')return route.fulfill({contentType:'application/javascript',body:`window.sessionReads=0;window.mockSession={user:{id:'one'},access_token:'mock-token'};window.mockEvent=()=>{};window.supabase={createClient:()=>({auth:{getSession:async()=>{window.sessionReads++;return {data:{session:window.mockSession}}},onAuthStateChange:cb=>{window.mockEvent=(session)=>{window.mockSession=session;cb('SIGNED_IN',session)};setTimeout(()=>cb('INITIAL_SESSION',window.mockSession),0)}}})};`});
   if(url.origin!=='https://pina.test'){unexpected.push(url.origin);return route.abort()}
   if(url.pathname==='/auth-config.js')return route.fulfill({contentType:'application/javascript',body:"window.FLOWVID_AUTH={supabaseUrl:'https://mock.invalid',supabaseAnonKey:'mock-public'};"});
   if(url.pathname==='/api/admin-provider-balances'){calls++;if(delayed)await delayed;return route.fulfill({status:response.status,contentType:'application/json',body:JSON.stringify(response.body)}).catch(()=>{})}
   if(url.pathname==='/away.html')return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Local navigation fixture</title><p>Mock page</p>'});
   const name=url.pathname.slice(1);if(['admin-provider-balances.html','admin-provider-balances.js'].includes(name))return route.fulfill({contentType:name.endsWith('.html')?'text/html':'application/javascript',body:fs.readFileSync(path.join(root,name),'utf8')});
   if(name==='favicon.ico')return route.fulfill({status:204});
   unexpected.push(url.pathname);return route.abort();
  });
  await page.goto('https://pina.test/admin-provider-balances.html');await page.locator('#balances:not([hidden])').waitFor();
  return {page,get calls(){return calls},setResponse:r=>response=r,delay:p=>delayed=p};
 }
 for(const width of [320,390,768,1280]){
  const {page}=await fixture(width);
  assert.equal(await page.locator('.card').count(),4);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const columns=await page.locator('.grid').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length);
  assert.equal(columns,width<360?1:width>=900?3:2);
  assert.match(await page.locator('.card').nth(0).innerText(),/残高なし/);
  assert.match(await page.locator('.card').nth(1).innerText(),/古い残高/);
  await page.locator('summary').first().focus();await page.keyboard.press('Enter');assert.equal(await page.locator('details').first().getAttribute('open'),'');
  await page.keyboard.press('Enter');assert.equal(await page.locator('details').first().getAttribute('open'),null);
  await page.close();passed++;console.log('PASS layout/details/zero/stale '+width);
 }
 {
  const s=await fixture(390);await s.page.evaluate(()=>window.mockEvent(null));assert.equal(await s.page.locator('.card').count(),0);assert.equal(await s.page.locator('#refresh').isDisabled(),true);passed++;console.log('PASS logout clears');await s.page.close();
 }
 {
  const s=await fixture(390);let release; s.delay(new Promise(r=>release=r));await s.page.locator('#refresh').click();await s.page.waitForFunction(()=>document.querySelector('#message').textContent==='確認中…');await s.page.evaluate(()=>window.mockEvent(null));release();await s.page.waitForTimeout(80);assert.equal(await s.page.locator('.card').count(),0);passed++;console.log('PASS late response after logout discarded');await s.page.close();
 }
 {
  const s=await fixture(390);s.setResponse({status:403,body:{ok:false}});await s.page.evaluate(()=>window.mockEvent({user:{id:'other'},access_token:'other-mock'}));await s.page.waitForFunction(()=>document.querySelector('#message').textContent.includes('確認できません'));assert.equal(await s.page.locator('.card').count(),0);passed++;console.log('PASS account switch unauthorized clears');await s.page.close();
 }
 {
  const s=await fixture(390);s.setResponse({status:200,body:{ok:true,providers:[{id:'wavespeed',state:'unknown',balance:null,error:'timeout'},{id:'fal',state:'unconfigured',balance:null,error:'not_configured'}]}});await s.page.locator('#refresh').click();await s.page.waitForFunction(()=>document.querySelector('.state').textContent.includes('時間切れ'));assert.equal(await s.page.locator('.amount').first().textContent(),'—');passed++;console.log('PASS unknown not zero');await s.page.close();
 }
 {
  const s=await fixture(390);const r=rows();r[0].balance=9;r[0].fetchedAt='2026-01-01T00:00:00Z';s.setResponse({status:200,body:{ok:true,providers:r}});await s.page.locator('#refresh').click();await s.page.waitForFunction(()=>document.querySelector('.state').textContent.includes('更新してください'));passed++;console.log('PASS aged success explicitly stale');await s.page.close();
 }
 {
  const s=await fixture(390);let release;s.delay(new Promise(r=>release=r));await s.page.locator('#refresh').click();await s.page.evaluate(()=>{for(let i=0;i<20;i++)document.querySelector('#refresh').click()});await s.page.waitForTimeout(30);assert.equal(s.calls,2);release();passed++;console.log('PASS repeat clicks bounded');await s.page.close();
 }

 // Synthetic persisted events exercise the BFCache handler regardless of Chromium's
 // cache eligibility. These do not claim a real iOS/Safari BFCache restore.
 {
  const s=await fixture(390);const before=s.calls;const reads=await s.page.evaluate(()=>window.sessionReads);
  await s.page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  assert.equal(await s.page.locator('.card').count(),0);
  let release;s.delay(new Promise(r=>release=r));
  const fresh=rows();fresh[0].balance=7;s.setResponse({status:200,body:{ok:true,providers:fresh}});
  await s.page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await s.page.waitForFunction(n=>window.sessionReads>n,reads);
  assert.equal(await s.page.locator('.card').count(),0,'old balances hidden during reauthentication');
  await s.page.waitForTimeout(30);assert.equal(s.calls,before+1);
  release();await s.page.locator('#balances:not([hidden])').waitFor();
  assert.match(await s.page.locator('.amount').first().textContent(),/7/);
  passed++;console.log('PASS synthetic BFCache restoration clears and fetches after session read');await s.page.close();
 }
 for(const reason of ['logged-out','account-changed','server-denied']){
  const s=await fixture(390);const before=s.calls;const reads=await s.page.evaluate(()=>window.sessionReads);
  await s.page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  if(reason==='logged-out')await s.page.evaluate(()=>{window.mockSession=null});
  if(reason==='account-changed')await s.page.evaluate(()=>{window.mockSession={user:{id:'other'},access_token:'other-mock'}});
  if(reason==='server-denied')s.setResponse({status:403,body:{ok:false}});
  await s.page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
  await s.page.waitForFunction(()=>document.querySelector('#message').textContent.includes('確認できません'));
  assert.ok(await s.page.evaluate(n=>window.sessionReads>n,reads));
  assert.equal(await s.page.locator('.card').count(),0);
  assert.equal(s.calls,before+(reason==='server-denied'?1:0));
  passed++;console.log('PASS synthetic BFCache '+reason+' cannot restore old balances');await s.page.close();
 }
 {
  const s=await fixture(390);const before=s.calls;
  await s.page.goto('https://pina.test/away.html');
  s.setResponse({status:200,body:{ok:true,providers:rows().map(r=>({...r,balance:8}))}});
  await s.page.goBack();await s.page.locator('#balances:not([hidden])').waitFor();
  assert.ok(s.calls>before,'back rechecks API');assert.match(await s.page.locator('.amount').first().textContent(),/8/);
  await s.page.goForward();assert.match(s.page.url(),/away.html/);
  s.setResponse({status:403,body:{ok:false}});
  await s.page.goBack();await s.page.waitForFunction(()=>document.querySelector('#message').textContent.includes('確認できません'));
  assert.equal(await s.page.locator('.card').count(),0);
  passed++;console.log('PASS actual history back/forward with authorization revoked');await s.page.close();
 }
 assert.deepEqual(unexpected,[]);await browser.close();console.log(JSON.stringify({passed,unexpectedExternalRequests:unexpected}));
})().catch(e=>{console.error(e);process.exit(1)});
