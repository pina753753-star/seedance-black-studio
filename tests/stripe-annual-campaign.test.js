'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const api = require('../api/stripe-checkout.js')._test;
const checkoutSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'stripe-checkout.js'), 'utf8');
const pricingHtml = fs.readFileSync(path.join(__dirname, '..', 'pricing.html'), 'utf8');

// JST boundary: 2026-10-01 00:00:00 JST = 2026-09-30 15:00:00 UTC.
const JST_23_59_59_ON_930 = Date.parse('2026-09-30T14:59:59Z'); // JST 2026-09-30 23:59:59
const JST_00_00_00_ON_1001 = Date.parse('2026-09-30T15:00:00Z'); // JST 2026-10-01 00:00:00
const COUPON_ID = 'coupon_annual10off';

function fakeBaseParams() {
  return { customer_email: 'user@example.com', client_reference_id: 'user-1' };
}

// ---------------------------------------------------------------
// 1. 期間内 + Coupon IDあり → 10%OFF Coupon
// ---------------------------------------------------------------
test('境界直前(JST 2026-09-30 23:59:59)はキャンペーン有効', () => {
  assert.equal(api.isAnnualCampaignActive(JST_23_59_59_ON_930), true);
});

test('Standard年額: 期間内+Coupon IDありはCouponが適用される', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.standard;
  const result = api.buildAnnualSubscriptionSessionParams({
    baseParams: fakeBaseParams(),
    plan,
    metadata: { plan: 'standard' },
    now: JST_23_59_59_ON_930,
    couponEnvValue: COUPON_ID
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.params.discounts, [{ coupon: COUPON_ID }]);
  assert.equal('allow_promotion_codes' in result.params, false);
});

test('Premium/Ultimate/Team年額も期間内+Coupon IDありはCouponが適用される', () => {
  for (const id of ['premium', 'ultimate', 'team']) {
    const plan = api.SUBSCRIPTION_PLANS_ANNUAL[id];
    const result = api.buildAnnualSubscriptionSessionParams({
      baseParams: fakeBaseParams(),
      plan,
      metadata: { plan: id },
      now: JST_23_59_59_ON_930,
      couponEnvValue: COUPON_ID
    });
    assert.equal(result.ok, true, `${id} が失敗しています`);
    assert.deepEqual(result.params.discounts, [{ coupon: COUPON_ID }], `${id} にCouponが適用されていません`);
    assert.equal('allow_promotion_codes' in result.params, false, `${id} にallow_promotion_codesが残っています`);
  }
});

