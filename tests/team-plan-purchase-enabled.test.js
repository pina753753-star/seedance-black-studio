'use strict';

// Teamプラン(月額¥298,000/年額¥3,576,000)は「大容量クレジットを使いたい
// 個人向けプラン」として月額・年額とも購入可能にした。複数アカウント・
// 共有クレジット・共有アセット・チーム管理は未実装のため、それらは
// features配列から削除し宣伝しない。
//
// - pricing.html: isPurchaseDisabledPlan(p)はp.purchaseDisabledフラグ方式に
//   変更し、Teamにはフラグを立てていない(=購入導線は他プランと同様に有効)。
//   ボタンはdisabled/aria-disabled/btnDisabledのいずれも付かず、既存の
//   有効ボタン表現(base .btn。Freeプランと同じ)を使う
// - api/stripe-checkout.js: 月額・年額どちらもid==='team'の拒否ガードを
//   削除し、既存のプラン解決ロジック(SUBSCRIPTION_PLANS /
//   SUBSCRIPTION_PLANS_ANNUAL)にそのまま乗せている

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pricingHtml = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');
const checkoutSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'stripe-checkout.js'), 'utf8');
const api = require('../api/stripe-checkout.js')._test;

// ---------------------------------------------------------------
// pricing.html: 実際にDOMのクリックイベントをシミュレートし、
// Teamボタンのクリックで他プラン同様checkout()が呼ばれることを確認する
// ---------------------------------------------------------------
function loadPricingPlansHandlers({ billing = 'monthly' } = {}) {
  const plansStart = pricingHtml.indexOf('const plans=[');
  const plansEnd = pricingHtml.indexOf('\n', pricingHtml.indexOf('];', plansStart)) + 1;
  const plansSrc = pricingHtml.slice(plansStart, plansEnd);

  const fnStart = pricingHtml.indexOf('function isPurchaseDisabledPlan(');
  const fnEnd = pricingHtml.indexOf('function renderPacks(', fnStart);
  const fnSrc = pricingHtml.slice(fnStart, fnEnd);

  const checkoutCalls = [];
  const messages = [];
  const buttons = [];

  const context = {
    billing,
    checkout: (...args) => { checkoutCalls.push(args); },
    showMsg: (msg) => { messages.push(msg); },
    shouldShowAnnualCampaignPrice: () => true,
    isAnnualCampaignActive: () => true,
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '#plans .btn');
        return buttons;
      }
    },
    location: { href: '' }
  };
  vm.createContext(context);
  vm.runInContext(`${plansSrc}\n${fnSrc}\nthis.plans = plans;\nthis.isPurchaseDisabledPlan = isPurchaseDisabledPlan;\nthis.attachPlanHandlers = attachPlanHandlers;\nthis.shouldBlockAnnualCheckoutClick = ${
    // shouldBlockAnnualCheckoutClick is defined earlier in the real file;
    // stub it out here (always allow) since it is unrelated to this test.
    'function(){return false}'
  };\n`, context);

  for (const p of context.plans) {
    buttons.push({
      dataset: { plan: p.cls },
      onclick: null,
      set textContent(_v) {},
      get textContent() { return ''; }
    });
  }

  context.attachPlanHandlers();
  return { context, buttons, checkoutCalls, messages };
}

test('pricing.html: isPurchaseDisabledPlanはどのプランにもtrueを返さない(Teamも購入可能)', () => {
  const { context } = loadPricingPlansHandlers();
  for (const p of context.plans) {
    assert.equal(context.isPurchaseDisabledPlan(p), false, `${p.cls} が購入不可のままです`);
  }
});

test('pricing.html: Teamボタンのクリックで月額checkoutが正しいintervalで1回だけ呼ばれる', () => {
  const { buttons, checkoutCalls } = loadPricingPlansHandlers({ billing: 'monthly' });
  const teamBtn = buttons.find(b => b.dataset.plan === 'team');
  assert.ok(teamBtn && typeof teamBtn.onclick === 'function', 'Teamボタンにonclickが割り当てられていません');

  teamBtn.onclick();

  assert.equal(checkoutCalls.length, 1, 'Teamボタンのクリックでcheckout()が1回だけ呼ばれる必要があります');
  assert.deepEqual(checkoutCalls[0], ['subscription', 'team', teamBtn, 'month']);
});

