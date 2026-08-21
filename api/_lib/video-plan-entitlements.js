'use strict';

const SEEDANCE_25_ALLOWED_PLANS = Object.freeze(['premium', 'ultimate', 'team', 'scale']);

function hasSeedance25PlanAccess(plan, subscriptionExpiresAt, nowMs = Date.now()) {
  const normalizedPlan = String(plan || 'free').trim().toLowerCase();
  const expiresAtMs = Date.parse(String(subscriptionExpiresAt || ''));
  return SEEDANCE_25_ALLOWED_PLANS.includes(normalizedPlan)
    && Number.isFinite(expiresAtMs)
    && expiresAtMs > nowMs;
}

async function getSeedance25Entitlement(db, userId) {
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
    allowed: hasSeedance25PlanAccess(plan, subscriptionExpiresAt),
    plan,
    subscriptionExpiresAt
  };
}

module.exports = {
  SEEDANCE_25_ALLOWED_PLANS,
  hasSeedance25PlanAccess,
  getSeedance25Entitlement
};
