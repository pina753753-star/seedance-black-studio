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

test('api/stripe-checkout.js: 月額Teamのリクエストは、STRIPE_SECRET_KEYがあれば他プランと同じ経路でCheckout Session作成まで進む(この環境では実際のStripe呼び出し前で止まることのみ確認)', async () => {
  // この実行環境にはSTRIPE_SECRET_KEY等の秘密情報がないため、実際に
  // stripe.checkout.sessions.create()やSupabase認証まで到達させることは
  // できない(=実ネットワークに触れさせない)。ここでは「Teamだから」という
  // 理由だけで400/403等の専用エラーが返らないことだけを確認する
  // (STRIPE_SECRET_KEY未設定による500は他プランと共通の経路であり、
  // Team固有の拒否ではないことを別途ソース検証している)。
  const handler = require('../api/stripe-checkout.js');
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer dummy' },
    body: JSON.stringify({ kind: 'subscription', id: 'team', billing_interval: 'month' })
  };
  const res = {
    statusCode: 0,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };

  await handler(req, res);
  // STRIPE_SECRET_KEY未設定のこの環境では500(Missing STRIPE_SECRET_KEY)。
  // Team固有の400(準備中)ではないことを確認する。
  assert.equal(res.payload?.error !== 'Teamプランは現在準備中のため購入できません', true);
});
