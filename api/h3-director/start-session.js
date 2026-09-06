'use strict';

const crypto = require('crypto');
const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const {
  jsonBody, isUuid, checkDirectorEnabled, getDirectorEntitlement, publicSession
} = require('../_lib/h3-director-store.js');
const { moderateDirectorPrompt } = require('../_lib/h3-director-moderation.js');
const { createDirectorSession } = require('../_lib/h3-director-fal.js');
const {
  ALLOWED_PLANS, CREDIT_COST, DURATION_SECONDS, RESOLUTION,
  ALLOWED_ASPECT_RATIOS,
  PROMPT_MAX_CHARS, requireDirectorConfig, openaiApiKey
} = require('../_lib/h3-director-config.js');

function idempotencyKey(req) {
  return String(req?.headers?.['idempotency-key'] || req?.headers?.['Idempotency-Key'] || '').trim();
}

async function fetchSession(db, sessionId) {
  const { data, error } = await db.from('h3_director_sessions').select('*').eq('id', sessionId).maybeSingle();
  if (error) console.error('[h3-director/start] session lookup failed:', error.message);
  return data || null;
}

async function refund(db, sessionId, code, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, error } = await db.rpc('refund_h3_director_session_atomic', {
        p_session_id: sessionId,
        p_error_code: code,
        p_error_message: message
      });
      if (!error && ['refunded', 'already_refunded', 'no_charge_found'].includes(data?.code)) return data;
    } catch (_) {}
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
  }
  return null;
}