// ---------------------------------------------------------------
// 2. 期間内 + Coupon IDなし → Checkout作成不可(fail closed)
// ---------------------------------------------------------------
test('Standard年額: 期間内+Coupon ID未設定はCheckoutを作成せず ok:false を返す', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.standard;
  const result = api.buildAnnualSubscriptionSessionParams({
    baseParams: fakeBaseParams(),
    plan,
    metadata: { plan: 'standard' },
    now: JST_23_59_59_ON_930,
    couponEnvValue: undefined
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ANNUAL_CAMPAIGN_CONFIG_MISSING');
  assert.equal('params' in result, false);
});

test('Premium/Ultimate/Team年額も期間内+Coupon ID未設定はCheckoutを作成しない', () => {
  for (const id of ['premium', 'ultimate', 'team']) {
    const plan = api.SUBSCRIPTION_PLANS_ANNUAL[id];
    const result = api.buildAnnualSubscriptionSessionParams({
      baseParams: fakeBaseParams(),
      plan,
      metadata: {},
      now: JST_23_59_59_ON_930,
      couponEnvValue: '   ' // 空白のみ = 未設定扱い
    });
    assert.equal(result.ok, false, `${id} がCoupon未設定でもokになっています`);
    assert.equal(result.error, 'ANNUAL_CAMPAIGN_CONFIG_MISSING');
  }
});

test('APIハンドラ: 期間内+Coupon未設定は503を返しStripeセッションを作成しない', async () => {
  const prevEnv = { ...process.env };
  try {
    delete process.env[api.ANNUAL_CAMPAIGN_COUPON_ENV];
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy';

    // stripe SDKのセッション作成が万一呼ばれたら気づけるよう、Stripeコンストラクタを
    // モックする代わりに、実際のhandlerは呼ばずbuildAnnualSubscriptionSessionParams
    // の結果だけで判定できることを確認する(handler内部でstripe.checkout.sessions.create
    // はannualSession.ok===falseの分岐より後にしか呼ばれない実装になっている)。
    const source = checkoutSource;
    const guardIndex = source.indexOf('if (!annualSession.ok)');
    const createCallIndex = source.indexOf('stripe.checkout.sessions.create(annualSession.params)');
    assert.ok(guardIndex > -1 && createCallIndex > guardIndex, 'annualSession.okのガードがsessions.create呼び出しより前にありません');

    const returnIndex = source.indexOf('return res.status(503)', guardIndex);
    assert.ok(returnIndex > guardIndex && returnIndex < createCallIndex, 'ok:false時に503でreturnしてから先へ進んでいません');
  } finally {
    process.env = prevEnv;
  }
});

// ---------------------------------------------------------------
// 3. 期間終了後 + Coupon IDあり → 通常価格
// ---------------------------------------------------------------
test('境界ちょうど(JST 2026-10-01 00:00:00)はキャンペーン終了', () => {
  assert.equal(api.isAnnualCampaignActive(JST_00_00_00_ON_1001), false);
});

test('Standard年額: 期間終了後はCoupon IDが設定されていても通常価格(allow_promotion_codes=true)に戻る', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.standard;
  const result = api.buildAnnualSubscriptionSessionParams({
    baseParams: fakeBaseParams(),
    plan,
    metadata: { plan: 'standard' },
    now: JST_00_00_00_ON_1001,
    couponEnvValue: COUPON_ID
  });
  assert.equal(result.ok, true);
  assert.equal(result.params.discounts, undefined);
  assert.equal(result.params.allow_promotion_codes, true);
});

test('lineItemForAnnualは期間の内外に関わらず既存のPrice ID環境変数を使う(新しい割引Price IDは使わない)', () => {
  const prevEnv = { ...process.env };
  try {
    process.env.STRIPE_PRICE_STANDARD_YEARLY = 'price_existing_standard_yearly';
    const item = api.lineItemForAnnual(api.SUBSCRIPTION_PLANS_ANNUAL.standard);
    assert.equal(item.price, 'price_existing_standard_yearly');
    assert.equal('price_data' in item, false);
  } finally {
    process.env = prevEnv;
  }
});

// ---------------------------------------------------------------
// 4. 月額 → 完全無変更
// ---------------------------------------------------------------
test('月額プランの定義にはキャンペーン関連フィールドが一切ない', () => {
  for (const id of ['standard', 'premium', 'ultimate', 'team']) {
    const plan = api.SUBSCRIPTION_PLANS[id];
    assert.ok(plan, `${id} の月額プラン定義が見つかりません`);
    assert.equal('discounts' in plan, false);
  }
});

test('月額Checkoutの分岐(else節)はbuildAnnualSubscriptionSessionParams/Couponに一切触れていない', () => {
  const elseStart = checkoutSource.indexOf('// ── Monthly subscription');
  const elseEnd = checkoutSource.indexOf('} else if (kind === ', elseStart);
  const monthlyBranch = checkoutSource.slice(elseStart, elseEnd);

  assert.doesNotMatch(monthlyBranch, /buildAnnualSubscriptionSessionParams/);
  assert.doesNotMatch(monthlyBranch, /discounts/);
  assert.doesNotMatch(monthlyBranch, /ANNUAL_CAMPAIGN_COUPON_ENV/);
  assert.match(monthlyBranch, /allow_promotion_codes:\s*true/);
});

test('月額プランのcredits・金額もキャンペーン導入前から変更されていない', () => {
  assert.equal(api.SUBSCRIPTION_PLANS.standard.credits, 800);
  assert.equal(api.SUBSCRIPTION_PLANS.premium.credits, 2100);
  assert.equal(api.SUBSCRIPTION_PLANS.ultimate.credits, 5100);
  assert.equal(api.SUBSCRIPTION_PLANS.standard.amount, 2980);
  assert.equal(api.SUBSCRIPTION_PLANS.premium.amount, 6980);
  assert.equal(api.SUBSCRIPTION_PLANS.ultimate.amount, 15800);
});

