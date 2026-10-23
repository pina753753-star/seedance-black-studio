'use strict';

const { randomUUID } = require('node:crypto');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const {
  REFERENCE_DANCE_BUCKET,
  REFERENCE_DANCE_TABLE,
  MAX_REFERENCE_DANCE_BYTES,
  REFERENCE_DANCE_RETENTION_MS,
  REFERENCE_DANCE_MAX_PER_HOUR,
  REFERENCE_DANCE_MAX_PER_DAY,
  stagingPath,
  authorizeReferenceDanceAdmin
} = require('./_lib/reference-dance.js');

async function countSince(db, userId, iso) {
  const { count, error } = await db
    .from(REFERENCE_DANCE_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', iso);
  if (error) throw error;
  return Number(count || 0);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    if (!access.ok) return res.status(403).json({ ok: false, error: 'reference_dance_beta_forbidden' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const contentType = String(body.contentType || '').toLowerCase();
    const byteSize = Number(body.byteSize || 0);
    const filename = String(body.filename || '').trim().slice(0, 200);
    if (body.rightsConfirmed !== true) {
      return res.status(400).json({ ok: false, error: 'reference_video_rights_required', message: '使用権限と、実在人物のなりすましではないことを確認してください。' });
    }
    if (contentType !== 'video/mp4' && !filename.toLowerCase().endsWith('.mp4')) {
      return res.status(415).json({ ok: false, error: 'unsupported_video_type', message: 'MP4形式の動画を選択してください。' });
    }
    if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > MAX_REFERENCE_DANCE_BYTES) {
      return res.status(413).json({ ok: false, error: 'video_size_limit', message: '参考動画は50MB以下にしてください。' });
    }

    const now = Date.now();
    const [hourCount, dayCount] = await Promise.all([
      countSince(auth.supabase, auth.user.id, new Date(now - 60 * 60 * 1000).toISOString()),
      countSince(auth.supabase, auth.user.id, new Date(now - 24 * 60 * 60 * 1000).toISOString())
    ]);
    if (hourCount >= REFERENCE_DANCE_MAX_PER_HOUR || dayCount >= REFERENCE_DANCE_MAX_PER_DAY) {
      return res.status(429).json({
        ok: false,
        error: 'reference_video_upload_limit',
        message: '参考動画の確認回数が上限に達しました。時間を空けてからお試しください。'
      });
    }

    const assetId = randomUUID();
    const path = stagingPath(auth.user.id, assetId);
    const expiresAt = new Date(now + REFERENCE_DANCE_RETENTION_MS).toISOString();
    const { error: insertError } = await auth.supabase.from(REFERENCE_DANCE_TABLE).insert({
      id: assetId,
      user_id: auth.user.id,
      status: 'uploading',
      staging_path: path,
      original_filename: filename || null,
      rights_confirmed_at: new Date().toISOString(),
      declared_size_bytes: byteSize,
      expires_at: expiresAt
    });
    if (insertError) throw insertError;

    const { data, error: signedError } = await auth.supabase.storage
      .from(REFERENCE_DANCE_BUCKET)
      .createSignedUploadUrl(path);
    if (signedError || !data?.token) {
      await auth.supabase.from(REFERENCE_DANCE_TABLE)
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', assetId).eq('user_id', auth.user.id);
      return res.status(500).json({ ok: false, error: 'video_upload_url_failed', message: '参考動画のアップロードを開始できませんでした。' });
    }

    return res.status(200).json({
      ok: true,
      assetId,
      bucket: REFERENCE_DANCE_BUCKET,
      path,
      token: data.token,
      contentType: 'video/mp4',
      maxBytes: MAX_REFERENCE_DANCE_BYTES,
      expiresAt
    });
  } catch (error) {
    console.error('[reference-dance-upload-url] failed', error?.message || String(error));
    return res.status(500).json({ ok: false, error: 'video_upload_url_failed', message: '参考動画のアップロードを開始できませんでした。' });
  }
};

module.exports._test = { countSince };

