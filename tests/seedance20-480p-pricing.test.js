'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing.js');

const STANDARD = 'bytedance/seedance-2.0';
const FAST = 'bytedance/seedance-2.0-fast';
const SIZES = { '16:9': [854, 480], '9:16': [480, 854], '4:3': [640, 480], '3:4': [480, 640], '1:1': [480, 480] };
const RATIOS = Object.keys(SIZES);
const MODES = ['text_to_video', 'image_to_video', 'reference_to_video'];

// Independent exact-rational reference (BigInt, no floating point):
// credits = ceil5( w*h*sec*24/1024/1e6 * unit * 170 * 1.055 * 2 / 3.725 ), minimum 10.
function reference(model, ratio, seconds) {
  const unit10 = model === STANDARD ? 70n : 42n; // $7.00 / $4.20 times 10
  const [w, h] = SIZES[ratio];
  const num = BigInt(w) * BigInt(h) * BigInt(seconds) * 24n * unit10 * 170n * 1055n * 2n;
  const den = 1024n * 1000000n * 10n * 3725n;
  const fives = (num + den * 5n - 1n) / (den * 5n); // ceil(num / (den*5))
  const credits = fives * 5n;
  return Number(credits < 10n ? 10n : credits);
}

test('360 conditions (4-15s x 5 ratios x 3 modes x 2 models) equal the exact reference', () => {
  let n = 0;
  for (const model of [STANDARD, FAST]) for (const mode of MODES) for (const ratio of RATIOS) for (let seconds = 4; seconds <= 15; seconds++) {
    const input = { model, mode, resolution: '480p', duration: seconds, aspectRatio: ratio };
    assert.equal(calculateVideoCreditCost(input), reference(model, ratio, seconds), JSON.stringify(input));
    n++;
  }
  assert.equal(n, 360);
});

test('specified expectations: 16:9 / 9:16 at 5/10/15s, and 4s / 1:1', () => {
  for (const ratio of ['16:9', '9:16']) for (const mode of MODES) {
    const at = (model, d) => calculateVideoCreditCost({ model, mode, resolution: '480p', duration: d, aspectRatio: ratio });
    assert.deepEqual([5, 10, 15].map(d => at(FAST, d)), [20, 40, 60]);
    assert.deepEqual([5, 10, 15].map(d => at(STANDARD, d)), [35, 65, 100]);
  }
  for (const mode of MODES) {
    const at = model => calculateVideoCreditCost({ model, mode, resolution: '480p', duration: 4, aspectRatio: '1:1' });
    assert.equal(at(FAST), 10);
    assert.equal(at(STANDARD), 15);
  }
});

test('same API cost gives the same credits: mode and orientation never change the price', () => {
  for (const model of [STANDARD, FAST]) for (let d = 4; d <= 15; d++) {
    const base = calculateVideoCreditCost({ model, mode: 'text_to_video', resolution: '480p', duration: d, aspectRatio: '16:9' });
    for (const mode of MODES) for (const ratio of ['16:9', '9:16']) {
      assert.equal(calculateVideoCreditCost({ model, mode, resolution: '480p', duration: d, aspectRatio: ratio }), base);
    }
    for (const mode of MODES) {
      assert.equal(calculateVideoCreditCost({ model, mode, resolution: '480p', duration: d, aspectRatio: '4:3' }),
        calculateVideoCreditCost({ model, mode, resolution: '480p', duration: d, aspectRatio: '3:4' }));
    }
  }
});

test('Fast is never more expensive than standard, and price never decreases with duration', () => {
  for (const ratio of RATIOS) for (const mode of MODES) {
    let prevS = 0, prevF = 0;
    for (let d = 4; d <= 15; d++) {
      const s = calculateVideoCreditCost({ model: STANDARD, mode, resolution: '480p', duration: d, aspectRatio: ratio });
      const f = calculateVideoCreditCost({ model: FAST, mode, resolution: '480p', duration: d, aspectRatio: ratio });
      assert.ok(f <= s && s >= prevS && f >= prevF && f >= 10);
      prevS = s; prevF = f;
    }
  }
});

test('no double application of the legacy +10 credit or the 1.15 reference multiplier', () => {
  // image-reference 5s Fast 16:9 must equal text 5s Fast 16:9 (old formula made them differ).
  const t = calculateVideoCreditCost({ model: FAST, mode: 'text_to_video', resolution: '480p', duration: 5, aspectRatio: '16:9' });
  const i = calculateVideoCreditCost({ model: FAST, mode: 'image_to_video', resolution: '480p', duration: 5, aspectRatio: '16:9' });
  const r = calculateVideoCreditCost({ model: FAST, mode: 'reference_to_video', resolution: '480p', duration: 5, aspectRatio: '16:9' });
  assert.deepEqual([t, i, r], [20, 20, 20]);
});