// ---------------------------------------------------------------
// 5. 9/30 23:59に描画後、10/1 00:00を跨いでクリック
//    → Checkoutせず通常価格へ再描画(pricing.htmlのshouldBlockAnnualCheckoutClick)
// ---------------------------------------------------------------
function loadPricingCampaignHelper() {
  const start = pricingHtml.indexOf('const ANNUAL_CAMPAIGN_CUTOFF_MS=');
  const end = pricingHtml.indexOf('function renderPlans(', start);
  const src = pricingHtml.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${src}
this.isAnnualCampaignActive = isAnnualCampaignActive;
this.ANNUAL_CAMPAIGN_CUTOFF_MS = ANNUAL_CAMPAIGN_CUTOFF_MS;
this.shouldShowAnnualCampaignPrice = shouldShowAnnualCampaignPrice;
this.shouldBlockAnnualCheckoutClick = shouldBlockAnnualCheckoutClick;
this.setServerAnnualCampaignAvailable = (v) => { serverAnnualCampaignAvailable = v; };
this.markDiscountShown = (cls) => { annualDiscountShown.add(cls); };
this.clearDiscountShown = () => { annualDiscountShown = new Set(); };
`, context);
  return context;
}

test('pricing.html: 割引価格を表示したまま期限を跨いだ場合だけブロックする。通常価格の表示では期限切れでも止めない', () => {
  const { shouldShowAnnualCampaignPrice, shouldBlockAnnualCheckoutClick, markDiscountShown, clearDiscountShown } = loadPricingCampaignHelper();
  const standardPlan = { cls: 'standard', annual: '35,760', campaignAnnual: '32,184' };
  const teamPlan = { cls: 'team', annual: '3,576,000', campaignAnnual: '3,218,400' };

  // 9/30 23:59時点で描画: 割引表示してよい。
  assert.equal(shouldShowAnnualCampaignPrice(JST_23_59_59_ON_930), true);

  // 通常価格を表示している(割引を表示していない)プランは、期限が切れていても止めない。
  clearDiscountShown();
  assert.equal(shouldBlockAnnualCheckoutClick(standardPlan, JST_00_00_00_ON_1001), false);
  assert.equal(shouldBlockAnnualCheckoutClick(teamPlan, JST_00_00_00_ON_1001), false);

  // 割引価格を表示した後に10/1 00:00を跨いでクリック: そのプランだけブロックする。
  markDiscountShown('standard');
  assert.equal(shouldBlockAnnualCheckoutClick(standardPlan, JST_00_00_00_ON_1001), true);
  assert.equal(shouldBlockAnnualCheckoutClick(teamPlan, JST_00_00_00_ON_1001), false, '割引を表示していない別プランは止めない');

  // 割引期間内なら、割引表示中でも従来どおり進む。
  assert.equal(shouldBlockAnnualCheckoutClick(standardPlan, JST_23_59_59_ON_930), false);

  // campaignAnnualを持たないプラン(Free等)は対象外。
  markDiscountShown('free');
  assert.equal(shouldBlockAnnualCheckoutClick({ cls: 'free' }, JST_00_00_00_ON_1001), false);
});

test('pricing.html: attachPlanHandlersのクリックハンドラはshouldBlockAnnualCheckoutClickでcheckout()を止めてから再描画する', () => {
  const start = pricingHtml.indexOf('function attachPlanHandlers(');
  const end = pricingHtml.indexOf('function renderPacks(', start);
  const src = pricingHtml.slice(start, end);

  assert.match(src, /shouldBlockAnnualCheckoutClick\(plan\)/);
  assert.match(src, /期間限定10%OFFは終了しました。通常価格に更新しました。内容をご確認のうえ、もう一度「購入する」を押してください。/);
  // ブロック時はrenderPlans()で再描画してからreturnし、checkout()を呼ばない導線になっていること。
  const blockIndex = src.indexOf('shouldBlockAnnualCheckoutClick(plan)');
  const renderIndex = src.indexOf('renderPlans()', blockIndex);
  const returnIndex = src.indexOf('return}', blockIndex);
  const checkoutCallIndex = src.indexOf("checkout('subscription',cls,btn,'year')", blockIndex);
  assert.ok(renderIndex > blockIndex && renderIndex < returnIndex, 'ブロック時にrenderPlans()を呼んでいません');
  assert.ok(returnIndex < checkoutCallIndex, 'ブロック時にcheckout()より先にreturnしていません');
});

test('pricing.html: サーバーがannualCampaignAvailable:falseと返した場合は表示を隠す(推奨機能)', () => {
  const { shouldShowAnnualCampaignPrice, setServerAnnualCampaignAvailable } = loadPricingCampaignHelper();

  // 未取得(null)時は日付だけで楽観表示してよい。
  assert.equal(shouldShowAnnualCampaignPrice(JST_23_59_59_ON_930), true);

  // サーバーが明示的にfalseと返したら、期間内でも表示を隠す。
  setServerAnnualCampaignAvailable(false);
  assert.equal(shouldShowAnnualCampaignPrice(JST_23_59_59_ON_930), false);
});

// ---------------------------------------------------------------
// 7. monthly_credits 800/2100/5100維持
// ---------------------------------------------------------------
test('年額プランのmonthly_credits・金額・Price ID環境変数名はキャンペーン導入前から変更されていない', () => {
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.standard.monthly_credits, 800);
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.premium.monthly_credits, 2100);
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.ultimate.monthly_credits, 5100);
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.standard.amount, 35760);
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.premium.amount, 83760);
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.ultimate.amount, 189600);
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.standard.env, 'STRIPE_PRICE_STANDARD_YEARLY');
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.premium.env, 'STRIPE_PRICE_PREMIUM_YEARLY');
  assert.equal(api.SUBSCRIPTION_PLANS_ANNUAL.ultimate.env, 'STRIPE_PRICE_ULTIMATE_YEARLY');
});

test('年額Teamプランの定義(毎月90,000credits・年額¥3,576,000・STRIPE_PRICE_TEAM_YEARLY)が正しい', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.team;
  assert.ok(plan, 'SUBSCRIPTION_PLANS_ANNUAL.teamが定義されていません');
  assert.equal(plan.monthly_credits, 90000);
  assert.equal(plan.amount, 3576000);
  assert.equal(plan.env, 'STRIPE_PRICE_TEAM_YEARLY');
  assert.equal(plan.plan, 'team');
  // 12か月分を一括付与しない: creditsフィールドはmonthly_creditsのみで、
  // 年間合計(annualCredits/1,080,000)に相当するフィールドはサーバー側の
  // プラン定義には存在しない(月次付与の起点となるのはmonthly_creditsのみ)。
  assert.equal('annual_credits' in plan, false);
  assert.equal('credits' in plan, false);
});

// ---------------------------------------------------------------
// 推奨: annualCampaignAvailable(GET応答)はCoupon IDを漏らさず、期間+設定済みの
// 両方を満たす場合のみtrueを返す
// ---------------------------------------------------------------
test('isAnnualCampaignAvailable: 期間内+Coupon設定済みのみtrue、Coupon IDそのものは戻り値に含まれない', () => {
  assert.equal(api.isAnnualCampaignAvailable(JST_23_59_59_ON_930, COUPON_ID), true);
  assert.equal(api.isAnnualCampaignAvailable(JST_23_59_59_ON_930, ''), false);
  assert.equal(api.isAnnualCampaignAvailable(JST_23_59_59_ON_930, undefined), false);
  assert.equal(api.isAnnualCampaignAvailable(JST_00_00_00_ON_1001, COUPON_ID), false);
});

test('APIハンドラ: GETレスポンスにannualCampaignAvailableのみ含み、Coupon ID文字列は含まれない', () => {
  const prevEnv = { ...process.env };
  try {
    process.env[api.ANNUAL_CAMPAIGN_COUPON_ENV] = COUPON_ID;
    const handler = require('../api/stripe-checkout.js');
    const res = {
      statusCode: 0,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.payload = value; return this; }
    };
    return handler({ method: 'GET' }, res).then(() => {
      assert.equal(res.statusCode, 200);
      assert.equal(typeof res.payload.annualCampaignAvailable, 'boolean');
      assert.equal(JSON.stringify(res.payload).includes(COUPON_ID), false);
    });
  } finally {
    process.env = prevEnv;
  }
});

// ---------------------------------------------------------------
// その他: campaignAnnualの表示定義・月額表示ロジック無変更の確認
// ---------------------------------------------------------------
test('pricing.html: campaignAnnualは年額プラン(Standard/Premium/Ultimate/Team)に設定され、月額表示ロジックは変更されていない', () => {
  assert.match(pricingHtml, /campaignAnnual:'32,184'/);
  assert.match(pricingHtml, /campaignAnnual:'75,384'/);
  assert.match(pricingHtml, /campaignAnnual:'170,640'/);
  assert.match(pricingHtml, /campaignAnnual:'3,218,400'/);
  assert.match(pricingHtml, /期間限定10%OFF/);
  assert.match(pricingHtml, /2026年9月30日まで/);
  const monthlyBranchStart = pricingHtml.indexOf('}else{priceHtml=`<div class="price"><span class="yen">¥</span><strong class="amount">${p.monthly}</strong>');
  assert.ok(monthlyBranchStart > -1, '月額表示分岐が見つかりません');
});

