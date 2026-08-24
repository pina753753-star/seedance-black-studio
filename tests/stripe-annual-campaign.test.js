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

test('Premium/Ultimate年額も期間内+Coupon IDありはCouponが適用される', () => {
  for (const id of ['premium', 'ultimate']) {
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

test('Premium/Ultimate年額も期間内+Coupon ID未設定はCheckoutを作成しない', () => {
  for (const id of ['premium', 'ultimate']) {
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
  for (const id of ['standard', 'premium', 'ultimate']) {
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
`, context);
  return context;
}

test('pricing.html: 描画時(JST 9/30 23:59)は割引表示OKだが、クリック時(JST 10/1 00:00)はブロックされる', () => {
  const { shouldShowAnnualCampaignPrice, shouldBlockAnnualCheckoutClick } = loadPricingCampaignHelper();
  const standardPlan = { cls: 'standard', annual: '35,760', campaignAnnual: '32,184' };

  // 9/30 23:59時点で描画: 割引表示してよい。
  assert.equal(shouldShowAnnualCampaignPrice(JST_23_59_59_ON_930), true);

  // 画面を開いたまま10/1 00:00になってからクリック: Checkoutをブロックする。
  assert.equal(shouldBlockAnnualCheckoutClick(standardPlan, JST_00_00_00_ON_1001), true);

  // campaignAnnualを持たないプラン(Free/Team等)はそもそもブロック対象外。
  assert.equal(shouldBlockAnnualCheckoutClick({ cls: 'team' }, JST_00_00_00_ON_1001), false);

  // 期間内であれば通常通りブロックしない。
  assert.equal(shouldBlockAnnualCheckoutClick(standardPlan, JST_23_59_59_ON_930), false);
});

test('pricing.html: attachPlanHandlersのクリックハンドラはshouldBlockAnnualCheckoutClickでcheckout()を止めてから再描画する', () => {
  const start = pricingHtml.indexOf('function attachPlanHandlers(');
  const end = pricingHtml.indexOf('function renderPacks(', start);
  const src = pricingHtml.slice(start, end);

  assert.match(src, /shouldBlockAnnualCheckoutClick\(plan\)/);
  assert.match(src, /期間限定10%OFFは終了しました。通常価格をご確認ください。/);
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
// 6. stripe-webhook.js無変更
// ---------------------------------------------------------------
test('api/stripe-webhook.jsはgit上で無変更', () => {
  const { execFileSync } = require('node:child_process');
  const repoRoot = path.join(__dirname, '..');

  let diff;
  try {
    diff = execFileSync('git', ['diff', '--stat', 'origin/main...HEAD', '--', 'api/stripe-webhook.js'], { cwd: repoRoot }).toString().trim();
  } catch (_) {
    diff = execFileSync('git', ['diff', '--stat', 'HEAD', '--', 'api/stripe-webhook.js'], { cwd: repoRoot }).toString().trim();
  }
  assert.equal(diff, '', `api/stripe-webhook.js に差分があってはいけません: ${diff}`);
});

test('supabase/migrations配下に新規ファイルが追加されていない(DB変更なし)', () => {
  const { execFileSync } = require('node:child_process');
  const repoRoot = path.join(__dirname, '..');

  let diffNames;
  try {
    diffNames = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD', '--', 'supabase/'], { cwd: repoRoot }).toString().trim();
  } catch (_) {
    diffNames = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'supabase/'], { cwd: repoRoot }).toString().trim();
  }
  assert.equal(diffNames, '', `supabase/ 配下に差分があってはいけません: ${diffNames}`);
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
test('pricing.html: campaignAnnualは年額プラン(Standard/Premium/Ultimate)にのみ設定され、月額表示ロジックは変更されていない', () => {
  assert.match(pricingHtml, /campaignAnnual:'32,184'/);
  assert.match(pricingHtml, /campaignAnnual:'75,384'/);
  assert.match(pricingHtml, /campaignAnnual:'170,640'/);
  assert.match(pricingHtml, /期間限定10%OFF/);
  assert.match(pricingHtml, /2026年9月30日まで/);
  const monthlyBranchStart = pricingHtml.indexOf('}else{priceHtml=`<div class="price"><span class="yen">¥</span><strong class="amount">${p.monthly}</strong>');
  assert.ok(monthlyBranchStart > -1, '月額表示分岐が見つかりません');
});
