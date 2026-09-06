'use strict';

// Manual/cron-secret recovery endpoint. Mirrors api/h3-live/reconcile.js and
// is intentionally not registered as an automatic cron: ambiguous fal starts
// require an operator decision before force release.

const { serviceClient, jsonBody, isUuid } = require('../_lib/h3-director-store.js');
const { STALE_MINUTES, listStuck, releaseSession } = require('../_lib/h3-director-reconcile.js');

const CRON_SECRET = String(process.env.CRON_SECRET || '');

function authenticate(req) {
  if (!CRON_SECRET) return false;
  const auth = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  return auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === CRON_SECRET;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authenticate(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  if (req.method === 'GET') {
    const result = await listStuck(db);
    if (!result.ok) return res.status(503).json({ ok: false, error: 'reconcile_list_failed' });
    return res.status(200).json({ ok: true, staleMinutes: STALE_MINUTES, count: result.alerts.length, alerts: result.alerts });
  }

  if (req.method === 'POST') {
    const body = jsonBody(req);
    const sessionId = String(body.sessionId || '').trim();
    if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
    const result = await releaseSession(db, sessionId, { force: body.force === true });
    return res.status(result.status).json(result.body);
  }

  return res.status(405).json({ ok: false, error: 'method_not_allowed' });
};

module.exports._test = { authenticate };
