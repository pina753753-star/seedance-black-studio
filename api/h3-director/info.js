'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { checkDirectorEnabled, getDirectorEntitlement } = require('../_lib/h3-director-store.js');
const {
  ALLOWED_PLANS, CREDIT_COST, DURATION_SECONDS, RESOLUTION,
  DEFAULT_ASPECT_RATIO, ALLOWED_ASPECT_RATIOS,
  HEARTBEAT_INTERVAL_MS
} = require('../_lib/h3-director-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const [control, entitlement] = await Promise.all([
    checkDirectorEnabled(auth.supabase),
    getDirectorEntitlement(auth.supabase, auth.user.id, ALLOWED_PLANS)
  ]);
  if (!entitlement.ok) {
    return res.status(503).json({ ok: false, error: 'entitlement_unavailable' });
  }

  // Same Preview-only relaxation as start-session.js / image-upload-url.js:
  // report "enabled" to the UI on Preview even while the kill switch is OFF,
  // so the gate does not block a one-time real-device test. The actual
  // authorization decision is still made server-side in start-session.js.
  const isVercelPreview = process.env.VERCEL_ENV === 'preview';

  return res.status(200).json({
    ok: true,
    enabled: control.ok || isVercelPreview,
    eligible: entitlement.allowed,
    accountStatus: entitlement.accountStatus,
    plan: entitlement.plan,
    balance: entitlement.balance,
    fixed: {
      durationSeconds: DURATION_SECONDS,
      resolution: RESOLUTION,
      aspectRatio: DEFAULT_ASPECT_RATIO,
      allowedAspectRatios: ALLOWED_ASPECT_RATIOS,
      creditCost: CREDIT_COST,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
    }
  });
};
