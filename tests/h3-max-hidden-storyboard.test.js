'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'h3-max-beta.html'), 'utf8');

function harness() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, { hidden: false, value: '', innerHTML: '',
        classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
          contains(name) { return classes.has(name); } },
        addEventListener() {} });
    }
    return elements.get(id);
  }
  const buttons = ['text', 'image', 'reference'].map(mode =>
    Object.assign(element(mode), { dataset: { mode } }));
  element('modes').querySelectorAll = () => buttons;
  const context = { $: element, REF_MAX_IMAGES: 9,
    state: { mode: 'text', refImages: [], uploadId: 'single-image', sending: false },
    refreshSend() {}, setGenerating() {}, notice() {}, uuid: () => 'mock-id',
    clearTimeout() {}, setTimeout() { return 1; },
    clearImage() {}, scheduleStatus() {}, refreshFeed: async () => {},
    textImpliesImageWithoutAttachment: () => false,
    requests: [], api: async (url, options) => {
      context.requests.push({ url, body: JSON.parse(options.body) });
      return {};
    } };
  vm.createContext(context);
  for (const name of ['normalizeMode', 'isMultiMode', 'applyEligibility', 'setMode',
    'renderRefGrid', 'moveReferenceImage', 'esc', 'statusLabel', 'renderHistory', 'refreshFeed', 'send']) {
    const match = html.match(new RegExp('    (?:async )?function ' + name + '\\('));
    assert.ok(match, name);
    const start = match.index;
    const next = html.slice(start + match[0].length).search(/\n    (?:async )?function |\n    \$\('prompt'\)\.addEventListener/);
    vm.runInContext(html.slice(start, start + match[0].length + next), context);
  }
  return { context, element, buttons };
}

test('H3 Max exposes only three modes and removes storyboard-only help', () => {
  assert.deepEqual([...html.matchAll(/data-mode="([^"]+)"/g)].map(m => m[1]),
    ['text', 'image', 'reference']);
  assert.doesNotMatch(html, /絵コンテ|refNote|refnote/);
});

test('legacy mode restoration and repeated switching preserve images, quote and selection', () => {
  const { context: c, element, buttons } = harness();
  c.state.refImages = Array.from({ length: 9 }, (_, i) => ({ uploadId: 'image-' + i, thumbUrl: 'mock:' + i }));
  const images = c.state.refImages;
  c.state.eligibility = { planAllowed: true, balance: 130,
    creditCosts: { text: 120, image: 130, reference: 130, storyboard: 130 } };
  for (let i = 0; i < 3; i++) {
    for (const mode of ['storyboard', 'text', 'image', 'reference', 'storyboard']) {
      c.setMode(mode);
      const expected = mode === 'storyboard' ? 'reference' : mode;
      assert.equal(c.state.mode, expected);
      assert.equal(c.state.refImages, images);
      assert.equal(c.state.uploadId, 'single-image');
      assert.equal(element('refGrid').hidden, expected !== 'reference');
      assert.equal(c.state.creditCost, expected === 'text' ? 120 : 130);
      assert.equal(c.state.hasEnough, true);
      assert.deepEqual(buttons.filter(b => b.classList.contains('on')).map(b => b.dataset.mode), [expected]);
    }
  }
  assert.equal((element('refGrid').innerHTML.match(/class="refslot filled"/g) || []).length, 9);
  assert.doesNotMatch(element('refGrid').innerHTML, /refAddBtn/);
});

test('legacy selection sends reference with the same ordered images and quote (mock API only)', async () => {
  const { context: c, element } = harness();
  c.state.refImages = [{ uploadId: 'a' }, { uploadId: 'b' }];
  c.state.eligibility = { planAllowed: true, balance: 130, creditCosts: { reference: 130 } };
  c.setMode('storyboard');
  c.moveReferenceImage(1, -1);
  element('prompt').value = 'Scene sequence';
  await c.send();
  assert.deepEqual(c.requests, [{ url: '/api/h3-live/start', body: {
    instruction: 'Scene sequence', mode: 'reference', uploadIds: ['b', 'a'], expectedCreditCost: 130
  } }]);
});

test('old jobs retain playback and download while displaying the reference label without mutation', () => {
  const { context: c, element } = harness();
  const job = Object.freeze({ id: 'old-job', inputMode: 'storyboard', status: 'completed',
    instruction: 'Old prompt', videoUrl: 'https://example.test/old.mp4', creditCost: 130 });
  c.renderHistory([job]);
  const output = element('history').innerHTML;
  assert.match(output, /リファレンス/);
  assert.doesNotMatch(output, /絵コンテ/);
  assert.match(output, /<video controls/);
  assert.match(output, /data-job-id="old-job"/);
  assert.match(output, /130 credits/);
  assert.equal(job.inputMode, 'storyboard');
});


test('feed restoration resumes a legacy job without restoring the hidden input mode', async () => {
  const { context: c, buttons } = harness();
  c.setMode('reference');
  const job = Object.freeze({ id: 'legacy-active', inputMode: 'storyboard', status: 'processing' });
  c.api = async () => ({ eligibility: { planAllowed: true, balance: 130,
    creditCosts: { reference: 130 } }, activeJob: job });
  await c.refreshFeed();
  assert.equal(c.state.activeJobId, 'legacy-active');
  assert.equal(c.state.mode, 'reference');
  assert.equal(job.inputMode, 'storyboard');
  assert.deepEqual(buttons.filter(b => b.classList.contains('on')).map(b => b.dataset.mode), ['reference']);
});
