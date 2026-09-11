'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { publicSession } = require('../_lib/h3-director-store.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const raw = Number.parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(20, raw)) : 10;
  const { data, error } = await auth.supabase.from('h3_director_sessions').select('*')
    .eq('user_id', auth.user.id).order('created_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ ok: false, error: 'history_lookup_failed' });
  return res.status(200).json({ ok: true, sessions: (data || []).map(publicSession) });
};
