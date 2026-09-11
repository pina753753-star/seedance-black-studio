'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, isUuid } = require('../_lib/h3-director-store.js');
const {
  RECORDING_BUCKET, RECORDING_MAX_BYTES, RECORDING_MIME_TYPES
} = require('../_lib/h3-director-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const body = jsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const mime = String(body.contentType || '').split(';')[0].trim().toLowerCase();
  const size = Number(body.byteSize || 0);
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
  if (!RECORDING_MIME_TYPES.includes(mime)) return res.status(415).json({ ok: false, error: 'unsupported_recording_type' });
  if (!Number.isSafeInteger(size) || size < 1 || size > RECORDING_MAX_BYTES) {
    return res.status(size > RECORDING_MAX_BYTES ? 413 : 400).json({ ok: false, error: 'invalid_recording_size', maxBytes: RECORDING_MAX_BYTES });
  }

  const db = auth.supabase;
  const { data: session, error } = await db.from('h3_director_sessions').select('*')
    .eq('id', sessionId).eq('user_id', auth.user.id).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: 'session_lookup_failed' });
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });
  if (session.status !== 'completed' || !session.charged_at || !session.provider_session_id) {
    return res.status(409).json({ ok: false, error: 'session_not_recordable' });
  }
  if (session.recording_status === 'ready') {
    return res.status(409).json({ ok: false, error: 'recording_already_saved' });
  }

  const extension = mime === 'video/mp4' ? 'mp4' : 'webm';
  const path = `${auth.user.id}/${sessionId}.${extension}`;
  const { data: claimRows, error: claimError } = await db.from('h3_director_sessions').update({
    recording_status: 'uploading', recording_object_path: path,
    recording_mime_type: mime, recording_size_bytes: size, recorded_at: null,
    updated_at: new Date().toISOString()
  }).eq('id', sessionId).eq('user_id', auth.user.id).neq('recording_status', 'ready').select('id');
  if (claimError || !Array.isArray(claimRows) || claimRows.length !== 1) {
    return res.status(409).json({ ok: false, error: 'recording_state_conflict' });
  }

  // A verified owner may retry the same session recording after a network or
  // finalize failure. The object path is fixed to that user and session, so an
  // upsert replaces only the caller's own incomplete/previous upload.
  const { data: signed, error: signedError } = await db.storage.from(RECORDING_BUCKET)
    .createSignedUploadUrl(path, { upsert: true });
  if (signedError || !signed?.token) {
    await db.from('h3_director_sessions').update({ recording_status: 'failed', recorded_at: null, updated_at: new Date().toISOString() })
      .eq('id', sessionId).eq('user_id', auth.user.id);
    return res.status(503).json({ ok: false, error: 'recording_upload_unavailable' });
  }
  return res.status(200).json({ ok: true, bucket: RECORDING_BUCKET, path, token: signed.token, maxBytes: RECORDING_MAX_BYTES });
};
