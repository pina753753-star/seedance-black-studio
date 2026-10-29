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
 const balance={free_credits:1000,subscription_credits:0,purchased_credits:1000,subscription_expires_at:'2999-01-01T00:00:00Z'};
 window.__uploads=[];
 const client={auth:{getSession:async()=>({data:{session}}),getUser:async(token)=>({data:{user:token===session.access_token||!token?user:null}}),signOut:async()=>{},onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  storage:{from:()=>({uploadToSignedUrl:async(p)=>{window.__uploads.push(p);return {error:null}}})},
  from(table){const chain={select(){return chain},eq(){return chain},maybeSingle:async()=>({data:table==='profiles'?{plan:'free',role:'user'}:balance,error:null})};return chain}};
 window.FLOWVID_AUTH={supabaseUrl:'https://synthetic.invalid',supabaseAnonKey:'synthetic-only'};
 window.supabase={createClient:()=>client};window.flowvidSupabaseClient=()=>client;
})();`;
const caps = { ok: true, seedance25: true, resolution1080: true, referenceAudio: false, storyboard25: false, watermarkRequired: false };
const allowed = new Set(['generate-prod.html', 'flowvid-history.js', 'flowvid-open-inline.js', 'auth-guard.js', 'dance-kling.js']);
async function fixture(browser, o = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } });
  await context.addInitScript(syntheticAuth);
  const calls = { starts: [], deletes: [], confirms: [], imageUploads: 0, videoUploads: 0, polls: 0 }, pageErrors = [];
  // Stateful backend for the start -> processing -> complete -> history flow.
  const flow = { task: null, completed: false, failed: false, pollScript: o.pollScript || ['processing', 'processing', 'done'] };
  // The page polls every 12 s; shorten it so the mock flow finishes quickly.
  await context.addInitScript(() => { const si = window.setInterval; window.setInterval = (fn, ms, ...a) => si(fn, ms === 12000 ? 150 : ms, ...a); });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname !== 'pina.local') {
      if (url.pathname.includes('@supabase/supabase-js')) return route.fulfill({ contentType: 'application/javascript', body: syntheticAuth });
      return route.abort('blockedbyclient');
    }
    const json = (d, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
    const p = url.pathname;
    if (p === '/auth-config.js') return route.fulfill({ contentType: 'application/javascript', body: syntheticAuth });
    if (p === '/api/reference-dance-access') return json({ ok: true, allowed: o.allowed !== false, ...(o.allowed !== false ? { klingDance: { method: 'kling_v3_motion_control', creditsPerSecond: o.rate === undefined ? 19 : o.rate, minSeconds: 3, maxSeconds: 10 } } : {}) });
    if (p === '/api/credit-access') return json(caps);
    if (p === '/api/generated-videos') return json({ ok: true, rows: flow.completed ? [{ id: 'task-1', job_id: 'job-1', status: 'completed', prompt: 'dance', provider: 'wavespeed', model: 'bytedance/seedance-2.5', mode: 'reference_to_video', dance_method: 'kling_v3_motion_control', video_url: origin + '/out.mp4', duration_seconds: 8, aspect_ratio: '16:9', created_at: new Date().toISOString() }, { id: 'task-0', job_id: 'job-0', status: 'completed', prompt: 'older reference video', provider: 'wavespeed', model: 'bytedance/seedance-2.5', mode: 'reference_to_video', dance_method: '', video_url: origin + '/old.mp4', duration_seconds: 5, aspect_ratio: '9:16', created_at: new Date().toISOString() }] : [] });
    if (p === '/api/pending-tasks') return json({ ok: true, tasks: flow.task && !flow.completed && !flow.failed ? [flow.task] : [] });
    if (p === '/api/seedance-status') {
      calls.polls++;
      const step = flow.task ? flow.pollScript[Math.min(calls.pollIndex = (calls.pollIndex || 0), flow.pollScript.length - 1)] : 'processing';
      calls.pollIndex = (calls.pollIndex || 0) + 1;
      if (step === 'network') return route.abort('failed');
      if (step === 'http502') return json({ ok: false, error: 'status_lookup_failed' }, 502);
      if (step === 'failed') { flow.failed = true; return json({ ok: true, status: 200, jobStatus: 'failed', done: false, refunded: true, refundConfirmed: true }); }
      if (step === 'done') { flow.completed = true; return json({ ok: true, status: 200, jobStatus: 'completed', done: true, videoUrl: origin + '/out.mp4' }); }
      return json({ ok: true, status: 200, jobStatus: 'processing', done: false });
    }
    if (p === '/api/reference-dance-latest') return json({ ok: true, asset: null });
    if (p === '/api/reference-image-upload-url') { calls.imageUploads++; return json({ ok: true, signedUrl: 'x', token: 't', path: 'q/img.png', bucket: 'reference-image-quarantine' }); }
    if (p === '/api/reference-image-confirm-upload') return json({ ok: true, publicUrl: origin + '/identity.png' });
    if (p === '/api/reference-dance-upload-url') { calls.videoUploads++; return json({ ok: true, assetId: 'asset-' + calls.videoUploads, path: 'v.mp4', token: 't', bucket: 'seedance-reference-video' }); }
    if (p === '/api/reference-dance-confirm-upload') {
      const body = request.postDataJSON(); calls.confirms.push(body);
      if (o.confirmFail) return json({ ok: false, error: 'VIDEO_DURATION_INVALID', message: '動画の長さが対応外です' }, 400);
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
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--no-sandbox', '--host-resolver-rules=MAP * ~NOTFOUND'] });
    await run(`[${width}] tab hidden for non-admin; existing tabs unchanged`, async () => {
      const f = await fixture(browser, { allowed: false });
      try {
        assert.equal(await f.page.locator('#danceTab').isVisible(), false);
        assert.deepEqual(await f.page.locator('.tabs button:visible').evaluateAll(b => b.map(x => x.dataset.mode)), ['reference_to_video', 'image_to_video', 'text_to_video']);
        assert.equal(await f.page.locator('#mainCard').isVisible(), true);
        assert.deepEqual(f.pageErrors, []);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] admin: tab visible independent of model select; no overflow; estimate parity display/sent`, async () => {
      const f = await fixture(browser);
      try {
        const p = f.page;
        // the mainCard model select stays on its default; the dance entrance does not depend on it
        assert.notEqual(await p.locator('#model').inputValue(), 'bytedance/seedance-2.5-turbo');
        await openDance(p);
        assert.equal(await p.locator('#mainCard').isVisible(), false);
        assert.equal(await p.locator('#kdCreate').isDisabled(), true);
        await fill(p, { seconds: 8 });
        assert.match(await p.locator('#kdCreate').textContent(), /152$/);
        await p.locator('#kdPrompt').fill('dance');
        assert.equal(await p.locator('#kdCreate').isDisabled(), false);
        assert.equal(await noHScroll(p), true);
        await p.locator('#kdCreate').click();
        await p.waitForFunction(() => document.querySelector('[data-ptask-id]'));
        assert.equal(f.calls.starts.length, 1);
        const b = f.calls.starts[0].body;
        assert.equal(b.estimated_credits, 152);
        assert.equal(b.dance_method, 'kling_v3_motion_control');
        assert.equal(b.reference_video_asset_id, 'asset-1');
        assert.deepEqual(b.input_references, [origin + '/identity.png']);
        assert.equal('character_orientation' in b, false);
        assert.equal('keep_original_sound' in b, false);
        assert.equal(f.calls.confirms[0].allowBoundaryTrim, false);
        assert.deepEqual(f.pageErrors, []);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] price undecided: no estimate, send disabled, nothing sent`, async () => {
      const f = await fixture(browser, { rate: null });
      try {
        const p = f.page; await openDance(p);
        await p.locator('#kdImageFile').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
        await p.locator('#kdPrompt').fill('dance');
        assert.equal(await p.locator('#kdCreate').isDisabled(), true);
        assert.equal(await p.locator('#kdVideoFile').isDisabled(), true);
        assert.equal(await p.locator('#kdCreate').textContent(), '作成する');
        assert.equal(f.calls.starts.length, 0);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] over-10s video: blocked, not trimmed, nothing sent`, async () => {
      const f = await fixture(browser, { seconds: 12 });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        assert.equal(await p.locator('#kdCreate').isDisabled(), true);
        assert.match(await p.locator('#kdCreate').getAttribute('title'), /10秒/);
        assert.equal(f.calls.confirms[0].allowBoundaryTrim, false);
        assert.equal(f.calls.starts.length, 0);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] seconds boundaries: 4 s=76, 5 s=95, 10 s=190 cr are accepted; 10.001 s (11 s billed) is blocked`, async () => {
      for (const [ms, sec, credits] of [[4000, 4, 76], [4001, 5, 95], [5000, 5, 95], [10000, 10, 190], [10001, 11, null]]) {
        const f = await fixture(browser, { seconds: sec, durationMs: ms });
        try {
          const p = f.page; await openDance(p); await fill(p);
          await p.locator('#kdPrompt').fill('dance');
          if (credits === null) {
            assert.equal(await p.locator('#kdCreate').isDisabled(), true);
            assert.equal(await p.evaluate(() => window.flowvidDanceKling.estimate()), null);
          } else {
            assert.equal(await p.evaluate(() => window.flowvidDanceKling.estimate()), credits);
            assert.match(await p.locator('#kdCreate').textContent(), new RegExp(credits + '$'));
            await p.locator('#kdCreate').click();
            await p.waitForFunction(() => document.querySelector('[data-ptask-id]'));
            assert.equal(f.calls.starts[0].body.estimated_credits, credits);
          }
        } finally { await f.context.close(); }
      }
    });
    await run(`[${width}] video inspection failure shows the reason and sends nothing`, async () => {
      const f = await fixture(browser, { confirmFail: true });
      try {
        const p = f.page; await openDance(p); await fill(p);
        assert.match(await p.locator('#kdVideoNote').textContent(), /長さが対応外/);
        assert.equal(await p.locator('#kdCreate').isDisabled(), true);
        assert.equal(f.calls.starts.length, 0);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] double click sends once (in-flight guard)`, async () => {
      const f = await fixture(browser, { startDelay: 400 });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').dblclick();
        await p.locator('#kdCreate').click({ force: true }).catch(() => {});
        await p.waitForTimeout(900);
        assert.equal(f.calls.starts.length, 1);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] 409 credit_cost_changed: message shown, inputs retained, can retry`, async () => {
      const f = await fixture(browser, { start409: true });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').click();
        await p.locator('#kdStatus').waitFor({ state: 'visible' });
        assert.match(await p.locator('#kdStatus').textContent(), /変わりました/);
        assert.equal(await p.evaluate(() => window.flowvidDanceKling.state.video.status), 'ready');
        assert.equal(await p.locator('#kdCreate').isDisabled(), false);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] 400 and provider failure surface on the card, inputs retained`, async () => {
      for (const o of [{ start400: 'kling_dance_duration_unsupported' }, { startFail: true }]) {
        const f = await fixture(browser, o);
        try {
          const p = f.page; await openDance(p); await fill(p);
          await p.locator('#kdPrompt').fill('dance');
          await p.locator('#kdCreate').click();
          await p.waitForFunction(() => document.querySelector('[data-ptask-id]')?.textContent.match(/rejected|失敗/));
          assert.equal(await p.evaluate(() => window.flowvidDanceKling.state.video.status), 'ready');
          assert.equal(f.calls.starts.length, 1);
        } finally { await f.context.close(); }
      }
    });
    await run(`[${width}] tab switch keeps dance draft and main-card draft independently`, async () => {
      const f = await fixture(browser);
      try {
        const p = f.page;
        await p.locator('#prompt').fill('main draft');
        await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance draft');
        for (const m of ['text_to_video', 'image_to_video', 'reference_to_video']) {
          await p.locator(`.tabs button[data-mode="${m}"]`).click();
          assert.equal(await p.locator('#kdSection').isVisible(), false);
          assert.equal(await p.locator('#mainCard').isVisible(), true);
        }
        await p.locator('.tabs button[data-mode="text_to_video"]').click();
        assert.equal(await p.locator('#prompt').inputValue(), 'main draft');
        await openDance(p);
        assert.equal(await p.locator('#kdPrompt').inputValue(), 'dance draft');
        await p.evaluate(() => { updateCreditUi(); persistDraft(); });
        assert.notEqual(await p.evaluate(() => JSON.parse(localStorage.getItem('flowvidGenerateDraft') || '{}').mode), 'dance');
        assert.equal(await p.evaluate(() => 'prompt_dance' in JSON.parse(localStorage.getItem('flowvidGenerateDraft') || '{}')), false);
        assert.equal(await p.evaluate(() => window.flowvidDanceKling.state.video.status), 'ready');
        assert.equal(await p.evaluate(() => window.flowvidDanceKling.state.image.status), 'completed');
        assert.deepEqual(f.pageErrors, []);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] full flow: start -> processing -> complete -> video shown -> history labelled ダンス -> survives reload`, async () => {
      const f = await fixture(browser, { pollScript: ['processing', 'processing', 'done'] });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').click();
        await p.waitForFunction(() => document.querySelector('[data-ptask-id] video'), null, { timeout: 8000 });
        assert.equal(f.calls.starts.length, 1);
        assert.ok(f.calls.polls >= 3, 'polled until completion: ' + f.calls.polls);
        assert.equal(await p.locator('[data-ptask-id] video').first().getAttribute('src'), origin + '/out.mp4#t=0.2');
        // history (dance tab) shows only the dance video, labelled ダンス
        await p.locator('.tabs button[data-mode="text_to_video"]').click();
        await openDance(p);
        await p.waitForFunction(() => document.querySelector('#history article'));
        const chips = await p.locator('#history article').first().locator('.fv-chip-mode').allTextContents();
        assert.deepEqual(chips, ['ダンス']);
        assert.equal(await p.locator('#history article').count(), 1, 'dance tab history excludes non-dance videos');
        // reference tab still lists both, the dance one labelled ダンス
        await p.locator('.tabs button[data-mode="reference_to_video"]').click();
        await p.waitForFunction(() => document.querySelectorAll('#history article').length === 2);
        const labels = await p.locator('#history article .fv-chip-mode').allTextContents();
        assert.deepEqual(labels.sort(), ['ダンス', 'リファレンス']);
        // reload: completed task is in history, nothing is resubmitted
        await p.reload({ waitUntil: 'networkidle' });
        await p.waitForFunction(() => typeof generationAccessLoaded !== 'undefined' && generationAccessLoaded === true);
        await openDance(p);
        await p.waitForFunction(() => document.querySelector('#history article .fv-chip-mode'));
        assert.deepEqual(await p.locator('#history article .fv-chip-mode').allTextContents(), ['ダンス']);
        assert.equal(f.calls.starts.length, 1);
        assert.deepEqual(f.pageErrors, []);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] reload while processing resumes polling without a second start, then completes`, async () => {
      const f = await fixture(browser, { pollScript: ['processing', 'processing', 'processing', 'processing', 'done'] });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').click();
        await p.waitForFunction(() => document.querySelector('[data-ptask-id]'));
        await p.reload({ waitUntil: 'networkidle' });
        await p.waitForFunction(() => document.querySelector('[data-ptask-id="task-1"]'), null, { timeout: 8000 });
        await p.waitForFunction(() => document.querySelector('[data-ptask-id] video'), null, { timeout: 8000 });
        assert.equal(f.calls.starts.length, 1, 'no new generation request after reload');
        assert.equal(f.flow.completed, true);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] transient status failures (network abort, HTTP 502 without job status) keep polling; no new start, no failure card`, async () => {
      const f = await fixture(browser, { pollScript: ['network', 'http502', 'processing', 'done'] });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').click();
        await p.waitForFunction(() => document.querySelector('[data-ptask-id] video'), null, { timeout: 8000 });
        assert.equal(f.calls.starts.length, 1);
        assert.ok(f.calls.polls >= 4);
        assert.equal(await p.locator('[data-ptask-id]').filter({ hasText: '失敗' }).count(), 0);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] confirmed provider failure: card shows failure with refund notice, send re-enabled only by new inputs, one start only`, async () => {
      const f = await fixture(browser, { pollScript: ['processing', 'failed'] });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').click();
        await p.waitForFunction(() => /返還|返金/.test(document.querySelector('[data-ptask-id]')?.textContent || ''), null, { timeout: 8000 });
        assert.equal(f.calls.starts.length, 1);
        const polls = f.calls.polls; await p.waitForTimeout(600);
        assert.equal(f.calls.polls, polls, 'polling stops after a confirmed failure');
        assert.equal(f.calls.starts.length, 1);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] provider started but tracking save failed (503 providerStarted): keeps polling, never says "not charged"`, async () => {
      const f = await fixture(browser, { startProviderStarted: true, pollScript: ['processing', 'done'] });
      try {
        const p = f.page; await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').click();
        await p.locator('#kdStatus').waitFor({ state: 'visible' });
        assert.doesNotMatch(await p.locator('#kdStatus').textContent(), /消費されていません/);
        assert.match(await p.locator('#kdStatus').textContent(), /再度生成せず/);
        await p.waitForFunction(() => document.querySelector('[data-ptask-id] video'), null, { timeout: 8000 });
        assert.equal(f.calls.starts.length, 1);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] pre-deduction 4xx says not charged; 5xx without refund makes no such claim`, async () => {
      for (const [o, expectNot] of [[{ start400: 'identity_reference_image_required' }, true], [{ start502: true }, false]]) {
        const f = await fixture(browser, o);
        try {
          const p = f.page; await openDance(p); await fill(p);
          await p.locator('#kdPrompt').fill('dance');
          await p.locator('#kdCreate').click();
          await p.locator('#kdStatus').waitFor({ state: 'visible' });
          const t = await p.locator('#kdStatus').textContent();
          assert.equal(/消費されていません/.test(t), expectNot, t);
        } finally { await f.context.close(); }
      }
    });
    await run(`[${width}] dance form is hidden when switching to the video-edit tab`, async () => {
      const f = await fixture(browser);
      try {
        const p = f.page; await openDance(p);
        await p.evaluate(() => onVideoEditTab().catch(() => {}));
        await p.waitForTimeout(200);
        assert.equal(await p.locator('#kdSection').isVisible(), false);
      } finally { await f.context.close(); }
    });
    await run(`[${width}] sending from dance does not clear main-card reference images`, async () => {
      const f = await fixture(browser);
      try {
        const p = f.page;
        await p.locator('.tabs button[data-mode="reference_to_video"]').click();
        await p.evaluate(() => { const a = { id: 'x', status: 'completed', url: location.origin + '/main.png', file: null }; assets.push(a); urls.push(a.url); renderAssets(); });
        const before = await p.evaluate(() => assets.length);
        assert.ok(await p.locator('#assets .thumb img').count() >= 1, 'main-card thumbnail must exist for this check to discriminate');
        await openDance(p); await fill(p);
        await p.locator('#kdPrompt').fill('dance');
        await p.locator('#kdCreate').click();
        await p.waitForFunction(() => document.querySelector('[data-ptask-id]'));
        await p.waitForTimeout(600);
        assert.equal(await p.evaluate(() => assets.length), before);
        assert.equal(await p.locator('#assets .thumb').count(), 1, 'main-card thumbnail kept after a dance send');
      } finally { await f.context.close(); }
    });
  } finally {
    if (browser) await browser.close();
    console.log(JSON.stringify({ width, passed: passed.length, failed: failures.length, unexpectedApi }));
    if (failures.length) console.log(failures.map(f => f.name + '\n' + f.error).join('\n'));
    process.exitCode = failures.length || unexpectedApi.length ? 1 : 0;
  }
})();