async function markNeedsReview(db, sessionId, code, message) {
  const now = new Date().toISOString();
  const { error } = await db.from('h3_director_sessions').update({
    status: 'needs_review',
    error_code: String(code || 'provider_state_unknown').slice(0, 100),
    error_message: String(message || '').slice(0, 1000),
    ended_at: now,
    finished_at: now,
    updated_at: now
  }).eq('id', sessionId).in('status', ['reserved', 'connecting']);
  if (error) console.error('[h3-director/start] needs-review update failed:', error.message);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const db = auth.supabase;

  const control = await checkDirectorEnabled(db);
  if (!control.ok) {
    return res.status(503).json({ ok: false, error: 'h3_director_disabled', message: 'H3 Director は現在停止中です。' });
  }

  const idem = idempotencyKey(req);
  const body = jsonBody(req);
  const prompt = String(body.prompt || '').trim();
  const sdp = String(body.sdp || '');
  const type = String(body.type || '');
  const aspectRatio = String(body.aspectRatio || '').trim();

  if (!isUuid(idem)) return res.status(400).json({ ok: false, error: 'invalid_idempotency_key' });
  if (prompt.length < 1 || prompt.length > PROMPT_MAX_CHARS) {
    return res.status(400).json({ ok: false, error: 'invalid_prompt', message: `指示は1〜${PROMPT_MAX_CHARS}文字で入力してください。` });
  }
  if (!ALLOWED_ASPECT_RATIOS.includes(aspectRatio)) {
    return res.status(400).json({ ok: false, error: 'invalid_aspect_ratio' });
  }
  if (type !== 'offer' || sdp.length < 10 || sdp.length > 100000 || !sdp.startsWith('v=0')) {
    return res.status(400).json({ ok: false, error: 'invalid_webrtc_offer' });
  }

  const entitlement = await getDirectorEntitlement(db, auth.user.id, ALLOWED_PLANS);
  if (!entitlement.ok) return res.status(503).json({ ok: false, error: 'entitlement_unavailable' });
  if (!entitlement.allowed) return res.status(403).json({ ok: false, error: 'eligible_plan_required', redirect: '/pricing.html#monthly' });
  if (entitlement.accountStatus !== 'active') return res.status(403).json({ ok: false, error: 'account_restricted' });
  if (entitlement.balance < CREDIT_COST) {
    return res.status(402).json({ ok: false, error: 'insufficient_credits', required: CREDIT_COST, balance: entitlement.balance });
  }
  if (!openaiApiKey()) return res.status(503).json({ ok: false, error: 'content_safety_unavailable' });
  const providerConfig = requireDirectorConfig();
  if (!providerConfig.ok) return res.status(503).json({ ok: false, error: 'provider_unavailable' });

  const moderation = await moderateDirectorPrompt(prompt);
  if (!moderation.ok) return res.status(503).json({ ok: false, error: 'content_safety_unavailable' });
  if (!moderation.allow) return res.status(422).json({ ok: false, error: 'content_not_allowed' });

  const offerFingerprint = crypto.createHash('sha256').update(sdp).digest('hex');
  const { data: reserveRows, error: reserveError } = await db.rpc('reserve_h3_director_session_atomic', {
    p_user_id: auth.user.id,
    p_idempotency_key: idem,
    p_initial_prompt: prompt,
    p_offer_fingerprint: offerFingerprint,
    p_aspect_ratio: aspectRatio
  });
  if (reserveError) {
    console.error('[h3-director/start] reserve failed:', reserveError.message);
    return res.status(500).json({ ok: false, error: 'reservation_failed' });
  }
  const reserved = Array.isArray(reserveRows) ? reserveRows[0] : reserveRows;
  if (!reserved?.session_id) {
    const status = reserved?.code === 'account_restricted' ? 403 : 409;
    return res.status(status).json({ ok: false, error: reserved?.code || 'reservation_rejected' });
  }

  let session = await fetchSession(db, reserved.session_id);
  if (!session) return res.status(500).json({ ok: false, error: 'session_state_unavailable' });
  if (reserved.code === 'idempotency_conflict') return res.status(409).json({ ok: false, error: 'idempotency_conflict' });

  // Exact replay of a response whose delivery failed: same offer fingerprint,
  // so the saved answer remains valid and no second paid session is created.
  if (session.provider_session_id && session.provider_answer_sdp && ['connecting', 'live'].includes(session.status)) {
    return res.status(200).json({
      ok: true,
      session: publicSession(session),
      answer: { sdp: session.provider_answer_sdp, type: 'answer' },
      replay: true
    });
  }
  if (session.status !== 'reserved') {
    return res.status(409).json({ ok: false, error: 'session_not_resumable', session: publicSession(session) });
  }
  if (session.charged_at) {
    await markNeedsReview(db, session.id, 'charged_without_provider_state', 'A charged start attempt cannot be safely replayed.');
    return res.status(409).json({ ok: false, error: 'session_state_requires_review' });
  }

  // Claim this start before charging. Concurrent delivery of the same HTTP
  // request must never create two WMA sessions. A loser does not change the
  // row because the winning request may currently be calling fal.
  const connectingAt = new Date().toISOString();
  const { data: connectingRows, error: connectingError } = await db.from('h3_director_sessions').update({
    status: 'connecting', updated_at: connectingAt
  }).eq('id', session.id).eq('status', 'reserved').is('charged_at', null).select('id');
  if (connectingError) {
    console.error('[h3-director/start] connecting claim failed:', connectingError.message);
    return res.status(500).json({ ok: false, error: 'session_state_unavailable' });
  }
  if (!Array.isArray(connectingRows) || connectingRows.length !== 1) {
    session = await fetchSession(db, session.id);
    if (session?.provider_session_id && session?.provider_answer_sdp && ['connecting', 'live'].includes(session.status)) {
      return res.status(200).json({
        ok: true,
        session: publicSession(session),
        answer: { sdp: session.provider_answer_sdp, type: 'answer' },
        replay: true
      });
    }
    return res.status(409).json({ ok: false, error: 'session_start_in_progress' });
  }

  const { data: charged, error: chargeError } = await db.rpc('deduct_h3_director_credits_atomic', {
    p_session_id: session.id,
    p_user_id: auth.user.id
  });
  if (chargeError) {
    console.error('[h3-director/start] credit deduction failed:', chargeError.message);
    return res.status(500).json({ ok: false, error: 'credit_state_unavailable' });
  }
  if (!charged?.ok) {
    const status = charged?.code === 'insufficient_credits' ? 402 : charged?.code === 'account_restricted' ? 403 : 409;
    return res.status(status).json({ ok: false, error: charged?.code || 'credit_deduction_rejected', required: CREDIT_COST });
  }

  // Close the narrow charge->provider race as far as an external API boundary
  // permits. The DB RPC also checks these conditions inside the charge txn.
  const [controlAgain, entitlementAgain] = await Promise.all([
    checkDirectorEnabled(db),
    getDirectorEntitlement(db, auth.user.id, ALLOWED_PLANS)
  ]);
  if (!controlAgain.ok || !entitlementAgain.ok || !entitlementAgain.allowed || entitlementAgain.accountStatus !== 'active') {
    const refundResult = await refund(db, session.id, 'pre_provider_recheck_failed', 'Access changed before provider session creation.');
    if (!refundResult) return res.status(500).json({ ok: false, error: 'refund_unconfirmed' });
    return res.status(409).json({ ok: false, error: 'access_changed', refunded: refundResult.refunded === true });
  }

  const upstream = await createDirectorSession({ sdp, type: 'offer' });
  if (!upstream.ok) {
    if (upstream.ambiguous) {
      await markNeedsReview(db, session.id, 'provider_start_ambiguous', upstream.error || `HTTP ${upstream.status}`);
      return res.status(502).json({ ok: false, error: 'provider_start_ambiguous', message: '接続結果を確認できません。自動再実行は行いません。' });
    }
    const refundResult = await refund(db, session.id, 'provider_rejected', `fal WMA HTTP ${upstream.status}`);
    if (!refundResult) return res.status(500).json({ ok: false, error: 'refund_unconfirmed' });
    return res.status(502).json({ ok: false, error: 'provider_rejected', refunded: refundResult.refunded === true });
  }

  const connectedAt = new Date();
  const expiresAt = new Date(connectedAt.getTime() + DURATION_SECONDS * 1000);
  const { data: persistedRows, error: persistError } = await db.from('h3_director_sessions').update({
    provider_session_id: upstream.sessionId,
    provider_answer_sdp: upstream.sdp,
    connected_at: connectedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    updated_at: connectedAt.toISOString()
  }).eq('id', session.id).eq('status', 'connecting').is('provider_session_id', null).select('*');

  if (persistError || !Array.isArray(persistedRows) || persistedRows.length !== 1) {
    console.error('[h3-director/start] provider state persist failed:', persistError?.message || 'claim lost');
    await markNeedsReview(db, session.id, 'provider_state_unconfirmed', persistError?.message || 'provider state claim lost');
    return res.status(500).json({ ok: false, error: 'session_state_requires_review' });
  }
  session = persistedRows[0];

  return res.status(200).json({
    ok: true,
    session: publicSession(session),
    answer: { sdp: upstream.sdp, type: upstream.type },
    fixed: { durationSeconds: DURATION_SECONDS, resolution: RESOLUTION, aspectRatio: session.aspect_ratio, creditCost: CREDIT_COST }
  });
};