test('out-of-scope prices are unchanged from baseline f741e96 (4140 conditions, sha256 snapshot)', () => {
  const models = ['bytedance/seedance-2.0', 'bytedance/seedance-2.0-fast', 'bytedance/seedance-2.0-lite', 'bytedance/seedance-2.5', 'bytedance/seedance-2.5-standard'];
  const modes = ['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard'];
  const out = [];
  for (const model of models) for (const mode of modes) for (const resolution of ['480p', '720p', '1080p']) for (const aspectRatio of RATIOS) for (let duration = 1; duration <= 15; duration++) {
    const inScope = (model === STANDARD || model === FAST) && resolution === '480p' && mode !== 'storyboard' && duration >= 4;
    if (inScope) continue;
    let v;
    try { v = calculateVideoCreditCost({ model, mode, resolution, aspectRatio, duration }); } catch (e) { v = 'ERR:' + (e.code || e.message); }
    out.push([model, mode, resolution, aspectRatio, duration, v]);
  }
  assert.equal(out.length, 4140);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex'), '7120e8ebdbe9962d36d5cd1d3560874f1a69c77013a51b0a9ab497d0e0fe547b');
});

test('the global minimum (50) is untouched: other cases still floor at 50 and 1080p floor still applies', () => {
  const { MIN_CREDITS } = require('../api/_lib/video-pricing.js');
  assert.equal(MIN_CREDITS, 50);
  assert.ok(calculateVideoCreditCost({ model: STANDARD, mode: 'storyboard', resolution: '480p', duration: 4 }) >= 50);
  assert.ok(calculateVideoCreditCost({ model: 'bytedance/seedance-2.0-lite', mode: 'text_to_video', resolution: '480p', duration: 4, aspectRatio: '1:1' }) >= 50);
  assert.ok(calculateVideoCreditCost({ model: STANDARD, mode: 'text_to_video', resolution: '480p', duration: 3 }) >= 50, '2.0 standard 1-3s keeps the old behaviour');
});

// ---- Browser calculators must match the server for the changed range ----

function loadFromSource(file, startMarker, endMarker, exportName) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, file + ': pricing source not found');
  const context = vm.createContext({ window: {} });
  vm.runInContext(`(function(){${source.slice(start, end)}\nthis.fn=${exportName};}).call(globalThis);`, context);
  return context.fn;
}

test('flowvid-open-inline.js computeCredits equals the server for all 360 conditions (and all 4-15s x ratios x resolutions)', () => {
  const compute = loadFromSource('flowvid-open-inline.js', "const STANDARD_MODEL='bytedance/seedance-2.0';", 'window.flowvidComputeCredits=computeCredits;', 'computeCredits');
  for (const model of [STANDARD, FAST]) for (const mode of MODES) for (const ratio of RATIOS) for (let d = 4; d <= 15; d++) {
    const input = { model, mode, resolution: '480p', duration: d, aspectRatio: ratio };
    assert.equal(compute(input), calculateVideoCreditCost(input), JSON.stringify(input));
  }
});

test('generate-prod.html seedance20Right480Credits is the same function as the server one for every condition', () => {
  const clientFn = loadFromSource('generate-prod.html', 'function seedance20Right480Credits(', 'function creditEstimate()', 'seedance20Right480Credits');
  const { seedance20Right480Credits } = require('../api/_lib/video-pricing.js');
  for (const model of [STANDARD, FAST, 'bytedance/seedance-2.0-lite', 'bytedance/seedance-2.5']) for (const mode of [...MODES, 'storyboard']) for (const resolution of ['480p', '720p', '1080p']) for (const ratio of [...RATIOS, '21:9']) for (let d = 1; d <= 20; d++) {
    assert.equal(clientFn(model, resolution, mode, d, ratio), seedance20Right480Credits(model, resolution, mode, d, ratio), [model, mode, resolution, ratio, d].join('/'));
  }
});

test('generate-prod.html creditEstimate() is wired to the new rule before the legacy formula', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'generate-prod.html'), 'utf8');
  const est = html.slice(html.indexOf('function creditEstimate()'));
  assert.ok(est.indexOf('seedance20Right480Credits(model,resolution,mode,duration') > 0);
  assert.ok(est.indexOf('seedance20Right480Credits(model,resolution,mode,duration') < est.indexOf('const multiplier=pricingMultiplier(model)'));
});

// ---- Storyboard-origin generations (reference_to_video + ui_origin=storyboard) keep the legacy price ----

