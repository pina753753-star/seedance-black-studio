'use strict';

// Subscription benefits and credit-purchase access are deliberately separate.
// Never mutate profiles.plan or subscription expiry to grant pack access.
const PAID_PLANS = Object.freeze(['standard', 'premium', 'ultimate', 'team', 'scale']);
const MODEL_PLANS = Object.freeze(['premium', 'ultimate', 'team', 'scale']);
function activeSubscription(plan, expiry, now = Date.now()) {
  return PAID_PLANS.includes(String(plan || '').trim().toLowerCase())
    && Number.isFinite(Date.parse(String(expiry || '')))
    && Date.parse(String(expiry)) > now;
}
function effectiveBalance(row, now = Date.now()) {
  const n = value => Math.max(0, Number(value) || 0);
  const sub = Date.parse(String(row.subscription_expires_at || ''));
  const purchased = Date.parse(String(row.purchased_expires_at || ''));
  return n(row.free_credits)
    + (sub > now ? n(row.subscription_credits) : 0)
    + (purchased > now ? n(row.purchased_credits) : 0);
}
async function readSubscriptionAccess(db, userId, now = Date.now()) {
  try {
    const [profile, balance] = await Promise.all([
      db.from('profiles').select('plan,account_status').eq('id', userId).maybeSingle(),
      db.from('credit_balances').select('free_credits,subscription_credits,purchased_credits,subscription_expires_at,purchased_expires_at').eq('user_id', userId).maybeSingle()
    ]);
    if (profile.error || balance.error || !profile.data || !balance.data) throw new Error('lookup');
    const plan = String(profile.data.plan || 'free').trim().toLowerCase();
    const hasActiveSubscription = activeSubscription(plan, balance.data.subscription_expires_at, now);
    return { ok: true, plan, accountStatus: String(profile.data.account_status || 'active'),
      hasActiveSubscription, watermarkRequired: !hasActiveSubscription,
      subscriptionExpiresAt: balance.data.subscription_expires_at || null,
      balance: effectiveBalance(balance.data, now), balanceRow: balance.data };
  } catch (_) {
    return { ok: false, allowed: false, plan: 'free', hasActiveSubscription: false, watermarkRequired: true, error: 'plan_lookup_failed' };
  }
}
async function getCreditAccess(db, userId, { paidPlans = MODEL_PLANS, now = Date.now() } = {}) {
  const base = await readSubscriptionAccess(db, userId, now);
  if (!base.ok) return base;
  const { balanceRow, ...result } = base;
  result.allowed = false;
  result.hasPurchasedAccess = false;
  if (base.accountStatus !== 'active') return { ...result, error: 'account_restricted' };
  // Existing subscriber path retains its feature allow-list. Every active
  // subscription, including Standard, retains its watermark exemption.
  if (base.hasActiveSubscription && paidPlans.includes(base.plan)) {
    return { ...result, allowed: true };
  }
  if (!(Number(balanceRow.purchased_credits) > 0)
      || !(Date.parse(String(balanceRow.purchased_expires_at || '')) > now)) return result;
  try {
    // A positive aggregate balance is not evidence of a settled purchase.
    // Mixed/unresolved risk holds deny NEW purchase-based feature access;
    // they never confiscate balances or change the existing refund paths.
    const [grant, held, risk] = await Promise.all([
      db.from('stripe_payment_ledger').select('id').eq('user_id', userId).eq('purchase_type', 'credit_pack').eq('grant_status', 'granted').limit(1).maybeSingle(),
      db.from('stripe_payment_ledger').select('id').eq('user_id', userId).in('grant_status', ['held', 'reversed']).limit(1).maybeSingle(),
      db.from('payment_risk_events').select('id').eq('user_id', userId).in('status', ['open', 'reviewing']).limit(1).maybeSingle()
    ]);
    if (grant.error || held.error || risk.error) throw new Error('lookup');
    const hasPurchasedAccess = Boolean(grant.data && !held.data && !risk.data);
    return { ...result, allowed: hasPurchasedAccess, hasPurchasedAccess, ...(held.data || risk.data ? { error: 'payment_risk_hold' } : {}) };
  } catch (_) {
    return { ...result, ok: false, error: 'purchase_access_lookup_failed' };
  }
}
// A task whose output was earned with a subscription keeps that output policy.
// Legacy rows have no snapshot and use a freshly checked subscription policy.
function taskRequiresWatermark(task, access) {
  return typeof task?.settings?.watermark_required === 'boolean'
    ? task.settings.watermark_required : access?.watermarkRequired !== false;
}
module.exports = { PAID_PLANS, MODEL_PLANS, activeSubscription, effectiveBalance, readSubscriptionAccess, getCreditAccess, taskRequiresWatermark };