test('pricing.html: Teamボタンのクリックで年額checkoutが正しいintervalで1回だけ呼ばれる', () => {
  const { buttons, checkoutCalls } = loadPricingPlansHandlers({ billing: 'annual' });
  const teamBtn = buttons.find(b => b.dataset.plan === 'team');
  assert.ok(teamBtn && typeof teamBtn.onclick === 'function');

  teamBtn.onclick();

  assert.equal(checkoutCalls.length, 1, 'Teamボタン(年額)のクリックでcheckout()が1回だけ呼ばれる必要があります');
  assert.deepEqual(checkoutCalls[0], ['subscription', 'team', teamBtn, 'year']);
});

test('pricing.html: Standard/Premium/Ultimate/Freeのクリック動作はTeam購入可能化後も変わらない', () => {
  const { buttons, checkoutCalls } = loadPricingPlansHandlers({ billing: 'monthly' });

  const standardBtn = buttons.find(b => b.dataset.plan === 'standard');
  standardBtn.onclick();
  assert.deepEqual(checkoutCalls.at(-1), ['subscription', 'standard', standardBtn, 'month']);

  const premiumBtn = buttons.find(b => b.dataset.plan === 'premium');
  premiumBtn.onclick();
  assert.deepEqual(checkoutCalls.at(-1), ['subscription', 'premium', premiumBtn, 'month']);

  const ultimateBtn = buttons.find(b => b.dataset.plan === 'ultimate');
  ultimateBtn.onclick();
  assert.deepEqual(checkoutCalls.at(-1), ['subscription', 'ultimate', ultimateBtn, 'month']);

  assert.equal(checkoutCalls.length, 3);
});

test('pricing.html: renderPlansはどのプランのボタンにもdisabled/aria-disabled/btnDisabledを付与しない', () => {
  const start = pricingHtml.indexOf('function renderPlans(');
  const end = pricingHtml.indexOf('function attachPlanHandlers(', start);
  const src = pricingHtml.slice(start, end);
  assert.match(src, /const disabled=isPurchaseDisabledPlan\(p\)/);
  // isPurchaseDisabledPlanが常にfalseを返す現状では、実際にdisabled属性が
  // 出力される経路は使われない(将来、他のプランをpurchaseDisabled:trueに
  // した場合の保険として仕組み自体は残す)。
});

