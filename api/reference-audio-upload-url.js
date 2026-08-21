'use strict';

const { randomUUID } = require('node:crypto');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const {
  REFERENCE_AUDIO_BUCKET,
  MAX_REFERENCE_AUDIO_BYTES,
  REFERENCE_AUDIO_RETENTION_MS,
  REFERENCE_AUDIO_REGISTRY_TABLE
} = require('./_lib/reference-audio.js');
const { getSeedance25Entitlement } = require('./_lib/video-plan-entitlements.js');

const ACCEPTED_CLIENT_MIME_TYPES = new Set(['audio/mpeg', 'audio/mp3']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    const entitlement = await getSeedance25Entitlement(auth.supabase, auth.user.id);
    if (!entitlement.ok) {
      return res.status(503).json({
        ok: false,
        error: 'plan_check_unavailable',
        message: '現在プランを確認できません。しばらくしてからもう一度お試しください。'
      });
    }
    if (!entitlement.allowed) {
      return res.status(403).json({
        ok: false,
        error: 'seedance_25_plan_required',
        message: '曲アップロードはPremium以上で利用できます。',
        redirect: '/pricing.html#monthly'
      });
    }

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

    // Track every issued object path so uploads abandoned by a closed browser
    // can still be removed through the Storage API after the signed URL is no
    // longer needed. The registry is service-role only; clients never write it.
    const expiresAt = new Date(Date.now() + REFERENCE_AUDIO_RETENTION_MS).toISOString();
    const { error: registryError } = await auth.supabase
      .from(REFERENCE_AUDIO_REGISTRY_TABLE)
      .insert({ user_id: auth.user.id, path: data.path || path, expires_at: expiresAt });
    if (registryError) {
      console.error('[reference-audio-upload-url] registry insert failed', registryError.message);
      return res.status(500).json({
        ok: false,
        error: 'audio_upload_tracking_failed',
        message: '音源の自動削除を設定できなかったため、アップロードを開始しませんでした。'
      });
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