// ---------------------------------------------------------------
// 6. 本物のrenderPlans / attachPlanHandlersでクリックを通す(実決済はしない: checkout()は記録するだけ)
// ---------------------------------------------------------------
function loadPricingPage({ billing = 'annual', clock, serverAvailable = null } = {}) {
  const plansStart = pricingHtml.indexOf('const plans=[');
  const plansEnd = pricingHtml.indexOf('\n', pricingHtml.indexOf('];', plansStart)) + 1;
  const helperStart = pricingHtml.indexOf('const ANNUAL_CAMPAIGN_CUTOFF_MS=');
  const helperEnd = pricingHtml.indexOf('function renderPacks(', helperStart);
  const src = pricingHtml.slice(plansStart, plansEnd) + pricingHtml.slice(helperStart, helperEnd);
  const checkoutCalls = [], messages = [], buttons = [];
  const plansEl = { innerHTML: '' };
  const RealDate = Date;
  const FakeDate = { now: () => clock.t, parse: (v) => RealDate.parse(v) };
  const context = {
    billing, plansEl, Date: FakeDate, REFERENCE_AUDIO_UI_ENABLED: false, location: { href: '' }, URL, console,
    checkout: (...args) => { checkoutCalls.push(args); },
    showMsg: (msg, bad) => { messages.push({ msg, bad: !!bad }); },
    document: { querySelectorAll(sel) { assert.equal(sel, '#plans .btn'); return buttons; } }
  };
  vm.createContext(context);
  vm.runInContext(`${src}\nserverAnnualCampaignAvailable = ${JSON.stringify(serverAvailable)};\nthis.plans = plans;\nthis.renderPlans = renderPlans;\nthis.attachPlanHandlers = attachPlanHandlers;\nthis.shown = () => JSON.stringify([...annualDiscountShown]);`, context);
  // renderPlans() writes the HTML and then calls attachPlanHandlers() in the real file's callers; rebuild the buttons from the plans it rendered.
  function render() {
    context.renderPlans();
    buttons.length = 0;
    for (const p of context.plans) buttons.push({ dataset: { plan: p.cls }, onclick: null, set textContent(_v) {}, get textContent() { return ''; }, disabled: false });
    context.attachPlanHandlers();
  }
  const click = (cls) => { const b = buttons.find((x) => x.dataset.plan === cls); b.onclick(); };
  render();
  return { context, render, click, checkoutCalls, messages, plansEl };
}

