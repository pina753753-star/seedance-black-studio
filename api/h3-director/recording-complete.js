'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, isUuid } = require('../_lib/h3-director-store.js');
const { RECORDING_BUCKET, RECORDING_MIME_TYPES } = require('../_lib/h3-director-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const sessionId = String(jsonBody(req).sessionId || '').trim();
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
  const db = auth.supabase;
  const { data: session, error } = await db.from('h3_director_sessions')
    .select('id,user_id,recording_status,recording_object_path,recording_mime_type,recording_size_bytes')
    .eq('id', sessionId).eq('user_id', auth.user.id).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: 'session_lookup_failed' });
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });
  if (session.recording_status === 'ready') return res.status(200).json({ ok: true, ready: true, replay: true });
  if (session.recording_status !== 'uploading' || !session.recording_object_path) {
    return res.status(409).json({ ok: false, error: 'recording_not_uploading' });
  }

  const slash = session.recording_object_path.lastIndexOf('/');
  const folder = session.recording_object_path.slice(0, slash);
  const filename = session.recording_object_path.slice(slash + 1);
  const { data: files, error: listError } = await db.storage.from(RECORDING_BUCKET)
    .list(folder, { limit: 10, search: filename });
  if (listError) return res.status(503).json({ ok: false, error: 'recording_verify_unavailable' });
  const file = (files || []).find((item) => item.name === filename);
  const storedSize = Number(file?.metadata?.size);
  const storedMime = String(file?.metadata?.mimetype || '').split(';')[0].toLowerCase();
  if (!file || !Number.isFinite(storedSize) || storedSize !== Number(session.recording_size_bytes)
      || !RECORDING_MIME_TYPES.includes(storedMime) || storedMime !== session.recording_mime_type) {
    return res.status(409).json({ ok: false, error: 'recording_verification_failed' });
  }

  const now = new Date().toISOString();
  const { data: rows, error: updateError } = await db.from('h3_director_sessions').update({
    recording_status: 'ready', recorded_at: now, updated_at: now
  }).eq('id', sessionId).eq('user_id', auth.user.id).eq('recording_status', 'uploading').select('id');
  if (updateError || !Array.isArray(rows) || rows.length !== 1) {
    const { data: latest } = await db.from('h3_director_sessions').select('recording_status')
      .eq('id', sessionId).eq('user_id', auth.user.id).maybeSingle();
    if (latest?.recording_status === 'ready') return res.status(200).json({ ok: true, ready: true, replay: true });
    return res.status(500).json({ ok: false, error: 'recording_finalize_failed' });
  }
  return res.status(200).json({ ok: true, ready: true });
};
