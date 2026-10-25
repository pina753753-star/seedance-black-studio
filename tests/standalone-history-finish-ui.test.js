'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
function fixture(file,{result={ok:true,data:{done:true,videoUrl:'https://example.test/wm.mp4'}}, token='test-session',deferred=false}={}){
  const source=fs.readFileSync(path.join(root,file),'utf8');
  const a=source.indexOf('  const watermarkFinishing=new Set();');
  const end=source.indexOf(file==='profile.html'?'  let allItems=[];':'  function renderHistory(',a);
  const calls=[];let reloads=0,release;
  const fakeFetch=async(...args)=>{calls.push(args);if(deferred)await new Promise(resolve=>{release=resolve});if(result.throw)throw new Error('network');return {ok:result.ok,json:async()=>result.data};};
  const context={fetch:fakeFetch,originalFetch:fakeFetch,fvAuthToken:async()=>token,phHistoryAuthToken:async()=>token,loadHist:async()=>{reloads++},loadHistory:async()=>{reloads++},_lastFilterMode:'text_to_video'};
  vm.runInNewContext(source.slice(a,end),context);
  const message={textContent:''};const button={dataset:{jobId:'owned/job ?x=1'},textContent:'透かし付きで仕上げる',disabled:false,parentElement:{querySelector:()=>message}};
  return {source,context,calls,button,message,reloads:()=>reloads,release:()=>release()};
}
for(const file of ['flowvid-history.js','profile.html']){
  test(`${file}: explicit finish sends one authenticated jobId GET and reloads completed history`,async()=>{
    const f=fixture(file);assert.equal(f.calls.length,0);
    await f.context.finishWatermarkJob(f.button);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'/api/seedance-status?jobId=owned%2Fjob%20%3Fx%3D1');
    assert.equal(f.calls[0][1].headers.Authorization,'Bearer test-session');assert.equal(f.calls[0][1].cache,'no-store');
    assert.equal(f.reloads(),1);assert.equal(f.button.disabled,false);
  });
  test(`${file}: concurrent repeated clicks send only once`,async()=>{
    const f=fixture(file,{deferred:true});const first=f.context.finishWatermarkJob(f.button);
    await Promise.resolve();assert.equal(f.button.disabled,true);
    await f.context.finishWatermarkJob({...f.button});assert.equal(f.calls.length,1);
    f.release();await first;assert.equal(f.reloads(),1);
  });
  test(`${file}: unfinished or failed finish does not auto retry/poll/reload`,async()=>{
    for(const result of [{ok:true,data:{done:false,watermarkPending:true}},{ok:false,data:{error:'failure'}},{throw:true}]){
      const f=fixture(file,{result});await f.context.finishWatermarkJob(f.button);
      assert.equal(f.calls.length,1);assert.equal(f.reloads(),0);assert.equal(f.button.disabled,false);
      assert.match(f.message.textContent,/もう一度お試しください/);
    }
  });
  test(`${file}: missing auth prevents a finish request`,async()=>{
    const f=fixture(file,{token:''});await f.context.finishWatermarkJob(f.button);
    assert.equal(f.calls.length,0);assert.equal(f.reloads(),0);assert.equal(f.button.disabled,false);
  });
  test(`${file}: pending metadata is escaped and never rendered as raw playable media`,()=>{
    const source=fs.readFileSync(path.join(root,file),'utf8');
    const a=source.indexOf('  function watermarkPendingCards(');const end=source.indexOf('\n',a);
    const context={esc:s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))};
    vm.runInNewContext(source.slice(a,end),context);
    const html=context.watermarkPendingCards([{jobId:'job" onclick="attack()',prompt:'<script>attack()</script>',output_url:'https://raw.test/video'}]);
    assert.match(html,/透かし付きで仕上げる/);assert.match(html,/&lt;script&gt;/);
    assert.doesNotMatch(html,/<script>|<video|https:\/\/raw|data-url=/);
    assert.equal(context.watermarkPendingCards(null),'');
  });
}
test('history failure has no local raw-URL fallback and editing shows finish guidance',()=>{
  const flow=fs.readFileSync(path.join(root,'flowvid-history.js'),'utf8');
  const profile=fs.readFileSync(path.join(root,'profile.html'),'utf8');
  const generate=fs.readFileSync(path.join(root,'generate-prod.html'),'utf8');
  assert.doesNotMatch(flow,/catch\(_\)\{const list=safeJson\(localStorage\.getItem\(HISTORY_KEY\)/);
  assert.doesNotMatch(profile,/const loc=safeJson\(localStorage\.getItem\(HIST_KEY\)/);
  assert.match(flow,/renderHistory\(items,data\.watermarkPending\)/);
  assert.match(profile,/watermarkPending=Array\.isArray\(data.watermarkPending\)/);
  assert.match(generate,/id="veWatermarkPending"/);assert.match(generate,/data.watermarkPending.length\?'block':'none'/);
  for(const source of [profile,generate])for(const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi))if(m[1].trim())new vm.Script(m[1]);
  new vm.Script(flow);
});