test('pricing.html(実際の描画とクリック): 通常の年額価格を表示中は、過去の割引期限が切れていても購入を止めない', () => {
  // 期限後に最初に開いたページ: 通常価格が表示され、クリックはそのままCheckoutへ進む。
  const clock = { t: JST_00_00_00_ON_1001 + 3600e3 };
  const page = loadPricingPage({ clock });
  assert.deepEqual(JSON.parse(page.context.shown()), [], '割引は表示していない');
  assert.doesNotMatch(page.plansEl.innerHTML, /期間限定10%OFF/);
  for (const cls of ['standard', 'premium', 'ultimate', 'team']) {
    page.click(cls);
  }
  assert.deepEqual(page.checkoutCalls.map((c) => c.slice(0, 2).concat(c[3])), [
    ['subscription', 'standard', 'year'], ['subscription', 'premium', 'year'], ['subscription', 'ultimate', 'year'], ['subscription', 'team', 'year']
  ]);
  assert.equal(page.messages.length, 0);
});

test('pricing.html(実際の描画とクリック): 割引期間中は従来どおり割引価格で進む', () => {
  const clock = { t: JST_23_59_59_ON_930 - 3600e3 };
  const page = loadPricingPage({ clock });
  assert.match(page.plansEl.innerHTML, /期間限定10%OFF/);
  assert.deepEqual(JSON.parse(page.context.shown()).sort(), ['premium', 'standard', 'team', 'ultimate']);
  page.click('standard');
  assert.deepEqual(page.checkoutCalls.map((c) => [c[0], c[1], c[3]]), [['subscription', 'standard', 'year']]);
  assert.equal(page.messages.length, 0);
});

