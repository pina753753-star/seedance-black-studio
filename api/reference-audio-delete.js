'use strict';

const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const {
  REFERENCE_AUDIO_BUCKET,
  REFERENCE_AUDIO_REGISTRY_TABLE,
  normalizeReferenceAudioPaths
} = require('./_lib/reference-audio.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const normalized = normalizeReferenceAudioPaths(body.path, auth.user.id);
    if (!normalized.ok || normalized.paths.length !== 1) {
      return res.status(400).json({
        ok: false,
        error: 'invalid_reference_audio',
        message: '削除する音源を確認できませんでした。'
      });
    }

    const path = normalized.paths[0];
    const { error: storageError } = await auth.supabase.storage
      .from(REFERENCE_AUDIO_BUCKET)
      .remove([path]);
    if (storageError) {
      return res.status(503).json({
        ok: false,
        error: 'reference_audio_delete_failed',
        message: '音源をすぐに削除できませんでした。自動削除でもう一度処理します。'
      });
    }

    const { error: registryError } = await auth.supabase
      .from(REFERENCE_AUDIO_REGISTRY_TABLE)
      .delete()
      .eq('user_id', auth.user.id)
      .eq('path', path);
    if (registryError) {
      console.warn('[reference-audio-delete] registry cleanup failed', registryError.message);
    }

    return res.status(200).json({ ok: true, deleted: true });
  } catch (error) {
    console.error('[reference-audio-delete] failed', error?.message || String(error));
    return res.status(500).json({
      ok: false,
      error: 'reference_audio_delete_failed',
      message: '音源を削除できませんでした。自動削除でもう一度処理します。'
    });
  }
};
