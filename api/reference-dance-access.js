'use strict';

const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { authorizeReferenceDanceAdmin, klingDance } = require('./_lib/reference-dance.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    const allowed = access.ok === true;
    // The Kling rate is exposed only to the verified admin so the screen shows the
    // server's number. creditsPerSecond stays null while the price is undecided.
    return res.status(200).json({
      ok: true,
      allowed,
      ...(allowed ? {
        klingDance: {
          method: klingDance.KLING_DANCE_METHOD,
          creditsPerSecond: klingDance.getKlingDanceCreditsPerSecond(),
          minSeconds: klingDance.KLING_DANCE_MIN_SECONDS,
          maxSeconds: klingDance.KLING_DANCE_MAX_SECONDS
        }
      } : {})
    });
  } catch (error) {
    console.error('[reference-dance-access] failed', error?.message || String(error));
    return res.status(503).json({ ok: false, allowed: false, error: 'access_check_failed' });
  }
};

