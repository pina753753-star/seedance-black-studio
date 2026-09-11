'use strict';

// Director-specific adaptation of api/h3-live/reconcile.js:
// guarded status flip -> idempotent settlement -> settlement retry.
// A charged or provider-visible session always requires force=true because an
// operator must first verify fal.ai state. Uncharged/unsubmitted stale rows can
// be released without force.

const { CREDIT_COST } = require('./h3-director-config.js');

const STALE_MINUTES = 5;
const LIST_LIMIT = 100;
const ACTIVE = ['reserved', 'connecting', 'live'];
const REFUND_TERMINAL_CODES = ['refunded', 'already_refunded', 'no_charge_found'];

function staleCutoffIso(nowMs = Date.now()) {
  return new Date(nowMs - STALE_MINUTES * 60 * 1000).toISOString();
}

function publicAlert(row, reason) {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    reason,
    charged: Boolean(row.charged_at),
    refunded: Boolean(row.refunded_at),
    providerSessionId: row.provider_session_id || null,
    errorCode: row.error_code || null,
    forceRequired: Boolean(row.charged_at || row.provider_session_id || row.status === 'needs_review'),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    expiresAt: row.expires_at || null
  };
}

async function listStuck(db, nowMs = Date.now()) {
  const cutoff = staleCutoffIso(nowMs);
  const nowIso = new Date(nowMs).toISOString();
  const columns = 'id,user_id,status,charged_at,refunded_at,provider_session_id,error_code,created_at,updated_at,expires_at';
  const [untrackable, expiredTracked, review, settleRetry] = await Promise.all([
    db.from('h3_director_sessions').select(columns)
      .in('status', ['reserved', 'connecting']).is('provider_session_id', null)
      .lt('updated_at', cutoff).order('updated_at', { ascending: true }).limit(LIST_LIMIT),
    db.from('h3_director_sessions').select(columns)
      .in('status', ['connecting', 'live']).not('provider_session_id', 'is', null)
      .not('expires_at', 'is', null).lt('expires_at', nowIso)
      .order('expires_at', { ascending: true }).limit(LIST_LIMIT),
    db.from('h3_director_sessions').select(columns)
      .eq('status', 'needs_review').lt('updated_at', cutoff)
      .order('updated_at', { ascending: true }).limit(LIST_LIMIT),
    db.from('h3_director_sessions').select(columns)
      .eq('status', 'failed').eq('error_code', 'operator_reconcile_release')
      .not('charged_at', 'is', null).is('refunded_at', null)
      .order('updated_at', { ascending: true }).limit(LIST_LIMIT)
  ]);
  const failed = [untrackable, expiredTracked, review, settleRetry].find((r) => r.error);
  if (failed) return { ok: false, error: failed.error.message };

  const seen = new Set();
  const alerts = [];
  for (const [result, reason] of [
    [untrackable, 'untrackable_stale'],
    [expiredTracked, 'provider_session_expired'],
    [review, 'needs_review'],
    [settleRetry, 'settlement_retry']
  ]) {
    for (const row of result.data || []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      alerts.push(publicAlert(row, reason));
    }
  }
  return { ok: true, alerts };
}

async function settleReleasedSession(db, sessionId, extra = {}) {
  let settle;
  try {
    const { data, error } = await db.rpc('refund_h3_director_session_atomic', {
      p_session_id: sessionId,
      p_error_code: 'operator_reconcile_release',
      p_error_message: 'released by H3 Director reconciler'
    });
    settle = error ? { code: error.message } : data;
  } catch (error) {
    settle = { code: error?.message || String(error) };
  }

  if (!REFUND_TERMINAL_CODES.includes(settle?.code)) {
    console.error('[h3-director/reconcile] settlement unconfirmed. sessionId:', sessionId, 'code:', settle?.code);
    return {
      status: 503,
      body: { ok: false, error: 'settle_state_uncertain', sessionId, settleCode: settle?.code || null }
    };
  }

  const latest = await db.from('h3_director_sessions').select('*').eq('id', sessionId).maybeSingle();
  return {
    status: 200,
    body: {
      ok: true,
      released: true,
      settleCode: settle.code,
      creditRefundedNow: settle.code === 'refunded' ? CREDIT_COST : 0,
      alreadyRefunded: settle.code === 'already_refunded',
      ...extra,
      session: latest.data || null
    }
  };
}

