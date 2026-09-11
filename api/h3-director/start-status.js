'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { isUuid, publicSession } = require('../_lib/h3-director-store.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const idempotencyKey = String(req.query?.idempotencyKey || '').trim();
  if (!isUuid(idempotencyKey)) return res.status(400).json({ ok: false, error: 'invalid_idempotency_key' });

  const { data, error } = await auth.supabase.from('h3_director_sessions').select('*')
    .eq('user_id', auth.user.id).eq('idempotency_key', idempotencyKey).maybeSingle();
  if (error) return res.status(503).json({ ok: false, error: 'session_lookup_failed' });
  if (!data) return res.status(404).json({ ok: false, error: 'session_not_found' });

  const charged = Boolean(data.charged_at);
  const refunded = Boolean(data.refunded_at);
  const resolved = data.status === 'completed' || (data.status === 'failed' && (!charged || refunded));
  return res.status(200).json({
    ok: true,
    resolved,
    requiresReview: data.status === 'needs_review' || (charged && !data.provider_session_id && !resolved),
    charged,
    refunded,
    session: publicSession(data)
  });
};
