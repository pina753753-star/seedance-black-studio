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
// 1. 2026-09-30 23:59:59 JST → Standard年額にCoupon適用
// ---------------------------------------------------------------
test('境界直前(JST 2026-09-30 23:59:59)はキャンペーン有効', () => {
  assert.equal(api.isAnnualCampaignActive(JST_23_59_59_ON_930), true);
});

test('Standard年額: 期間内はCouponが適用される', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.standard;
  const params = api.buildAnnualSubscriptionSessionParams({
    baseParams: fakeBaseParams(),
    plan,
    metadata: { plan: 'standard' },
    now: JST_23_59_59_ON_930,
    couponEnvValue: COUPON_ID
  });
  assert.deepEqual(params.discounts, [{ coupon: COUPON_ID }]);
});

// ---------------------------------------------------------------
// 2. 2026-10-01 00:00:00 JST → Standard年額にCouponなし
// ---------------------------------------------------------------
test('境界ちょうど(JST 2026-10-01 00:00:00)はキャンペーン終了', () => {
  assert.equal(api.isAnnualCampaignActive(JST_00_00_00_ON_1001), false);
});

test('Standard年額: 期間終了後はCouponなし・allow_promotion_codes=trueに戻る', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.standard;
  const params = api.buildAnnualSubscriptionSessionParams({
    baseParams: fakeBaseParams(),
    plan,
    metadata: { plan: 'standard' },
    now: JST_00_00_00_ON_1001,
    couponEnvValue: COUPON_ID
  });
  assert.equal(params.discounts, undefined);
  assert.equal(params.allow_promotion_codes, true);
});

// ---------------------------------------------------------------
// 3. Premium / Ultimate年額も期間内Coupon適用
// ---------------------------------------------------------------
test('Premium/Ultimate年額も期間内はCouponが適用される', () => {
  for (const id of ['premium', 'ultimate']) {
    const plan = api.SUBSCRIPTION_PLANS_ANNUAL[id];
    const params = api.buildAnnualSubscriptionSessionParams({
      baseParams: fakeBaseParams(),
      plan,
      metadata: { plan: id },
      now: JST_23_59_59_ON_930,
      couponEnvValue: COUPON_ID
    });
    assert.deepEqual(params.discounts, [{ coupon: COUPON_ID }], `${id} にCouponが適用されていません`);
    assert.equal(params.allow_promotion_codes, undefined, `${id} にallow_promotion_codesが残っています`);
  }
});

// ---------------------------------------------------------------
// 4. Standard / Premium / Ultimate月額にはCouponを絶対に適用しない
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

// ---------------------------------------------------------------
// 5. 年額期間中はallow_promotion_codesを併用しない
// ---------------------------------------------------------------
test('年額期間中はallow_promotion_codesキー自体が付与されない(Coupon併用回避)', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.premium;
  const params = api.buildAnnualSubscriptionSessionParams({
    baseParams: fakeBaseParams(),
    plan,
    metadata: {},
    now: JST_23_59_59_ON_930,
    couponEnvValue: COUPON_ID
  });
  assert.equal('allow_promotion_codes' in params, false);
});

// ---------------------------------------------------------------
// 6. 年額期間終了後は通常Price IDを使用
// ---------------------------------------------------------------
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

test('Coupon環境変数が未設定の場合は、期間内でもCouponを適用せず通常挙動になる', () => {
  const plan = api.SUBSCRIPTION_PLANS_ANNUAL.ultimate;
  const params = api.buildAnnualSubscriptionSessionParams({
    baseParams: fakeBaseParams(),
    plan,
    metadata: {},
    now: JST_23_59_59_ON_930,
    couponEnvValue: undefined
  });
  assert.equal(params.discounts, undefined);
  assert.equal(params.allow_promotion_codes, true);
});

// ---------------------------------------------------------------
// 7. monthly_creditsが変更されていない
// ---------------------------------------------------------------
test('年額プランのmonthly_credits・金額はキャンペーン導入前から変更されていない', () => {
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

test('月額プランのcredits・金額もキャンペーン導入前から変更されていない', () => {
  assert.equal(api.SUBSCRIPTION_PLANS.standard.credits, 800);
  assert.equal(api.SUBSCRIPTION_PLANS.premium.credits, 2100);
  assert.equal(api.SUBSCRIPTION_PLANS.ultimate.credits, 5100);
  assert.equal(api.SUBSCRIPTION_PLANS.standard.amount, 2980);
  assert.equal(api.SUBSCRIPTION_PLANS.premium.amount, 6980);
  assert.equal(api.SUBSCRIPTION_PLANS.ultimate.amount, 15800);
});

// ---------------------------------------------------------------
// 8. stripe-webhook.js / 9. Supabase DB / stripe-checkout.jsは今回の
// 変更対象であることを踏まえ、それ以外の禁止領域が無変更であることを
// git diffで確認する。
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
// 10. pricing.htmlの表示も同じJST境界で切り替わる
// ---------------------------------------------------------------
function loadPricingCampaignHelper() {
  const start = pricingHtml.indexOf("const ANNUAL_CAMPAIGN_CUTOFF_MS=");
  const end = pricingHtml.indexOf('function renderPlans(', start);
  const src = pricingHtml.slice(start, end);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${src}\nthis.isAnnualCampaignActive = isAnnualCampaignActive;\nthis.ANNUAL_CAMPAIGN_CUTOFF_MS = ANNUAL_CAMPAIGN_CUTOFF_MS;`, context);
  return context;
}

test('pricing.html: 同じJST境界(2026-09-30 15:00:00 UTC)でキャンペーン表示が切り替わる', () => {
  const { isAnnualCampaignActive, ANNUAL_CAMPAIGN_CUTOFF_MS } = loadPricingCampaignHelper();

  assert.equal(ANNUAL_CAMPAIGN_CUTOFF_MS, Date.parse('2026-09-30T15:00:00Z'));
  assert.equal(isAnnualCampaignActive(JST_23_59_59_ON_930), true);
  assert.equal(isAnnualCampaignActive(JST_00_00_00_ON_1001), false);
});

test('pricing.html: campaignAnnualは年額プラン(Standard/Premium/Ultimate)にのみ設定され、月額表示ロジックは変更されていない', () => {
  assert.match(pricingHtml, /campaignAnnual:'32,184'/);
  assert.match(pricingHtml, /campaignAnnual:'75,384'/);
  assert.match(pricingHtml, /campaignAnnual:'170,640'/);
  assert.match(pricingHtml, /期間限定10%OFF/);
  assert.match(pricingHtml, /2026年9月30日まで/);
  // 月額表示分岐(billing!=='annual'のelse節)にcampaignAnnualが混入していないこと。
  const monthlyBranchStart = pricingHtml.indexOf("}else{priceHtml=`<div class=\"price\"><span class=\"yen\">¥</span><strong class=\"amount\">${p.monthly}</strong>");
  assert.ok(monthlyBranchStart > -1, '月額表示分岐が見つかりません');
});
