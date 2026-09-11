'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, isUuid, publicSession } = require('../_lib/h3-director-store.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const sessionId = String(jsonBody(req).sessionId || '').trim();
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });

  const now = new Date().toISOString();
  const { data: rows, error } = await auth.supabase.from('h3_director_sessions').update({
    status: 'completed', ended_at: now, finished_at: now, updated_at: now
  }).eq('id', sessionId).eq('user_id', auth.user.id).in('status', ['connecting', 'live']).select('*');
  if (error) return res.status(500).json({ ok: false, error: 'end_state_failed' });
  if (Array.isArray(rows) && rows.length === 1) {
    return res.status(200).json({ ok: true, session: publicSession(rows[0]) });
  }
  const { data: existing } = await auth.supabase.from('h3_director_sessions').select('*')
    .eq('id', sessionId).eq('user_id', auth.user.id).maybeSingle();
  if (!existing) return res.status(404).json({ ok: false, error: 'session_not_found' });
  return res.status(200).json({ ok: true, session: publicSession(existing), replay: true });
};
