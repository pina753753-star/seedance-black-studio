'use strict';

const { randomUUID } = require('node:crypto');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const {
  REFERENCE_AUDIO_BUCKET,
  MAX_REFERENCE_AUDIO_BYTES
} = require('./_lib/reference-audio.js');

const ACCEPTED_CLIENT_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const contentType = String(body.contentType || '').toLowerCase();
    const byteSize = Number(body.byteSize || 0);

    if (!ACCEPTED_CLIENT_MIME_TYPES.has(contentType)) {
      return res.status(415).json({ ok: false, error: 'unsupported_audio_type', message: 'MP3形式の音源を選択してください。' });
    }
    if (!Number.isFinite(byteSize) || byteSize <= 0 || byteSize > MAX_REFERENCE_AUDIO_BYTES) {
      return res.status(413).json({ ok: false, error: 'audio_size_limit', message: '音源は15MB以下にしてください。' });
    }

    const path = `users/${auth.user.id}/${Date.now()}-${randomUUID()}.mp3`;
    const { data, error } = await auth.supabase.storage
      .from(REFERENCE_AUDIO_BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data?.token) {
      return res.status(500).json({ ok: false, error: 'audio_upload_url_failed', message: '音源のアップロードを開始できませんでした。' });
    }

    return res.status(200).json({
      ok: true,
      bucket: REFERENCE_AUDIO_BUCKET,
      path: data.path || path,
      token: data.token,
      contentType: 'audio/mpeg',
      maxBytes: MAX_REFERENCE_AUDIO_BYTES
    });
  } catch (error) {
    console.error('[reference-audio-upload-url] failed', error?.message || String(error));
    return res.status(500).json({
      ok: false,
      error: 'audio_upload_url_failed',
      message: '音源のアップロードを開始できませんでした。'
    });
  }
};
