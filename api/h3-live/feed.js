'use strict';

// GET /api/h3-live/feed
//
// Lightweight projection for the broadcast-style screen in h3-live.html:
//   - activeJob:   the caller's sole queued/submitting/processing job (if any)
//   - onAir:       the caller's most recently completed job (if any)
//   - eligibility: { planAllowed, creditCost, balance, hasEnoughCredits } — lets
//                  the client pre-disable the "send" button (plan / credits) so
//                  the common rejections never require a round-trip. This is a
//                  UX hint only; api/h3-live/start.js still performs the
//                  authoritative plan + balance + reserve/deduct checks.
// Database read only; never calls fal.ai and never writes a balance. Sends a
// weak ETag so the client poll costs almost nothing when nothing changed.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { serviceClient, sanitizeJob } = require('../_lib/h3-live-store.js');
const { getH3LiveEntitlement } = require('../_lib/h3-live-entitlement.js');
const { FEED_POLL_MS, CREDIT_COST } = require('../_lib/h3-live-config.js');

// Effective credit balance, computed the SAME way deduct_h3_live_credits_atomic
// does (20260831090000_create_h3_live_slice.sql): an expired subscription or
// purchased pool counts as zero; free credits never expire. Read-only — this
// never persists the zeroing the way the RPC does.
function effectiveBalance(row) {
  if (!row || typeof row !== 'object') return null;
  const now = Date.now();
  let subscription = Number(row.subscription_credits || 0);
  let purchased = Number(row.purchased_credits || 0);
  const subExpiresAt = Date.parse(String(row.subscription_expires_at || ''));
  const purExpiresAt = Date.parse(String(row.purchased_expires_at || ''));
  if (Number.isFinite(subExpiresAt) && subExpiresAt < now) subscription = 0;
  if (Number.isFinite(purExpiresAt) && purExpiresAt < now) purchased = 0;
  const free = Number(row.free_credits || 0);
  const total = free + subscription + purchased;
  return Number.isFinite(total) ? Math.max(0, total) : null;
}

const crypto = require('crypto');

const ACTIVE = ['queued', 'submitting', 'processing'];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'GET only.' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  const [activeResult, onAirResult, balanceResult, entitlement] = await Promise.all([
    db.from('h3_live_jobs')
      .select('*')
      .eq('user_id', auth.user.id)
      .in('status', ACTIVE)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('h3_live_jobs')
      .select('*')
      .eq('user_id', auth.user.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits,subscription_expires_at,purchased_expires_at')
      .eq('user_id', auth.user.id)
      .maybeSingle(),
    getH3LiveEntitlement(db, auth.user.id)
  ]);

  if (activeResult.error || onAirResult.error) {
    console.error('[h3-live/feed] query error:', activeResult.error?.message || onAirResult.error?.message);
    return res.status(500).json({ ok: false, error: 'feed_lookup_failed' });
  }

  const activeJob = sanitizeJob(activeResult.data);
  const onAir = sanitizeJob(onAirResult.data);

  // Eligibility hint. Fail OPEN: if the plan lookup errored or the balance row
  // could not be read, do NOT pre-block the button (planAllowed:true /
  // hasEnoughCredits:true) and let start.js return the real error. Only a
  // definite "plan not eligible / expired" (entitlement.ok && !allowed) or a
  // definite shortfall pre-disables it.
  if (balanceResult.error) {
    console.error('[h3-live/feed] balance read error:', balanceResult.error.message);
  }
  const balance = balanceResult.error ? null : effectiveBalance(balanceResult.data);
  const planAllowed = entitlement && entitlement.ok ? Boolean(entitlement.allowed) : true;
  const eligibility = {
    planAllowed,
    creditCost: CREDIT_COST,
    balance,
    hasEnoughCredits: balance == null ? true : balance >= CREDIT_COST
  };

  const etagBasis = JSON.stringify({
    a: activeResult.data ? [activeResult.data.id, activeResult.data.status, activeResult.data.updated_at] : null,
    o: onAirResult.data ? [onAirResult.data.id, onAirResult.data.completed_at] : null,
    e: [planAllowed, balance]
  });
  const etag = 'W/"' + crypto.createHash('sha1').update(etagBasis).digest('hex') + '"';

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', etag);

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }

  return res.status(200).json({
    ok: true,
    activeJob,
    onAir,
    eligibility,
    serverTime: new Date().toISOString(),
    nextPollAfterMs: FEED_POLL_MS
  });
};