test('storyboard-origin 2.0/Fast 480p keeps the baseline f741e96 price for all 360 conditions (sha256 snapshot)', () => {
  const out = [];
  for (const model of [STANDARD, FAST]) for (const mode of MODES) for (const ratio of RATIOS) for (let d = 4; d <= 15; d++) {
    out.push([model, mode, ratio, d, calculateVideoCreditCost({ model, mode, resolution: '480p', aspectRatio: ratio, duration: d, storyboardOrigin: true })]);
  }
  assert.equal(out.length, 360);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(out)).digest('hex'), 'df65b79ea49ec908abb164f76cfe9dd79fda65611abc722c06fa065c1127cec6');
  assert.equal(calculateVideoCreditCost({ model: FAST, mode: 'reference_to_video', resolution: '480p', aspectRatio: '16:9', duration: 5, storyboardOrigin: true }), 70);
  assert.equal(calculateVideoCreditCost({ model: STANDARD, mode: 'reference_to_video', resolution: '480p', aspectRatio: '16:9', duration: 5, storyboardOrigin: true }), 90);
});

test('only storyboardOrigin === true opts out (anything else keeps the new price); 720p/1080p are not affected by the flag', () => {
  const base = { model: FAST, mode: 'reference_to_video', resolution: '480p', aspectRatio: '16:9', duration: 5 };
  for (const flag of [undefined, false, 'true', 1, 'storyboard']) assert.equal(calculateVideoCreditCost({ ...base, storyboardOrigin: flag }), 20);
  for (const resolution of ['720p', '1080p']) {
    assert.equal(calculateVideoCreditCost({ ...base, resolution, storyboardOrigin: true }), calculateVideoCreditCost({ ...base, resolution }));
  }
});

test('browser calculators honour the storyboard flag exactly like the server', () => {
  const compute = loadFromSource('flowvid-open-inline.js', "const STANDARD_MODEL='bytedance/seedance-2.0';", 'window.flowvidComputeCredits=computeCredits;', 'computeCredits');
  const clientFn = loadFromSource('generate-prod.html', 'function seedance20Right480Credits(', 'function creditEstimate()', 'seedance20Right480Credits');
  const { seedance20Right480Credits } = require('../api/_lib/video-pricing.js');
  for (const model of [STANDARD, FAST]) for (const ratio of RATIOS) for (let d = 4; d <= 15; d++) {
    const input = { model, mode: 'reference_to_video', resolution: '480p', duration: d, aspectRatio: ratio, storyboardOrigin: true };
    assert.equal(compute(input), calculateVideoCreditCost(input), JSON.stringify(input));
    assert.equal(clientFn(model, '480p', 'reference_to_video', d, ratio, true), seedance20Right480Credits(model, '480p', 'reference_to_video', d, ratio, true));
    assert.equal(clientFn(model, '480p', 'reference_to_video', d, ratio, true), null);
  }
});

test('the storyboard signal is wired on every display path and on the server start', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'generate-prod.html'), 'utf8');
  const inline = fs.readFileSync(path.join(__dirname, '..', 'flowvid-open-inline.js'), 'utf8');
  const start = fs.readFileSync(path.join(__dirname, '..', 'api/_lib/seedance-start.js'), 'utf8');
  assert.ok(html.includes("seedance20Right480Credits(model,resolution,mode,duration,$('aspect')?.value||'9:16',sbLocked)"), 'creditEstimate passes sbLocked');
  assert.match(html.slice(html.indexOf('function sbUpdateCreditEstimate')), /storyboardOrigin:true\s*\}\);/);
  assert.ok(html.includes('window.flowvidStoryboardOrigin=locked===true;'));
  assert.ok(inline.includes('storyboardOrigin:window.flowvidStoryboardOrigin===true'));
  assert.ok(start.includes("storyboardOrigin: uiOrigin === 'storyboard',"));
});

// ---- Pages that load the shared pricing script but must never quote/send a generation ----

test('profile.html has no generation start, estimate sending, create button or history-start script (a stale cached flowvid-open-inline.js there cannot mis-quote)', () => {
  const profile = fs.readFileSync(path.join(__dirname, '..', 'profile.html'), 'utf8');
  assert.equal(profile.includes('/api/seedance-start'), false);
  assert.equal(profile.includes('estimated_credits'), false);
  assert.equal(/id=["']create["']/.test(profile), false);
  assert.equal(profile.includes('flowvid-history.js'), false);
  assert.equal(profile.includes('generate-prod.html'), false, 'no regenerate link that carries a quote');
});

test('only generate-prod.html can start a generation with a browser quote; its pricing script reference was cache-busted for this change', () => {
  const root = path.join(__dirname, '..');
  const pages = fs.readdirSync(root).filter(f => f.endsWith('.html'));
  const senders = pages.filter(f => { const s = fs.readFileSync(path.join(root, f), 'utf8'); return s.includes('estimated_credits') && s.includes('/api/seedance-start'); });
  assert.deepEqual(senders, ['generate-prod.html']);
  const html = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
  assert.match(html, /flowvid-open-inline\.js\?v=([4-9]|\d{2,})"/);
});
