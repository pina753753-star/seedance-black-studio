'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');
const SUBSCRIPTION_NOTE = '解約はいつでもマイページから。';
const CREDIT_NOTE = 'クレジットパックは買い切りです。自動更新はなく、解約手続きは不要です。';

// pricing.htmlの実インラインscript(src無しの最後のscript)を、最小のDOMスタブ上で実行する。
function loadPricing(hash = '') {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const source = inline[inline.length - 1];
  assert.ok(source.includes('function setView('), 'inline script with setView not found');

  // HTML上の初期class(hidden)をそのまま再現する。
  const initialHidden = new Set();
  for (const m of html.matchAll(/<[a-z]+[^>]*\bid="([^"]+)"[^>]*>/g)) {
    if (/\bclass="[^"]*\bhidden\b[^"]*"/.test(m[0])) initialHidden.add(m[1]);
  }
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const classes = new Set(initialHidden.has(id) ? ['hidden'] : []);
      elements.set(id, {
        id, innerHTML: '', textContent: '', style: {}, dataset: {},
        classList: {
          toggle(name, force) { const on = force === undefined ? !classes.has(name) : Boolean(force); on ? classes.add(name) : classes.delete(name); return on; },
          add: name => classes.add(name), remove: name => classes.delete(name),
          contains: name => classes.has(name)
        },
        addEventListener() {}
      });
    }
    return elements.get(id);
  }
  const location = { hash, href: '' };
  const window = { FLOWVID_AUTH: {}, addEventListener() {}, location };
  const context = vm.createContext({
    window, location, console,
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    history: { replaceState(_s, _t, next) { location.hash = next; } },
    fetch: () => Promise.reject(new Error('network disabled in test')),
    Stripe: () => { throw new Error('Stripe disabled in test'); },
    setTimeout: () => 0, clearTimeout() {}
  });
  vm.runInContext(source, context);
  const hidden = id => element(id).classList.contains('hidden');
  return {
    click: id => element(id).onclick(),
    // 表示されている決済補足文だけを返す。両方表示/両方非表示になれば検知できる。
    visibleNotes: () => [
      ['subscriptionPaymentNote', SUBSCRIPTION_NOTE],
      ['creditPaymentNote', CREDIT_NOTE]
    ].filter(([id]) => !hidden(id)).map(([, text]) => text),
    hidden, element, location
  };
}

test('markup: both notes exist with the specified text and the credit note starts hidden', () => {
  assert.ok(html.includes(`<span id="subscriptionPaymentNote">${SUBSCRIPTION_NOTE}</span><span id="creditPaymentNote" class="hidden">${CREDIT_NOTE}</span>`));
});

test('initial display without hash shows only the subscription cancellation note', () => {
  assert.deepEqual(loadPricing('').visibleNotes(), [SUBSCRIPTION_NOTE]);
});

test('#annual keeps the subscription cancellation note only', () => {
  assert.deepEqual(loadPricing('#annual').visibleNotes(), [SUBSCRIPTION_NOTE]);
});

test('#credit initial display shows only the one-time purchase note', () => {
  const page = loadPricing('#credit');
  assert.deepEqual(page.visibleNotes(), [CREDIT_NOTE]);
  assert.equal(page.hidden('creditView'), false);
  assert.equal(page.hidden('subscriptionView'), true);
});

test('switching back to subscription restores only the cancellation note, and credit again is correct', () => {
  const page = loadPricing('#credit');
  page.click('subTab');
  assert.deepEqual(page.visibleNotes(), [SUBSCRIPTION_NOTE]);
  assert.equal(page.location.hash, '#monthly');
  page.click('creditTab');
  assert.deepEqual(page.visibleNotes(), [CREDIT_NOTE]);
  assert.equal(page.location.hash, '#credit');
  page.click('subTab');
  assert.deepEqual(page.visibleNotes(), [SUBSCRIPTION_NOTE]);
});

test('switching from the default subscription tab to credit shows only the one-time purchase note', () => {
  const page = loadPricing('');
  page.click('creditTab');
  assert.deepEqual(page.visibleNotes(), [CREDIT_NOTE]);
});

test('terms and refund/expiry policy links are kept', () => {
  const footer = html.match(/<p class="footer">[\s\S]*?<\/p>/)[0];
  assert.match(footer, /<a href="\.\/terms\.html"[^>]*>利用規約<\/a>/);
  assert.match(footer, /<a href="\.\/credits-info\.html"[^>]*>返金・失効ポリシー<\/a>/);
  assert.ok(footer.startsWith('<p class="footer">決済はStripeで安全に処理されます。'));
});
