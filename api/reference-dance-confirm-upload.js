'use strict';

const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { moderateContent } = require('./_lib/openai-moderation.js');
const {
  REFERENCE_DANCE_BUCKET,
  REFERENCE_DANCE_TABLE,
  REFERENCE_DANCE_RETENTION_MS,
  MAX_REFERENCE_DANCE_BYTES,
  MIN_REFERENCE_DANCE_DURATION_MS,
  MAX_REFERENCE_DANCE_DURATION_MS,
  isUuid,
  isPermanentReferenceDanceInspectionError,
  validateOwnedPath,
  approvedPath,
  reviewFramePath,
  authorizeReferenceDanceAdmin,
  referenceDanceCredits
} = require('./_lib/reference-dance.js');

const INSPECTION_TIMEOUT_MS = 120000;
const PERMANENT_INSPECTION_MESSAGES = {
  VIDEO_SIZE_INVALID: '参考動画は50MB以下にしてください。',
  VIDEO_STREAM_MISSING: '動画トラックを確認できませんでした。別のMP4動画を選択してください。',
  VIDEO_CONTAINER_INVALID: 'MP4形式の動画を選択してください。',
  VIDEO_CODEC_UNSUPPORTED: 'H.264形式のMP4動画を選択してください。',
  VIDEO_AUDIO_STRIP_FAILED: '参考動画の音声を安全に除去できませんでした。別の動画を選択してください。',
  VIDEO_DURATION_INVALID: '参考動画は4〜15秒にしてください。',
  VIDEO_DURATION_MISMATCH: '参考動画の長さを安全に確認できませんでした。別の動画を選択してください。',
  VIDEO_DIMENSIONS_INVALID: '参考動画の解像度を確認できませんでした。別の動画を選択してください。'
};

function safeInspectionReason(error) {
  const raw = String(error?.inspectionCode || error?.message || error?.name || 'unknown').trim();
  if (/^(HTTP_\d{3}|[A-Z][A-Z0-9_]{2,63}|reference_dance_inspector_not_configured|invalid_inspection_response|review_frame_url_failed|reference_video_moderation_unavailable|reference_video_ready_persist_failed|AbortError)$/.test(raw)) return raw;
  return 'unknown';
}

async function removeObjects(db, paths) {
  const safe = [...new Set((paths || []).filter(Boolean))];
  if (!safe.length) return true;
  const { error } = await db.storage.from(REFERENCE_DANCE_BUCKET).remove(safe);
  if (error) console.error('[reference-dance-confirm] object cleanup failed', error.message);
  return !error;
}

function validateInspection(data, userId, assetId) {
  if (!data || data.ok !== true) return null;
  if (!validateOwnedPath('approved', userId, assetId, data.approvedPath)) return null;
  const reviewPaths = Array.isArray(data.reviewPaths) ? data.reviewPaths : [];
  if (reviewPaths.length !== 5 || !reviewPaths.every((p) => validateOwnedPath('review', userId, assetId, p))) return null;
  const sizeBytes = Number(data.sizeBytes);
  const durationMs = Number(data.durationMs);
  const billableSeconds = Math.max(4, Math.ceil(durationMs / 1000));
  const width = Number(data.width);
  const height = Number(data.height);
  const fps = Number(data.fps);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_REFERENCE_DANCE_BYTES) return null;
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_REFERENCE_DANCE_DURATION_MS || durationMs > MAX_REFERENCE_DANCE_DURATION_MS) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096) return null;
  if (!Number.isFinite(fps) || fps < 1 || fps > 120 || data.videoCodec !== 'h264' || !/^[0-9a-f]{64}$/i.test(String(data.sha256 || ''))) return null;
  return {
    approvedPath: data.approvedPath,
    reviewPaths,
    sizeBytes,
    durationMs,
    billableSeconds,
    width,
    height,
    fps,
    videoCodec: 'h264',
    sha256: String(data.sha256).toLowerCase()
  };
}

