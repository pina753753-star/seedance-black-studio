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
  const { getCreditAccess } = require('./credit-access');
  const access = await getCreditAccess(db, userId, { paidPlans: SEEDANCE_25_ALLOWED_PLANS });
  if (!access.ok) return { ok: false, allowed: false, plan: 'free', error: access.error };
  return access;
}

// Add-on features keep the original subscription-only gate. Purchase access
// applies to normal generation models, not independent audio or storyboard.
async function getSeedance25SubscriptionEntitlement(db, userId) {
  const { readSubscriptionAccess } = require('./credit-access');
  const access = await readSubscriptionAccess(db, userId);
  if (!access.ok) return { ok: false, allowed: false, plan: 'free', error: access.error };
  return { ...access, allowed: access.accountStatus === 'active' && hasSeedance25PlanAccess(access.plan, access.subscriptionExpiresAt) };
}

module.exports = {
  SEEDANCE_25_ALLOWED_PLANS,
  hasSeedance25PlanAccess,
  getSeedance25Entitlement,
  getSeedance25SubscriptionEntitlement
};
