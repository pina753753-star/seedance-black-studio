'use strict';

// GET /api/h3-live/feed
//
// Lightweight projection for the H3 Max screen:
//   - activeJob:   the caller's sole queued/submitting/processing job (if any)
//   - onAir:       the caller's most recently completed job (if any)
//   - eligibility: { planAllowed, creditCost, balance, hasEnoughCredits }
// Database read only; never calls fal.ai and never writes a balance.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { serviceClient, sanitizeJob } = require('../_lib/h3-live-store.js');
const { getH3LiveEntitlement } = require('../_lib/h3-live-entitlement.js');
const { FEED_POLL_MS, currentCreditCost } = require('../_lib/h3-live-config.js');

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

  if (balanceResult.error) {
    console.error('[h3-live/feed] balance read error:', balanceResult.error.message);
  }
  const balance = balanceResult.error ? null : effectiveBalance(balanceResult.data);
  const planAllowed = entitlement && entitlement.ok ? Boolean(entitlement.allowed) : true;
  const creditCost = currentCreditCost();
  const eligibility = {
    planAllowed,
    creditCost,
    balance,
    hasEnoughCredits: balance == null ? true : balance >= creditCost
  };

  const etagBasis = JSON.stringify({
    a: activeResult.data ? [activeResult.data.id, activeResult.data.status, activeResult.data.updated_at] : null,
    o: onAirResult.data ? [onAirResult.data.id, onAirResult.data.completed_at] : null,
    e: [planAllowed, balance, creditCost]
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
