'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { isUuid } = require('../_lib/h3-director-store.js');
const { RECORDING_BUCKET } = require('../_lib/h3-director-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const sessionId = String(req.query?.sessionId || '').trim();
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
  const { data: session, error } = await auth.supabase.from('h3_director_sessions')
    .select('recording_status,recording_object_path,recording_mime_type').eq('id', sessionId).eq('user_id', auth.user.id).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: 'session_lookup_failed' });
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });
  if (session.recording_status !== 'ready' || !session.recording_object_path) {
    return res.status(409).json({ ok: false, error: 'recording_not_ready' });
  }
  const { data, error: signError } = await auth.supabase.storage.from(RECORDING_BUCKET)
    .createSignedUrl(session.recording_object_path, 3600);
  if (signError || !data?.signedUrl) return res.status(503).json({ ok: false, error: 'recording_url_unavailable' });
  return res.status(200).json({
    ok: true,
    url: data.signedUrl,
    contentType: session.recording_mime_type,
    filename: `h3-director-${sessionId}.${session.recording_mime_type === 'video/mp4' ? 'mp4' : 'webm'}`,
    expiresIn: 3600
  });
};
