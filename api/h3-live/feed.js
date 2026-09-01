'use strict';

// GET /api/h3-live/feed
//
// Lightweight projection for the broadcast-style screen in h3-live.html:
//   - activeJob: the caller's sole queued/submitting/processing job (if any)
//   - onAir:     the caller's most recently completed job (if any)
// Database read only; never calls fal.ai. Sends a weak ETag so the 1s client
// poll costs almost nothing when nothing changed.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { serviceClient, sanitizeJob } = require('../_lib/h3-live-store.js');
const { FEED_POLL_MS } = require('../_lib/h3-live-config.js');

const crypto = require('crypto');

const ACTIVE = ['queued', 'submitting', 'processing'];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'GET only.' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  const [activeResult, onAirResult] = await Promise.all([
    db.from('h3_live_jobs')
      .select('*')
      .eq('user_id', auth.user.id)
      .in('status', ACTIVE)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('h3_live_jobs')
      .select('*')
      .eq('user_id', auth.user.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  if (activeResult.error || onAirResult.error) {
    console.error('[h3-live/feed] query error:', activeResult.error?.message || onAirResult.error?.message);
    return res.status(500).json({ ok: false, error: 'feed_lookup_failed' });
  }

  const activeJob = sanitizeJob(activeResult.data);
  const onAir = sanitizeJob(onAirResult.data);

  const etagBasis = JSON.stringify({
    a: activeResult.data ? [activeResult.data.id, activeResult.data.status, activeResult.data.updated_at] : null,
    o: onAirResult.data ? [onAirResult.data.id, onAirResult.data.completed_at] : null
  });
  const etag = 'W/"' + crypto.createHash('sha1').update(etagBasis).digest('hex') + '"';

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', etag);

  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return res.status(304).end();
  }

  return res.status(200).json({
    ok: true,
    activeJob,
    onAir,
    serverTime: new Date().toISOString(),
    nextPollAfterMs: FEED_POLL_MS
  });
};
