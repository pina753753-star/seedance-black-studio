'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../api/stripe-checkout.js'), 'utf8');

// Execute the real handler with inert credentials and SDK stubs. Any DB table
// access (including plan mutation) fails; no network or production env is used.
function harness({ authenticated = true, stripeFails = false } = {}) {
  const calls = [];
  const sandbox = {
    module: { exports: {} }, console: { error() {} },
    process: { env: { STRIPE_SECRET_KEY: 'test-placeholder', SUPABASE_SERVICE_ROLE_KEY: 'test-placeholder', VERCEL_ENV: 'production', STRIPE_PRICE_STANDARD_MONTHLY: 'price_test_month', STRIPE_PRICE_STANDARD_YEARLY: 'price_test_year' } },
    require(name) {
      if (name === 'stripe') return class {
        checkout = { sessions: { create: async (params) => {
          calls.push(params);
          if (stripeFails) throw new Error('private provider diagnostic');
          return { id: 'cs_test', url: 'https://checkout.stripe.com/test', client_secret: 'test-session-secret' };
        } } };
      };
      if (name === '@supabase/supabase-js') return { createClient: () => ({
        auth: { getUser: async token => ({ data: { user: authenticated && token === 'test-token' ? { id: 'user-test', email: 'user@example.test' } : null } }) },
        from() { throw new Error('Checkout must not query or mutate plan/balance'); }
      }) };
      throw new Error(`Unexpected module ${name}`);
    }
  };
  vm.runInNewContext(source, sandbox);
  return { calls, async request(body, token = 'test-token') {
    const res = { status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await sandbox.module.exports({ method: 'POST', headers: { authorization: token ? `Bearer ${token}` : '', host: 'flowvid-studio.vercel.app' }, body }, res);
    return res;
  } };
}

for (const [id, amount, credits] of [['credits_100',500,100],['credits_300',1300,300],['credits_500',2000,500],['credits_1000',3600,1000],['credits_3000',9800,3000]]) {
  for (const ui of ['embedded', 'hosted']) test(`${id} ${ui}: authenticated user needs no subscription; prices/metadata unchanged`, async () => {
    const h = harness();
    const res = await h.request({ kind: 'credits', id, ui, user_id: 'attacker', credits: 999999, plan: 'team' });
    assert.equal(res.statusCode, 200);
    assert.equal(h.calls.length, 1);
    const p = h.calls[0];
    assert.equal(p.mode, 'payment');
    assert.equal(p.line_items[0].price_data.unit_amount, amount);
    assert.equal(p.line_items[0].price_data.currency, 'jpy');
    assert.equal(p.metadata.credits, String(credits));
    assert.equal(p.metadata.user_id, 'user-test');
    assert.equal(p.metadata.purchase_type, 'credits');
    assert.equal(p.metadata.pack, id);
    assert.equal(p.metadata.plan, undefined);
    assert.equal(p.subscription_data, undefined);
    assert.equal(p.allow_promotion_codes, true);
    assert.equal(res.body.uiMode, ui);
    assert.ok(ui === 'hosted' ? p.success_url && p.cancel_url : p.return_url && p.ui_mode === 'embedded');
  });
}
test('missing/invalid login never creates checkout', async () => {
  for (const token of ['', 'invalid']) {
    const h = harness();
    assert.equal((await h.request({ kind: 'credits', id: 'credits_100' }, token)).statusCode, 401);
    assert.equal(h.calls.length, 0);
  }
});
test('invalid pack/kind never creates checkout', async () => {
  for (const body of [{ kind: 'credits', id: 'missing' }, { kind: 'missing', id: 'credits_100' }]) {
    const h = harness();
    assert.equal((await h.request(body)).statusCode, 400);
    assert.equal(h.calls.length, 0);
  }
});
test('monthly and annual subscriptions retain their own metadata and mode', async () => {
  for (const billing_interval of ['month', 'year']) {
    const h = harness();
    assert.equal((await h.request({ kind: 'subscription', id: 'standard', billing_interval })).statusCode, 200);
    const p = h.calls[0];
    assert.equal(p.mode, 'subscription');
    assert.equal(p.metadata.plan, 'standard');
    assert.equal(p.metadata.billing_interval, billing_interval);
    assert.equal(p.subscription_data.metadata, p.metadata);
  }
});
test('Stripe failure returns safe error and no automatic retry', async () => {
  const h = harness({ stripeFails: true });
  const res = await h.request({ kind: 'credits', id: 'credits_100' });
  assert.equal(res.statusCode, 500);
  assert.equal(h.calls.length, 1);
  assert.doesNotMatch(res.body.error, /private provider/);
});
test('purchase pages disclose usable scope without subscriber-only purchase claims', () => {
  for (const filename of ['pricing.html', 'credits-info.html', 'help.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    assert.doesNotMatch(html, /サブスク(?:リプション)?会員限定|会員限定で購入/);
    for (const text of ['Seedance 2.0 / 2.0 Fast', '透かし付き', 'メール確認', '単体購入でプランは変わりません', 'Director', '動画編集']) assert.ok(html.includes(text), `${filename}: ${text}`);
  }
});
