'use strict';

const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { getCreditAccess } = require('./_lib/credit-access.js');
const MODEL_PAID_PLANS = Object.freeze(['premium', 'ultimate', 'team', 'scale']);

// Read-only, owner-scoped UI capabilities. No balances, payment rows, identity
// attributes or plan mutations are exposed. Start APIs remain authoritative.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  try {
    const access = await getCreditAccess(auth.supabase, auth.user.id, { paidPlans: MODEL_PAID_PLANS });
    if (!access?.ok) return res.status(503).json({ ok: false, error: 'entitlement_unavailable' });
    if (access.accountStatus !== 'active') return res.status(403).json({ ok: false, error: 'account_restricted' });
    const subscriptionExtras = access.hasActiveSubscription === true && MODEL_PAID_PLANS.includes(access.plan);
    return res.status(200).json({
      ok: true,
      seedance25: access.allowed === true,
      resolution1080: access.hasActiveSubscription === true,
      referenceAudio: subscriptionExtras,
      storyboard25: subscriptionExtras,
      watermarkRequired: access.watermarkRequired !== false
    });
  } catch (_) {
    return res.status(503).json({ ok: false, error: 'entitlement_unavailable' });
  }
};