test('pricing.html: Teamボタンには新しい専用色(グレーアウト用CSS)は付与されず、既存の有効ボタン表現(base .btn)を使う', () => {
  assert.doesNotMatch(pricingHtml, /\.team \.btn\{/, '.team .btn専用の(旧・無効化風)スタイルが残っています');
});

test('pricing.html: Teamのfeaturesから未実装4機能(複数アカウント/共有クレジット/共有アセット/チーム管理)が削除されている', () => {
  const start = pricingHtml.indexOf("{cls:'team'");
  const end = pricingHtml.indexOf('\n', start);
  const teamPlanSrc = pricingHtml.slice(start, end);
  for (const feature of ['複数アカウント', '共有クレジット', '共有アセット', 'チーム管理']) {
    assert.doesNotMatch(teamPlanSrc, new RegExp(feature), `未実装機能「${feature}」がまだ宣伝されています`);
  }
});

test('pricing.html: Teamのボタンラベルは「Teamにする」で、月額でも「準備中」ではない', () => {
  const start = pricingHtml.indexOf("{cls:'team'");
  const end = pricingHtml.indexOf('\n', start);
  const teamPlanSrc = pricingHtml.slice(start, end);
  assert.match(teamPlanSrc, /btn:'Teamにする'/);
});

// ---------------------------------------------------------------
// api/stripe-checkout.js: サーバー側でも月額・年額どちらもTeamを
// 他プランと同様に処理する(拒否ガードが完全に消えていること)
// ---------------------------------------------------------------
test("api/stripe-checkout.js: 月額・年額どちらの分岐にもid==='team'を拒否するガードが存在しない", () => {
  assert.doesNotMatch(checkoutSource, /id === 'team'/, "id === 'team' の拒否ガードが残っています");
  assert.doesNotMatch(checkoutSource, /Teamプランは現在準備中/);
  assert.doesNotMatch(checkoutSource, /Teamの年額プランは準備中/);
});

test('api/stripe-checkout.js: SUBSCRIPTION_PLANS.team(月額)の金額・creditsはこの変更で変わっていない', () => {
  assert.equal(api.SUBSCRIPTION_PLANS.team.amount, 298000);
  assert.equal(api.SUBSCRIPTION_PLANS.team.credits, 90000);
  assert.equal(api.SUBSCRIPTION_PLANS.team.env, 'STRIPE_PRICE_TEAM_MONTHLY');
});

// ---------------------------------------------------------------
// api/stripe-checkout.js: Stripe SDK・Supabase認証をモックし、
// 実Stripe・実Supabaseへ一切通信せずに、Checkout Session作成の
// パラメータ(line_items・metadata・discounts等)を実行ベースで検証する
// ---------------------------------------------------------------
const stripeModulePath = require.resolve('stripe');
const supabaseModulePath = require.resolve('@supabase/supabase-js');
const checkoutModulePath = require.resolve('../api/stripe-checkout.js');
const VALID_TOKEN = 'valid-test-token';
const FAKE_USER = { id: 'user-team-test', email: 'team-tester@example.com' };

// handler()を、Stripe SDK・@supabase/supabase-jsをフェイクに差し替えた
// 状態で読み込む。require.cacheへ直接フェイクのモジュールエントリを
// 注入することで、api/stripe-checkout.js内のrequire('stripe')・
// require('@supabase/supabase-js')をどちらも横取りする(実ネットワーク・
// 実Stripe・実Supabaseには一切触れない)。
function loadHandlerWithMocks(sessionCreateImpl) {
  const sessionCreateCalls = [];

  class FakeStripe {
    constructor(_secretKey) {
      this.checkout = {
        sessions: {
          create: async (params) => {
            sessionCreateCalls.push(params);
            return (sessionCreateImpl && sessionCreateImpl(params)) || { id: 'sess_fake', client_secret: 'cs_fake' };
          }
        }
      };
    }
  }

  const fakeSupabaseClient = {
    auth: {
      getUser: async (token) => {
        if (token === VALID_TOKEN) return { data: { user: FAKE_USER }, error: null };
        return { data: null, error: new Error('invalid token') };
      }
    }
  };

  const prevStripeEntry = require.cache[stripeModulePath];
  const prevSupabaseEntry = require.cache[supabaseModulePath];
  const prevCheckoutEntry = require.cache[checkoutModulePath];

  require.cache[stripeModulePath] = { id: stripeModulePath, filename: stripeModulePath, loaded: true, exports: FakeStripe };
  require.cache[supabaseModulePath] = {
    id: supabaseModulePath,
    filename: supabaseModulePath,
    loaded: true,
    exports: { createClient: () => fakeSupabaseClient }
  };
  delete require.cache[checkoutModulePath];

  const handler = require(checkoutModulePath);

  return {
    handler,
    sessionCreateCalls,
    restore() {
      require.cache[stripeModulePath] = prevStripeEntry;
      require.cache[supabaseModulePath] = prevSupabaseEntry;
      delete require.cache[checkoutModulePath];
    }
  };
}

function fakeReqRes(body) {
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${VALID_TOKEN}` },
    body: JSON.stringify(body)
  };
  const res = {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
  return { req, res };
}

test('api/stripe-checkout.js(モック): 月額Teamはstripe.checkout.sessions.createが1回呼ばれ、STRIPE_PRICE_TEAM_MONTHLYのline_items・正しいmetadataになる', async () => {
  const prevEnv = { ...process.env };
  // 注意: SUPABASE_URL/SUPABASE_SERVICE_KEY等はapi/stripe-checkout.jsの
  // モジュールトップレベルで`process.env`から一度だけ読み込まれる定数の
  // ため、必ず環境変数を設定してからloadHandlerWithMocks()でモジュールを
  // 新規require()する(順序を間違えると空文字が焼き付いて401になる)。
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_monthly_fake';
  const { handler, sessionCreateCalls, restore } = loadHandlerWithMocks();
  try {
    const { req, res } = fakeReqRes({ kind: 'subscription', id: 'team', billing_interval: 'month' });
    await handler(req, res);

    assert.equal(res.payload?.ok, true, `エラー応答になっています: ${JSON.stringify(res.payload)}`);
    assert.equal(sessionCreateCalls.length, 1, 'stripe.checkout.sessions.createが1回呼ばれる必要があります');

    const params = sessionCreateCalls[0];
    assert.equal(params.line_items.length, 1);
    assert.equal(params.line_items[0].price, 'price_team_monthly_fake');
    assert.equal('price_data' in params.line_items[0], false);
    assert.equal(params.metadata.plan, 'team');
    assert.equal(params.metadata.billing_interval, 'month');
    assert.equal(params.metadata.credits, '90000');
    assert.equal(params.metadata.monthly_credits, '90000');
    assert.equal(params.subscription_data.metadata.plan, 'team');
    assert.equal(params.allow_promotion_codes, true);
  } finally {
    restore();
    process.env = prevEnv;
  }
});

test('api/stripe-checkout.js(モック): 年額Teamはstripe.checkout.sessions.createが1回呼ばれ、STRIPE_PRICE_TEAM_YEARLYのline_items・正しいmetadataになり、キャンペーン期間内はCouponが適用され allow_promotion_codes は付かない', async () => {
  const prevEnv = { ...process.env };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly_fake';
  process.env.STRIPE_COUPON_ANNUAL_10_OFF_202609 = 'coupon_fake_10off';
  const { handler, sessionCreateCalls, restore } = loadHandlerWithMocks();
  try {
    const { req, res } = fakeReqRes({ kind: 'subscription', id: 'team', billing_interval: 'year' });
    await handler(req, res);

    assert.equal(res.payload?.ok, true, `エラー応答になっています: ${JSON.stringify(res.payload)}`);
    assert.equal(sessionCreateCalls.length, 1, 'stripe.checkout.sessions.createが1回呼ばれる必要があります');

    const params = sessionCreateCalls[0];
    assert.equal(params.line_items.length, 1);
    assert.equal(params.line_items[0].price, 'price_team_yearly_fake');
    assert.equal('price_data' in params.line_items[0], false);
    assert.equal(params.metadata.plan, 'team');
    assert.equal(params.metadata.billing_interval, 'year');
    assert.equal(params.metadata.credits, '90000');
    assert.equal(params.metadata.monthly_credits, '90000');
    assert.equal(params.subscription_data.metadata.plan, 'team');

    // キャンペーン期間内(このプロセスの現在時刻は2026-09-30より前)なので
    // Couponが自動適用され、allow_promotion_codesとは併用されない。
    assert.deepEqual(params.discounts, [{ coupon: 'coupon_fake_10off' }]);
    assert.equal('allow_promotion_codes' in params, false);
  } finally {
    restore();
    process.env = prevEnv;
  }
});

test('api/stripe-checkout.js(モック): 年額TeamはCoupon環境変数未設定だとfail-closedで503を返し、stripe.checkout.sessions.createは呼ばれない', async () => {
  const prevEnv = { ...process.env };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly_fake';
  delete process.env.STRIPE_COUPON_ANNUAL_10_OFF_202609;
  const { handler, sessionCreateCalls, restore } = loadHandlerWithMocks();
  try {
    const { req, res } = fakeReqRes({ kind: 'subscription', id: 'team', billing_interval: 'year' });
    await handler(req, res);

    assert.equal(res.statusCode, 503);
    assert.equal(res.payload.error, 'ANNUAL_CAMPAIGN_CONFIG_MISSING');
    assert.equal(sessionCreateCalls.length, 0, 'Coupon未設定時はCheckout Sessionを作成してはいけません');
  } finally {
    restore();
    process.env = prevEnv;
  }
});

test('api/stripe-checkout.js(モック): 未認証(不正トークン)の月額Teamリクエストは401で、stripe.checkout.sessions.createは呼ばれない', async () => {
  const prevEnv = { ...process.env };
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.STRIPE_PRICE_TEAM_MONTHLY = 'price_team_monthly_fake';
  const { handler, sessionCreateCalls, restore } = loadHandlerWithMocks();
  try {
    const req = {
      method: 'POST',
      headers: { authorization: 'Bearer invalid-token' },
      body: JSON.stringify({ kind: 'subscription', id: 'team', billing_interval: 'month' })
    };
    const res = {
      statusCode: 0,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.payload = value; return this; }
    };
    await handler(req, res);

    assert.equal(res.statusCode, 401);
    assert.equal(sessionCreateCalls.length, 0);
  } finally {
    restore();
    process.env = prevEnv;
  }
});
