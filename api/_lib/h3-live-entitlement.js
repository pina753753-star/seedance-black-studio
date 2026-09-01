'use strict';

// H3 Live eligibility check.
//
// Independent copy of the entitlement pattern used by
// api/_lib/video-plan-entitlements.js (getSeedance25Entitlement): read
// profiles.plan + credit_balances.subscription_expires_at, lowercase-compare
// the plan against an allow-list, AND require an unexpired subscription so a
// plan-name match on a lapsed subscription does not grant access.
//
// The allow-list lives in api/_lib/h3-live-config.js (ALLOWED_PLANS) so plan
// eligibility can be changed in one place.

const { ALLOWED_PLANS } = require('./h3-live-config.js');

function hasH3LivePlanAccess(plan, subscriptionExpiresAt, nowMs = Date.now()) {
  const normalizedPlan = String(plan || 'free').trim().toLowerCase();
  if (!ALLOWED_PLANS.includes(normalizedPlan)) return false;
  const expiresAtMs = Date.parse(String(subscriptionExpiresAt || ''));
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

// db must be a service-role Supabase client. Returns:
//   { ok:true,  allowed:boolean, plan, subscriptionExpiresAt }
//   { ok:false, allowed:false, plan:'free', error }  when the lookup fails
//   (callers must fail closed — do NOT start a generation on ok:false).
async function getH3LiveEntitlement(db, userId) {
  let profileResult;
  let balanceResult;
  try {
    [profileResult, balanceResult] = await Promise.all([
      db.from('profiles').select('plan').eq('id', userId).maybeSingle(),
      db.from('credit_balances').select('subscription_expires_at').eq('user_id', userId).maybeSingle()
    ]);
  } catch (_) {
    return { ok: false, allowed: false, plan: 'free', error: 'plan_lookup_failed' };
  }

  if (profileResult?.error || balanceResult?.error || !profileResult || !balanceResult) {
    return { ok: false, allowed: false, plan: 'free', error: 'plan_lookup_failed' };
  }

  const plan = String(profileResult.data?.plan || 'free').trim().toLowerCase();
  const subscriptionExpiresAt = balanceResult.data?.subscription_expires_at || null;
  return {
    ok: true,
    allowed: hasH3LivePlanAccess(plan, subscriptionExpiresAt),
    plan,
    subscriptionExpiresAt
  };
}

module.exports = {
  ALLOWED_PLANS,
  hasH3LivePlanAccess,
  getH3LiveEntitlement
};