async function releaseSession(db, sessionId, { force = false, nowMs = Date.now() } = {}) {
  const lookup = await db.from('h3_director_sessions').select('*').eq('id', sessionId).maybeSingle();
  if (lookup.error) return { status: 500, body: { ok: false, error: 'session_lookup_failed' } };
  const session = lookup.data;
  if (!session) return { status: 404, body: { ok: false, error: 'session_not_found' } };

  // Settle-retry after a prior guarded flip succeeded but the refund response
  // was lost or failed. refund_h3_director_session_atomic is idempotent.
  if (session.status === 'failed' && session.error_code === 'operator_reconcile_release') {
    return settleReleasedSession(db, sessionId, { retriedSettlement: true });
  }

  const review = session.status === 'needs_review';
  const active = ACTIVE.includes(session.status);
  if (!review && !active) {
    return { status: 409, body: { ok: false, error: 'session_not_releasable', status: session.status } };
  }

  if (active || review) {
    const stale = Date.parse(String(session.updated_at || '')) < Date.parse(staleCutoffIso(nowMs));
    const expiredTracked = active && Boolean(session.provider_session_id) &&
      Date.parse(String(session.expires_at || '')) < nowMs;
    if (!stale && !expiredTracked) {
      return { status: 409, body: { ok: false, error: 'session_not_stale', staleMinutes: STALE_MINUTES } };
    }
  }

  const forceRequired = Boolean(review || session.charged_at || session.provider_session_id);
  if (forceRequired && !force) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'force_required',
        message: 'fal.aiのセッション・利用額を確認後、force=trueで解放してください。',
        providerSessionId: session.provider_session_id || null,
        charged: Boolean(session.charged_at)
      }
    };
  }

  const nowIso = new Date(nowMs).toISOString();
  let claim = db.from('h3_director_sessions').update({
    status: 'failed',
    error_code: 'operator_reconcile_release',
    error_message: force ? 'force-released by H3 Director reconciler' : 'released by H3 Director reconciler',
    ended_at: session.ended_at || nowIso,
    failed_at: nowIso,
    finished_at: nowIso,
    updated_at: nowIso
  }).eq('id', sessionId);

  if (review) {
    claim = claim.eq('status', 'needs_review').lt('updated_at', staleCutoffIso(nowMs));
  } else {
    claim = claim.in('status', ACTIVE);
    if (session.provider_session_id) {
      claim = claim.eq('provider_session_id', session.provider_session_id)
        .not('expires_at', 'is', null).lt('expires_at', nowIso);
    } else {
      claim = claim.is('provider_session_id', null).lt('updated_at', staleCutoffIso(nowMs));
      if (!force) claim = claim.is('charged_at', null);
    }
  }

  const flipped = await claim.select('*');
  if (flipped.error) {
    console.error('[h3-director/reconcile] guarded flip failed:', flipped.error.message, 'sessionId:', sessionId);
    return { status: 503, body: { ok: false, error: 'reconcile_claim_failed' } };
  }
  if (!Array.isArray(flipped.data) || flipped.data.length !== 1) {
    return { status: 409, body: { ok: false, error: 'session_no_longer_stuck' } };
  }

  console.warn(
    '[h3-director/reconcile] operator release. sessionId:', sessionId,
    'force:', force,
    'charged:', Boolean(flipped.data[0].charged_at),
    'providerSessionId:', flipped.data[0].provider_session_id || null
  );
  return settleReleasedSession(db, sessionId, {
    forceApplied: force,
    providerSessionIdAtFlip: flipped.data[0].provider_session_id || null,
    chargedAtFlip: Boolean(flipped.data[0].charged_at)
  });
}

module.exports = {
  STALE_MINUTES,
  ACTIVE,
  listStuck,
  releaseSession,
  settleReleasedSession,
  staleCutoffIso
};
