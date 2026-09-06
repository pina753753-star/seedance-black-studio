'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const {
  jsonBody, isUuid, publicSession, checkDirectorEnabled, getDirectorEntitlement
} = require('../_lib/h3-director-store.js');
const { heartbeatDirectorSession } = require('../_lib/h3-director-fal.js');
const { ALLOWED_PLANS } = require('../_lib/h3-director-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const sessionId = String(jsonBody(req).sessionId || '').trim();
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
  const db = auth.supabase;
  const { data: session, error } = await db.from('h3_director_sessions').select('*')
    .eq('id', sessionId).eq('user_id', auth.user.id).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: 'session_lookup_failed' });
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });
  if (!['connecting', 'live'].includes(session.status) || !session.provider_session_id) {
    return res.status(409).json({ ok: false, error: 'session_not_live', session: publicSession(session) });
  }

  const [control, entitlement] = await Promise.all([
    checkDirectorEnabled(db),
    getDirectorEntitlement(db, auth.user.id, ALLOWED_PLANS)
  ]);
  if (!control.ok || !entitlement.ok || !entitlement.allowed || entitlement.accountStatus !== 'active') {
    const ended = new Date().toISOString();
    await db.from('h3_director_sessions').update({
      status: 'completed', ended_at: ended, finished_at: ended,
      error_code: entitlement.accountStatus !== 'active' ? 'account_restricted' : 'access_revoked',
      updated_at: ended
    }).eq('id', sessionId).in('status', ['connecting', 'live']);
    return res.status(403).json({ ok: false, error: entitlement.accountStatus !== 'active' ? 'account_restricted' : 'access_revoked' });
  }

  const expiresMs = Date.parse(String(session.expires_at || ''));
  const now = new Date();
  if (!Number.isFinite(expiresMs) || now.getTime() >= expiresMs) {
    const ended = now.toISOString();
    const { data: rows } = await db.from('h3_director_sessions').update({
      status: 'completed', ended_at: ended, finished_at: ended, updated_at: ended
    }).eq('id', sessionId).in('status', ['connecting', 'live']).select('*');
    return res.status(200).json({ ok: true, alive: false, expired: true, session: publicSession(rows?.[0] || session) });
  }

  const upstream = await heartbeatDirectorSession(session.provider_session_id);
  if (!upstream.ok) {
    return res.status(502).json({ ok: false, error: 'heartbeat_failed', retryable: true });
  }
  if (!upstream.alive) {
    const ended = now.toISOString();
    const { data: rows } = await db.from('h3_director_sessions').update({
      status: 'completed', ended_at: ended, finished_at: ended, updated_at: ended
    }).eq('id', sessionId).in('status', ['connecting', 'live']).select('*');
    return res.status(200).json({ ok: true, alive: false, session: publicSession(rows?.[0] || session) });
  }

  const { data: rows, error: updateError } = await db.from('h3_director_sessions').update({
    status: 'live',
    last_heartbeat_at: now.toISOString(),
    heartbeat_count: Number(session.heartbeat_count || 0) + 1,
    updated_at: now.toISOString()
  }).eq('id', sessionId).in('status', ['connecting', 'live']).select('*');
  if (updateError) return res.status(500).json({ ok: false, error: 'heartbeat_state_failed' });

  return res.status(200).json({
    ok: true,
    alive: true,
    remainingSeconds: Math.max(0, Math.ceil((expiresMs - now.getTime()) / 1000)),
    session: publicSession(rows?.[0] || session)
  });
};
