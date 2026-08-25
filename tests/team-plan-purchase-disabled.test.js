'use strict';

// Teamプラン(¥298,000/月)は複数アカウント・共有クレジット・共有アセット・
// チーム管理が未実装のため、購入導線を無効化する。
// - pricing.html: ボタンにdisabled属性を付与し、クリックハンドラでも
//   isPurchaseDisabledPlan()で早期returnしてcheckout()を一切呼ばない
// - api/stripe-checkout.js: 月額分岐でid==='team'を常に拒否し、
//   STRIPE_PRICE_TEAM_MONTHLY未設定時の動的価格フォールバックへ進ませない

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const pricingHtml = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');
const checkoutSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'stripe-checkout.js'), 'utf8');

// ---------------------------------------------------------------
// pricing.html: 実際にDOMのクリックイベントをシミュレートし、
// Teamボタンを押してもcheckout()が一切呼ばれないことを確認する
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

  // Minimal DOM stub: querySelectorAll('#plans .btn') returns one fake
  // button per plan, matching what renderPlans() would have produced
  // (disabled buttons still receive an onclick handler in real DOM - the
  // guard must be inside the handler itself, not rely on the browser
  // refusing to fire disabled-button clicks).
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
    // stub it out here since it is unrelated to this guard.
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

test('pricing.html: isPurchaseDisabledPlanはTeamのみtrueを返す', () => {
  const { context } = loadPricingPlansHandlers();
  for (const p of context.plans) {
    assert.equal(context.isPurchaseDisabledPlan(p), p.cls === 'team', p.cls);
  }
});

test('pricing.html: Teamボタンをクリックしてもcheckout()は一切呼ばれない(月額表示)', () => {
  const { buttons, checkoutCalls } = loadPricingPlansHandlers({ billing: 'monthly' });
  const teamBtn = buttons.find(b => b.dataset.plan === 'team');
  assert.ok(teamBtn && typeof teamBtn.onclick === 'function', 'Teamボタンにonclickが割り当てられていません');

  teamBtn.onclick();

  assert.equal(checkoutCalls.length, 0, 'Teamボタンのクリックでcheckout()が呼ばれてしまっています');
});

test('pricing.html: Teamボタンをクリックしてもcheckout()は一切呼ばれない(年額表示)', () => {
  const { buttons, checkoutCalls } = loadPricingPlansHandlers({ billing: 'annual' });
  const teamBtn = buttons.find(b => b.dataset.plan === 'team');
  assert.ok(teamBtn && typeof teamBtn.onclick === 'function');

  teamBtn.onclick();

  assert.equal(checkoutCalls.length, 0, 'Teamボタン(年額表示)のクリックでcheckout()が呼ばれてしまっています');
});

test('pricing.html: Standard/Premium/Ultimate/Freeのクリック動作はTeamガード追加後も変わらない', () => {
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

  assert.equal(checkoutCalls.length, 3, 'Free/Team以外の3プランでcheckout()が呼ばれるはずです');
});

test('pricing.html: renderPlansはTeamボタンにdisabled/aria-disabledを付与する', () => {
  const start = pricingHtml.indexOf('function renderPlans(');
  const end = pricingHtml.indexOf('function attachPlanHandlers(', start);
  const src = pricingHtml.slice(start, end);
  assert.match(src, /const disabled=isPurchaseDisabledPlan\(p\)/);
  assert.match(src, /disabled\?' disabled aria-disabled="true"':''/);
  assert.match(src, /btn\$\{disabled\?' btnDisabled':''\}/);
});

test('pricing.html: Teamボタンのグレーアウト用CSS(.btnDisabled)が定義されている', () => {
  assert.match(pricingHtml, /\.btnDisabled,\.btnDisabled:disabled\{/);
});

test('pricing.html: attachPlanHandlersはisPurchaseDisabledPlanのガードをfree判定より先に評価する', () => {
  const start = pricingHtml.indexOf('function attachPlanHandlers(');
  const end = pricingHtml.indexOf('function renderPacks(', start);
  const src = pricingHtml.slice(start, end);

  const guardIndex = src.indexOf('isPurchaseDisabledPlan(plan)');
  const freeIndex = src.indexOf("cls==='free'");
  assert.ok(guardIndex >= 0, 'isPurchaseDisabledPlanによるガードが見つかりません');
  assert.ok(guardIndex < freeIndex, 'Teamガードはfree判定より先に評価される必要があります');
});

// ---------------------------------------------------------------
// api/stripe-checkout.js: サーバー側でも月額Teamを常に拒否する
// (STRIPE_PRICE_TEAM_MONTHLY未設定時の動的価格フォールバックを禁止)
// ---------------------------------------------------------------
test("api/stripe-checkout.js: 月額分岐はid==='team'をlineItemForMonthly呼び出しより前に拒否する", () => {
  const elseStart = checkoutSource.indexOf('// ── Monthly subscription');
  const elseEnd = checkoutSource.indexOf('} else if (kind === ', elseStart);
  const monthlyBranch = checkoutSource.slice(elseStart, elseEnd);

  const guardIndex = monthlyBranch.indexOf("id === 'team'");
  const lineItemIndex = monthlyBranch.indexOf('lineItemForMonthly(plan)');
  assert.ok(guardIndex >= 0, "id === 'team' のガードが見つかりません");
  assert.ok(lineItemIndex >= 0, 'lineItemForMonthly呼び出しが見つかりません');
  assert.ok(guardIndex < lineItemIndex, 'Teamガードはprice_data動的フォールバックより前に評価される必要があります');
});

test('api/stripe-checkout.js: 月額Teamのリクエストは(この環境にSTRIPE_SECRET_KEYがなくても)Checkout成立(200)には絶対ならない', async () => {
  // この実行環境にはSTRIPE_SECRET_KEY等の秘密情報が一切ないため、実際に
  // stripe.checkout.sessions.create()やSupabase認証まで到達させることは
  // できない(=実ネットワークに触れさせない)。ここでは「Teamの月額購入が
  // 200で成立することは絶対にない」という不変条件だけを、実際にhandler()
  // を呼び出して確認する。Teamガードの実体(lineItemForMonthlyより前で
  // 拒否している位置)は直前の静的検証テストでカバーしている。
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
  assert.notEqual(res.statusCode, 200, 'Teamプランの月額Checkoutが成立してはいけません');
});