async function inspectOnRailway({ userId, assetId, stagingPath }) {
  const baseUrl = String(process.env.WATERMARK_SERVER_URL || '').replace(/\/+$/, '');
  const secret = String(process.env.WATERMARK_SECRET || '');
  if (!baseUrl || !secret) throw new Error('reference_dance_inspector_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSPECTION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/reference-dance-inspect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, assetId, stagingPath }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!response.ok || !data?.ok) {
      const code = typeof data?.error === 'string' ? data.error : `HTTP_${response.status}`;
      throw Object.assign(new Error(code), { inspectionCode: code, inspectionStatus: response.status });
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  let assetId = '';
  let claimedRow = null;
  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    if (!access.ok) return res.status(403).json({ ok: false, error: 'reference_dance_beta_forbidden' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    assetId = String(body.assetId || '').trim();
    if (!isUuid(assetId)) return res.status(400).json({ ok: false, error: 'invalid_reference_video_id' });

    const { data: row, error: rowError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
      .select('*').eq('id', assetId).eq('user_id', auth.user.id).maybeSingle();
    if (rowError || !row) return res.status(404).json({ ok: false, error: 'reference_video_not_found' });
    if (!validateOwnedPath('staging', auth.user.id, assetId, row.staging_path)) {
      return res.status(400).json({ ok: false, error: 'invalid_reference_video_path' });
    }
    if (row.status === 'ready') {
      return res.status(200).json({
        ok: true,
        assetId,
        status: 'ready',
        durationMs: row.duration_ms,
        billableSeconds: row.billable_seconds,
        sampleCredits: referenceDanceCredits(Number(row.billable_seconds))
      });
    }

    const { data: claim, error: claimError } = await auth.supabase.rpc('claim_seedance_reference_video_inspection', {
      p_asset_id: assetId,
      p_user_id: auth.user.id
    });
    if (claimError) throw claimError;
    if (claim?.code === 'busy') return res.status(409).json({ ok: false, error: 'reference_video_checking', message: '参考動画を確認中です。しばらくお待ちください。' });
    if (claim?.ok !== true) return res.status(409).json({ ok: false, error: `reference_video_${claim?.code || 'not_ready'}` });
    if (claim.code === 'ready') {
      return res.status(200).json({ ok: true, assetId, status: 'ready' });
    }

    claimedRow = row;
    const railwayData = await inspectOnRailway({ userId: auth.user.id, assetId, stagingPath: row.staging_path });
    const inspected = validateInspection(railwayData, auth.user.id, assetId);
    if (!inspected) throw new Error('invalid_inspection_response');

    const reviewUrls = [];
    for (const path of inspected.reviewPaths) {
      const { data, error } = await auth.supabase.storage.from(REFERENCE_DANCE_BUCKET).createSignedUrl(path, 10 * 60);
      if (error || !data?.signedUrl) throw new Error('review_frame_url_failed');
      reviewUrls.push(data.signedUrl);
    }
    const moderation = await moderateContent('', reviewUrls);
    if (!moderation?.ok) throw new Error('reference_video_moderation_unavailable');
    if (moderation.flagged === true) {
      await removeObjects(auth.supabase, [row.staging_path, inspected.approvedPath, ...inspected.reviewPaths]);
      await auth.supabase.from(REFERENCE_DANCE_TABLE).update({
        status: 'blocked',
        approved_path: inspected.approvedPath,
        review_paths: inspected.reviewPaths,
        moderation_categories: moderation.categories || [],
        expires_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }).eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking');
      return res.status(422).json({ ok: false, error: 'reference_video_content_blocked', message: 'この参考動画は安全確認を通過できませんでした。' });
    }

    const expiresAt = new Date(Date.now() + REFERENCE_DANCE_RETENTION_MS).toISOString();
    const { data: updated, error: updateError } = await auth.supabase.from(REFERENCE_DANCE_TABLE).update({
      status: 'ready',
      approved_path: inspected.approvedPath,
      review_paths: inspected.reviewPaths,
      size_bytes: inspected.sizeBytes,
      duration_ms: inspected.durationMs,
      billable_seconds: inspected.billableSeconds,
      width: inspected.width,
      height: inspected.height,
      fps: inspected.fps,
      video_codec: inspected.videoCodec,
      sha256: inspected.sha256,
      moderation_categories: [],
      inspection_error: null,
      expires_at: expiresAt,
      updated_at: new Date().toISOString()
    }).eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking').select('id');
    if (updateError || !updated || updated.length !== 1) throw new Error('reference_video_ready_persist_failed');

    return res.status(200).json({
      ok: true,
      assetId,
      status: 'ready',
      durationMs: inspected.durationMs,
      billableSeconds: inspected.billableSeconds,
      sampleCredits: referenceDanceCredits(inspected.billableSeconds),
      expiresAt
    });
  } catch (error) {
    console.error('[reference-dance-confirm] failed', error?.message || String(error), 'assetId:', assetId || null);
    if (claimedRow && isPermanentReferenceDanceInspectionError(error?.inspectionCode)) {
      const paths = [
        claimedRow.staging_path,
        approvedPath(auth.user.id, assetId),
        ...Array.from({ length: 5 }, (_, index) => reviewFramePath(auth.user.id, assetId, index + 1))
      ];
      await removeObjects(auth.supabase, paths);
      const now = new Date().toISOString();
      const { error: failureError } = await auth.supabase.from(REFERENCE_DANCE_TABLE).update({
        status: 'failed',
        expires_at: now,
        updated_at: now
      }).eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking');
      if (failureError) {
        console.error('[reference-dance-confirm] permanent failure persist failed', failureError.message);
        return res.status(503).json({
          ok: false,
          error: 'reference_video_check_failed',
          message: '参考動画を安全に処理できませんでした。時間を空けてもう一度お試しください。'
        });
      }
      return res.status(422).json({
        ok: false,
        error: 'reference_video_invalid',
        reason: error.inspectionCode,
        message: PERMANENT_INSPECTION_MESSAGES[error.inspectionCode] || '参考動画を読み取れませんでした。別のMP4動画を選択してください。'
      });
    }
    const reason = safeInspectionReason(error);
    if (claimedRow) {
      const now = new Date().toISOString();
      const { error: retryPersistError } = await auth.supabase.from(REFERENCE_DANCE_TABLE).update({
        status: 'uploading',
        inspection_error: reason,
        updated_at: now
      }).eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking');
      if (retryPersistError) console.error('[reference-dance-confirm] retry state persist failed', retryPersistError.message);
    }
    return res.status(503).json({
      ok: false,
      error: 'reference_video_check_failed',
      reason,
      retryable: true,
      message: `参考動画の検査に失敗しました（${reason}）。動画は保持しているため、再アップロードは不要です。`
    });
  }
};

module.exports._test = { validateInspection, inspectOnRailway, removeObjects, safeInspectionReason };
