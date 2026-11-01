'use strict';
// Local mock e2e for the Kling dance tab. Every request is intercepted; nothing
// leaves the browser, no real API/upload/purchase. Width via DANCE_E2E_WIDTH.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const origin = 'http://pina.local';
const width = Number(process.env.DANCE_E2E_WIDTH || 1280);
const chromePath = process.env.PINA_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '/usr/bin/chromium');
const passed = [], failures = [];
let unexpectedApi = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const syntheticAuth = `(function(){
 if(window.__syntheticClientReady)return;window.__syntheticClientReady=true;
 const user={id:'browser-owner',email:'browser@example.test',email_confirmed_at:'2026-01-01T00:00:00Z'};
 const session={access_token:'synthetic-browser-session',user};
 const balance={free_credits:1000,subscription_credits:0,purchased_credits:1000,subscription_expires_at:null,purchased_expires_at:'2999-01-01T00:00:00Z'};
 window.__uploads=[];
 const client={auth:{getSession:async()=>({data:{session}}),getUser:async(token)=>({data:{user:token===session.access_token||!token?user:null}}),signOut:async()=>{},onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  storage:{from:()=>({uploadToSignedUrl:async(p)=>{window.__uploads.push(p);return {error:null}}})},
  from(table){const chain={select(){return chain},eq(){return chain},maybeSingle:async()=>({data:table==='profiles'?{plan:'free',role:'user'}:balance,error:null})};return chain}};
 window.FLOWVID_AUTH={supabaseUrl:'https://synthetic.invalid',supabaseAnonKey:'synthetic-only'};
 window.supabase={createClient:()=>client};window.flowvidSupabaseClient=()=>client;
})();`;
const caps = { ok: true, seedance25: true, resolution1080: false, referenceAudio: false, storyboard25: false, watermarkRequired: true };
const allowed = new Set(['generate-prod.html', 'flowvid-history.js', 'flowvid-open-inline.js', 'auth-guard.js', 'dance-kling.js']);
async function fixture(browser, o = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } });
  await context.addInitScript(syntheticAuth);
  const calls = { recuts: 0, starts: [], deletes: [], confirms: [], imageUploads: 0, videoUploads: 0, polls: 0, inflight: 0, maxInflight: 0 }, pageErrors = [];
  // Stateful backend for the start -> processing -> complete -> history flow.
  const flow = { task: null, completed: false, failed: false, pollScript: o.pollScript || ['processing', 'processing', 'done'] };
  // The page polls every 12 s; shorten it so the mock flow finishes quickly.
  await context.addInitScript((tick) => { const si = window.setInterval; window.setInterval = (fn, ms, ...a) => si(fn, ms === 12000 ? tick : ms, ...a); }, o.tick || 150);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'pina.local') {
      if (url.pathname.includes('@supabase/supabase-js')) return route.fulfill({ contentType: 'application/javascript', body: syntheticAuth });
      return route.abort('blockedbyclient');
    }
    const json = (d, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
    const p = url.pathname;
    if (p === '/auth-config.js') return route.fulfill({ contentType: 'application/javascript', body: syntheticAuth });
    if (p === '/api/reference-dance-access') return json({ ok: true, allowed: o.allowed !== false, ...(o.allowed !== false ? { klingDance: { method: 'kling_v3_motion_control', creditsPerSecond: o.rate === undefined ? 19 : o.rate, minSeconds: 4, ...(o.lengthSelect ? { maxSeconds: 20, imageOrientationMaxSeconds: 10, sourceMaxSeconds: 30, lengthSelectEnabled: true } : { maxSeconds: 10 }) } } : {}) });
    if (p === '/api/credit-access') return json(caps);
    if (p === '/api/generated-videos') return json({ ok: true, rows: flow.completed ? [{ id: 'task-1', job_id: 'job-1', status: 'completed', prompt: 'dance', provider: 'wavespeed', model: 'bytedance/seedance-2.5', mode: 'reference_to_video', dance_method: 'kling_v3_motion_control', video_url: origin + '/out.mp4', duration_seconds: 8, aspect_ratio: '16:9', created_at: new Date().toISOString() }, { id: 'task-0', job_id: 'job-0', status: 'completed', prompt: 'older reference video', provider: 'wavespeed', model: 'bytedance/seedance-2.5', mode: 'reference_to_video', dance_method: '', video_url: origin + '/old.mp4', duration_seconds: 5, aspect_ratio: '9:16', created_at: new Date().toISOString() }] : [] });
    if (p === '/api/pending-tasks') return json({ ok: true, tasks: flow.task && !flow.completed && !flow.failed ? [flow.task] : [] });
    if (p === '/api/seedance-status') {
      calls.polls++;
      calls.inflight++; calls.maxInflight = Math.max(calls.maxInflight, calls.inflight);
      if (o.pollDelay) await new Promise(r => setTimeout(r, o.pollDelay));
      calls.inflight--;
      const step = flow.task ? flow.pollScript[Math.min(calls.pollIndex = (calls.pollIndex || 0), flow.pollScript.length - 1)] : 'processing';
      calls.pollIndex = (calls.pollIndex || 0) + 1;
      if (step === 'network') return route.abort('failed');
      // Same shape api/seedance-status.js returns for a provider HTTP error: body.status is the numeric HTTP code.
      const httpErr = { http502: 502, http503: 503, http429: 429, http401: 401, http403: 403, http404: 404 }[step];
      if (httpErr) return json({ ok: false, status: httpErr, provider: 'wavespeed', jobId: 'job-1', jobStatus: step === 'http502' ? 'error' : '', done: false, error: 'status_lookup_failed', response: { message: 'upstream ' + httpErr } }, httpErr);
      if (step === 'html502') return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' });
      // Real failure shape of the watermark / result-unavailable paths: HTTP 200, body ok:false, jobStatus failed.
      // WaveSpeed provider job timeout: HTTP 200, provider wavespeed, jobStatus timeout. The server tries the refund; refunded may be false.
      if (step === 'timeout_refunded' || step === 'timeout_unrefunded') { flow.failed = true; return json({ ok: true, status: 200, provider: 'wavespeed', jobStatus: 'timeout', done: false, refunded: step === 'timeout_refunded', refundConfirmed: step === 'timeout_refunded' }); }
      // A gateway error whose body happens to mention timeout must stay a transient status-check failure.
      if (step === 'timeout_other') return json({ ok: true, status: 200, provider: 'openrouter', jobStatus: 'timeout', done: false });
      if (step === 'http502_timeout') return json({ ok: false, status: 502, provider: 'wavespeed', jobStatus: 'timeout', done: false, error: 'status_lookup_failed' }, 502);
      if (step === 'http408') return json({ ok: false, status: 408, provider: 'wavespeed', jobStatus: '', done: false, error: 'request_timeout' }, 408);
      if (step === 'wmfail') { flow.failed = true; return json({ ok: false, status: 200, jobStatus: 'failed', done: false, error: 'watermark_failed', refunded: true }); }
      if (step === 'failed') { flow.failed = true; return json({ ok: true, status: 200, jobStatus: 'failed', done: false, refunded: true, refundConfirmed: true }); }
      if (step === 'done') { flow.completed = true; return json({ ok: true, status: 200, jobStatus: 'completed', done: true, videoUrl: origin + '/out.mp4' }); }
      return json({ ok: true, status: 200, jobStatus: 'processing', done: false });
    }
    if (p === '/api/reference-dance-latest') return json({ok:true,asset:o.restored?{id:'stored',status:'ready',name:'stored.mp4',durationMs:20000,billableSeconds:20}:null});
    if (p === '/api/reference-image-upload-url') { calls.imageUploads++; return json({ ok: true, signedUrl: 'x', token: 't', path: 'q/img.png', bucket: 'reference-image-quarantine' }); }
    if (p === '/api/reference-image-confirm-upload') return json({ ok: true, publicUrl: origin + '/identity.png' });
    if (p === '/api/reference-dance-upload-url') { calls.videoUploads++; return json({ ok: true, assetId: 'asset-' + calls.videoUploads, path: 'v.mp4', token: 't', bucket: 'seedance-reference-video' }); }
    if (p === '/api/reference-dance-confirm-upload') {
      const body = request.postDataJSON(); calls.confirms.push(body);
      if (o.confirmFail) return json({ ok: false, error: 'VIDEO_DURATION_INVALID', message: '動画の長さが対応外です' }, 400);
      if (o.lengthSelect) {
        // Server model: the sealed master is min(original, 20 s); a length choice cuts exactly N seconds from it.
        const source = o.sourceMs || 16000, master = Math.min(source, 20000);
        if (body.profile !== 'motion') return json({ ok: false, error: 'profile_missing' }, 400);
        const recut = Object.prototype.hasOwnProperty.call(body, 'useSeconds');
        if (recut && o.recutDelay) await new Promise(r => setTimeout(r, typeof o.recutDelay === 'function' ? o.recutDelay(body.useSeconds) : o.recutDelay));
        if (recut && o.recutFail && !calls.recutFailed) { calls.recutFailed = true; return json({ ok: false, error: 'reference_video_check_failed', retryable: true, message: '参考動画の検査に失敗しました' }, 503); }
        if (recut && body.useSeconds !== null && body.useSeconds * 1000 > master) return json({ ok: false, error: 'motion_length_invalid', message: '元の動画より長い区間は選べません。' }, 400);
        const ms = recut && body.useSeconds !== null ? body.useSeconds * 1000 : master;
        calls.lengthState = { ms, useSeconds: recut ? body.useSeconds : null };
        return json({ ok: true, status: 'ready', durationMs: ms, billableSeconds: Math.max(4, Math.ceil(ms / 1000)),
          motion: { mode: recut && body.useSeconds !== null ? 'cut' : 'whole', useSeconds: recut ? body.useSeconds : null, capped: source > 20000, sourceDurationMs: source, masterDurationMs: master } });
      }
      const sec = o.seconds || 8;
      return json({ ok: true, status: 'ready', durationMs: o.durationMs || sec * 1000 - 200, billableSeconds: sec });
    }
    if (p === '/api/reference-dance-delete') { calls.deletes.push(request.postDataJSON()); return json({ ok: true }); }
    if (p === '/api/seedance-start') {
      calls.starts.push({ headers: request.headers(), body: request.postDataJSON() });
      if (o.startDelay) await new Promise(r => setTimeout(r, o.startDelay));
      if (o.start409) return json({ ok: false, error: 'credit_cost_changed', credits: 999, estimatedCredits: request.postDataJSON().estimated_credits }, 409);
      if (o.startProviderStarted) { flow.task = { id: 'task-1', mode: 'reference_to_video', model: 'bytedance/seedance-2.5', prompt: 'dance', resolution: '720p', duration_seconds: 8, aspect_ratio: '16:9', status: 'processing', api_task_id: 'job-1', polling_url: 'https://api.wavespeed.ai/api/v3/predictions/job-1/result', api_provider: 'wavespeed', created_at: new Date().toISOString(), settings: { dance_method: 'kling_v3_motion_control' } }; return json({ ok: false, error: 'generation_tracking_persistence_failed', message: '動画生成は開始されましたが、生成情報の保存に失敗しました。再度生成せず、サポートへお問い合わせください。', providerStarted: true, taskId: 'task-1', jobId: 'job-1', pollingUrl: flow.task.polling_url }, 503); }
      if (o.start502) return json({ ok: false, error: 'provider', message: '提供元がエラーを返しました', refunded: false }, 502);
      if (o.start400) return json({ ok: false, error: o.start400, message: 'rejected' }, 400);
      if (o.startFail) return json({ ok: false, error: 'provider', message: '失敗しました', refunded: true }, 502);
      flow.task = { id: 'task-1', mode: 'reference_to_video', model: 'bytedance/seedance-2.5', prompt: 'dance', resolution: '720p', duration_seconds: 8, aspect_ratio: '16:9', status: 'processing', api_task_id: 'job-1', polling_url: 'https://api.wavespeed.ai/api/v3/predictions/job-1/result', api_provider: 'wavespeed', created_at: new Date().toISOString(), settings: { dance_method: 'kling_v3_motion_control' } };
      return json({ ok: true, jobId: 'job-1', taskId: 'task-1', pollingUrl: flow.task.polling_url, creditCost: 96 }, 202);
    }
    if (p.startsWith('/api/')) { unexpectedApi.push(p); return json({ ok: false, error: 'unmocked_api' }, 503); }
    const name = p.slice(1);
    if (allowed.has(name)) return route.fulfill({ contentType: name.endsWith('.html') ? 'text/html' : 'application/javascript', body: fs.readFileSync(path.join(root, name), 'utf8') });
    return route.fulfill({ status: 204, body: '' });
  });
  const page = await context.newPage();
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.goto(origin + '/generate-prod.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => typeof generationAccessLoaded !== 'undefined' && generationAccessLoaded === true);
  return { context, page, calls, pageErrors, flow };
}
async function run(name, fn) { try { await fn(); passed.push(name); console.log('PASS ' + name); } catch (e) { failures.push({ name, error: String(e.stack || e) }); console.log('FAIL ' + name + ': ' + e.message); } }
async function openDance(p) { await p.locator('#danceTab').waitFor({ state: 'visible' }); await p.locator('#danceTab').click(); await p.locator('#kdSection').waitFor({ state: 'visible' }); }
async function fill(p, { seconds } = {}) {
  await p.locator('#kdImageFile').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await p.waitForFunction(() => window.flowvidDanceKling.state.image.status === 'completed');
  await p.locator('#kdRights').check();
  await p.locator('#kdVideoFile').setInputFiles({ name: 'dance.mp4', mimeType: 'video/mp4', buffer: Buffer.from('00') });
  await p.waitForFunction(() => ['ready', 'failed'].includes(window.flowvidDanceKling.state.video.status));
}
async function noHScroll(p) { return p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1); }
(async()=>{
const browser=await chromium.launch({executablePath:chromePath,headless:true,args:['--no-sandbox','--host-resolver-rules=MAP * ~NOTFOUND']});
try{
for(const [ms,cr] of [[11507,228],[16000,304],[16200,323],[17000,323],[20000,380]])await run(`purchase-only ${ms}ms => ${cr}cr, no generation click`,async()=>{
 const f=await fixture(browser,{lengthSelect:true,sourceMs:ms});try{const p=f.page;await openDance(p);
 await p.locator('#kdRights').check();await p.locator('#kdVideoFile').setInputFiles({name:'dance.mp4',mimeType:'video/mp4',buffer:Buffer.from('00')});await p.waitForFunction(()=>window.flowvidDanceKling.state.video.status==='ready');
 assert.equal(await p.locator('#kdCreate').isDisabled(),true);assert.match(await p.locator('#kdReason').textContent(),/キャラクター画像/);
 await p.locator('#kdImageFile').setInputFiles({name:'me.png',mimeType:'image/png',buffer:PNG});await p.waitForFunction(()=>window.flowvidDanceKling.state.image.status==='completed');
 assert.equal(await p.locator('#kdCreate').isDisabled(),false);assert.match(await p.locator('#kdCreate').textContent(),new RegExp(String(cr)));assert.equal(await p.locator('#kdOrientationNote').isVisible(),true);assert.equal(f.calls.starts.length,0);assert.deepEqual(f.pageErrors,[]);
 }finally{await f.context.close()}
});
await run('source over 20 seconds automatically uses 20; shorter selection and auto restore',async()=>{
 const f=await fixture(browser,{lengthSelect:true,sourceMs:25300});try{await openDance(f.page);await fill(f.page);assert.equal(await f.page.locator('#kdCreate').isDisabled(),false);assert.equal(await f.page.locator('#kdLength').inputValue(),'whole');assert.match(await f.page.locator('#kdSourceInfo').textContent(),/自動で先頭20秒/);assert.equal(f.calls.confirms.length,1);await f.page.locator('#kdLength').selectOption('8');await f.page.waitForFunction(()=>window.flowvidDanceKling.state.video.durationMs===8000);assert.match(await f.page.locator('#kdCreate').textContent(),/152/);await f.page.locator('#kdLength').selectOption('whole');await f.page.waitForFunction(()=>window.flowvidDanceKling.state.video.durationMs===20000);await f.page.waitForFunction(()=>window.flowvidDanceKling.state.video.chosen);assert.equal(await f.page.locator('#kdCreate').isDisabled(),false);assert.match(await f.page.locator('#kdCreate').textContent(),/380/);assert.equal(f.calls.starts.length,0)}finally{await f.context.close()}
});
await run('reload restores owned sealed 20-second clip; no reinspection, image required, no extra length acknowledgement',async()=>{
 const f=await fixture(browser,{lengthSelect:true,restored:true});try{const p=f.page;await openDance(p);await p.waitForFunction(()=>window.flowvidDanceKling.state.video.id==='stored');assert.equal(await p.locator('#kdCreate').isDisabled(),true);assert.match(await p.locator('#kdReason').textContent(),/キャラクター画像/);
 await p.locator('#kdImageFile').setInputFiles({name:'me.png',mimeType:'image/png',buffer:PNG});await p.waitForFunction(()=>window.flowvidDanceKling.state.image.status==='completed');assert.equal(await p.locator('#kdCreate').isDisabled(),false);assert.match(await p.locator('#kdCreate').textContent(),/380/);assert.equal(f.calls.confirms.length,0);assert.equal(f.calls.deletes.length,0);assert.equal(f.calls.starts.length,0);
 await p.reload({waitUntil:'networkidle'});await openDance(p);await p.waitForFunction(()=>window.flowvidDanceKling.state.video.id==='stored');assert.equal(await p.locator('#kdCreate').isDisabled(),true);assert.equal(f.calls.confirms.length,0);assert.equal(await noHScroll(p),true);assert.deepEqual(f.pageErrors,[]);
 }finally{await f.context.close()}
});
}finally{await browser.close()}
console.log(JSON.stringify({width,passed,failures,unexpectedApi},null,2));if(failures.length||unexpectedApi.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
