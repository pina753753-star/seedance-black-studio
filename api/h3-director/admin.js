'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, isUuid } = require('../_lib/h3-director-store.js');
const { STALE_MINUTES, listStuck, releaseSession } = require('../_lib/h3-director-reconcile.js');

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'hinaran53@gmail.com').trim().toLowerCase();

async function authorize(auth) {
  const email = String(auth?.user?.email || '').trim().toLowerCase();
  if (!auth?.user?.id || email !== ADMIN_EMAIL) return false;
  const { data, error } = await auth.supabase.from('profiles').select('email,role')
    .eq('id', auth.user.id).maybeSingle();
  return !error && data?.role === 'admin' && String(data.email || '').trim().toLowerCase() === ADMIN_EMAIL;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  if (!(await authorize(auth))) return res.status(403).json({ ok: false, error: 'admin_required' });
  const body = jsonBody(req);
  const action = String(body.action || '');
  const db = auth.supabase;

  if (action === 'getControl') {
    const { data, error } = await db.from('h3_director_controls').select('enabled,note,updated_at')
      .eq('control_key', 'h3_director').maybeSingle();
    if (error) return res.status(503).json({ ok: false, error: 'control_read_failed' });
    return res.status(200).json({ ok: true, enabled: data?.enabled === true, note: data?.note || null, updatedAt: data?.updated_at || null, missing: !data });
  }

  if (action === 'setControl') {
    if (typeof body.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'invalid_enabled' });
    const extra = String(body.note || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const note = `admin ${auth.user.id}: ${body.enabled ? 'enabled' : 'disabled'}${extra ? ` — ${extra}` : ''}`;
    const now = new Date().toISOString();
    const { data, error } = await db.from('h3_director_controls').update({ enabled: body.enabled, note, updated_at: now })
      .eq('control_key', 'h3_director').select('enabled,note,updated_at');
    if (error) return res.status(503).json({ ok: false, error: 'control_write_failed' });
    if (!Array.isArray(data) || data.length !== 1) return res.status(409).json({ ok: false, error: 'control_row_missing' });
    return res.status(200).json({ ok: true, enabled: data[0].enabled, note: data[0].note, updatedAt: data[0].updated_at });
  }

  if (action === 'listAlerts') {
    const result = await listStuck(db);
    if (!result.ok) return res.status(503).json({ ok: false, error: 'alerts_read_failed' });
    return res.status(200).json({ ok: true, staleMinutes: STALE_MINUTES, alerts: result.alerts });
  }

  if (action === 'reconcileRelease') {
    const sessionId = String(body.sessionId || '').trim();
    if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
    const result = await releaseSession(db, sessionId, { force: body.force === true });
    return res.status(result.status).json(result.body);
  }

  return res.status(400).json({ ok: false, error: 'invalid_action' });
};
