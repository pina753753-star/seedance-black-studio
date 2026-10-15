'use strict';

const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { authorizeReferenceDanceAdmin } = require('./_lib/reference-dance.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    return res.status(200).json({ ok: true, allowed: access.ok === true });
  } catch (error) {
    console.error('[reference-dance-access] failed', error?.message || String(error));
    return res.status(503).json({ ok: false, allowed: false, error: 'access_check_failed' });
  }
};