test('pricing.html(実際の描画とクリック): 割引表示のまま期限を跨ぐと、最初のクリックは決済を開始せず通常価格へ更新し、再クリックで進む', () => {
  const clock = { t: JST_23_59_59_ON_930 - 1000 };
  const page = loadPricingPage({ clock });
  assert.match(page.plansEl.innerHTML, /期間限定10%OFF/);
  clock.t = JST_00_00_00_ON_1001 + 1000; // 画面を開いたまま日付を跨ぐ
  page.click('standard');
  assert.equal(page.checkoutCalls.length, 0, '最初のクリックでは決済を開始しない');
  assert.equal(page.messages.length, 1); assert.equal(page.messages[0].bad, true);
  assert.match(page.messages[0].msg, /通常価格に更新しました/); assert.match(page.messages[0].msg, /もう一度/);
  assert.doesNotMatch(page.plansEl.innerHTML, /期間限定10%OFF/, '通常価格へ再描画された');
  assert.match(page.plansEl.innerHTML, /35,760/);
  // ページはクリック内の再描画(renderPlans)の後、ボタンへハンドラを付け直す。ここでも同じように付け直してから再クリックする。
  page.render();
  page.click('standard');
  assert.deepEqual(page.checkoutCalls.map((c) => [c[0], c[1], c[3]]), [['subscription', 'standard', 'year']], '再クリックで決済へ進む');
  assert.equal(page.messages.length, 1, '2回目はメッセージも出さない');
});

test('pricing.html(実際の描画とクリック): サーバーが割引利用不可と返して通常価格を表示している場合も止めない / 月額は期限と無関係', () => {
  const clock = { t: JST_23_59_59_ON_930 - 3600e3 };
  const noCoupon = loadPricingPage({ clock, serverAvailable: false });
  assert.doesNotMatch(noCoupon.plansEl.innerHTML, /期間限定10%OFF/);
  noCoupon.click('standard');
  assert.deepEqual(noCoupon.checkoutCalls.map((c) => [c[0], c[1], c[3]]), [['subscription', 'standard', 'year']]);
  // 月額: 期限を跨いでも、割引表示の有無に関係なく、常にmonthで進む
  const after = loadPricingPage({ billing: 'monthly', clock: { t: JST_00_00_00_ON_1001 + 1e6 } });
  after.click('standard'); after.click('team');
  assert.deepEqual(after.checkoutCalls.map((c) => [c[0], c[1], c[3]]), [['subscription', 'standard', 'month'], ['subscription', 'team', 'month']]);
  assert.equal(after.messages.length, 0);
});
