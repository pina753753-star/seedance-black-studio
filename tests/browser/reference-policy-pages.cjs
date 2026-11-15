'use strict';
// Local static pages only. All requests are intercepted; no remote submission.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
(async()=>{
  const browser=await chromium.launch({executablePath:process.env.PINA_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--host-resolver-rules=MAP * ~NOTFOUND']});
  let passed=0;
  try {
    for(const width of [390,1280]) {
      const ctx=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
      await ctx.route('**/*',route=>{
        const u=new URL(route.request().url());
        if(u.hostname!=='pina.local'||!['/terms.html','/help.html','/privacy.html'].includes(u.pathname))return route.abort();
        return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,u.pathname.slice(1)),'utf8')});
      });
      const p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
      await p.goto('http://pina.local/terms.html#revision-20261115');
      assert.equal(await p.locator('#revision-20261115').isVisible(),true);
      assert.match(await p.locator('#reference-materials').textContent(),/権利・許諾/);
      assert.doesNotMatch(await p.locator('body').textContent(),/第三者に販売・提供することはありません/);
      await p.locator('#revision-20261115 a[href*="help.html"]').click();
      assert.equal(await p.locator('#reference-materials').getAttribute('open'), '');
      assert.equal(await p.locator('#reference-materials div').isVisible(), true);
      assert.match(await p.locator('#reference-materials').textContent(),/本人.*同意|必要な同意/);
      assert.match(await p.locator('#reference-materials').textContent(),/WaveSpeedAI/);
      await p.locator('#reference-materials a[href*="privacy.html"]').click();
      assert.equal(await p.locator('#reference-processing').isVisible(),true);
      assert.match(await p.locator('body').textContent(),/WaveSpeedAI/);
      assert.match(await p.locator('body').textContent(),/参考動画の形式検査・変換/);
      assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      assert.deepEqual(errors,[]);passed++;
      console.log(`PASS ${width}px: terms announcement -> guide -> privacy links and content`);
      await ctx.close();
    }
  } finally {await browser.close();}
  console.log(JSON.stringify({passed,failed:0}));
})().catch(e=>{console.error(e);process.exitCode=1});
