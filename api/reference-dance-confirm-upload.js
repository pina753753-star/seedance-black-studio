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
const STORAGE_CAPABILITY_TTL_SECONDS = 3 * 60;
const DEFAULT_SUPABASE_URL = 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
// Public browser configuration, not a service-role credential. Keep in sync
// with auth-config.js; never use this key for a different Supabase project.
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_YbRKnQh1fCVO5VDJyVWfyQ_sNzHqvCE';
const PERMANENT_INSPECTION_MESSAGES = {
  VIDEO_SIZE_INVALID: '参考動画は50MB以下にしてください。',
  VIDEO_STREAM_MISSING: '動画トラックを確認できませんでした。別のMP4またはMOV動画を選択してください。',
  VIDEO_CONTAINER_INVALID: 'MP4またはMOV形式の動画を選択してください。',
  VIDEO_CODEC_UNSUPPORTED: 'H.264または対応するHEVC形式のMP4／MOV動画を選択してください。',
  VIDEO_FRAMERATE_INVALID: 'この動画のフレームレートには対応していません。60fps以下で書き出してください。',
  VIDEO_HDR_UNSUPPORTED: 'このHDR動画にはまだ対応していません。SDR（HDRなし）で書き出してください。',
  VIDEO_PROFILE_UNSUPPORTED: 'この動画形式にはまだ対応していません。H.264形式で書き出してください。',
  VIDEO_AUDIO_STRIP_FAILED: '参考動画の音声を安全に除去できませんでした。別の動画を選択してください。',
  VIDEO_DURATION_INVALID: '参考動画は4〜15秒にしてください。',
  VIDEO_DURATION_MISMATCH: '参考動画の長さを安全に確認できませんでした。別の動画を選択してください。',
  VIDEO_DIMENSIONS_INVALID: '参考動画の解像度を確認できませんでした。別の動画を選択してください。'
};

function safeDurationDiagnostics(value) {
  const result = {};
  for (const key of ['containerSeconds', 'videoSeconds', 'audioSeconds']) {
    const n = value?.[key];
    result[key] = typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 86400 ? n : null;
  }
  return result;
}

function inspectionMessage(code, diagnostics) {
  const durations = safeDurationDiagnostics(diagnostics);
  const values = [durations.containerSeconds, durations.videoSeconds].filter(n => n !== null);
  if (code === 'VIDEO_DURATION_INVALID' && values.length) {
    return `読み取った長さは${Math.max(...values).toFixed(3)}秒です。4〜15秒の動画、または「先頭15秒を使う」を選んで60秒以下の動画をアップロードしてください。`;
  }
  return PERMANENT_INSPECTION_MESSAGES[code] || '参考動画を読み取れませんでした。別のMP4またはMOV動画を選択してください。';
}

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

function readyResponse(row) {
  return {
    ok: true,
    assetId: row.id,
    status: 'ready',
    durationMs: row.duration_ms,
    billableSeconds: row.billable_seconds,
    sampleCredits: referenceDanceCredits(Number(row.billable_seconds)),
    sampleCreditsResolution: '720p',
    sampleCreditsByResolution: { '480p': referenceDanceCredits(Number(row.billable_seconds), '480p'), '720p': referenceDanceCredits(Number(row.billable_seconds)) },
    expiresAt: row.expires_at
  };
}

async function createStorageCapabilities(db, userId, assetId, stagingPath) {
  const supabaseUrl = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, '');
  const publishableKey = String(
    process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    || process.env.SUPABASE_ANON_KEY
    || (supabaseUrl === DEFAULT_SUPABASE_URL ? DEFAULT_SUPABASE_PUBLISHABLE_KEY : '')
  );
  if (!publishableKey) throw new Error('STORAGE_CAPABILITY_NOT_CONFIGURED');
  // Legacy anon JWTs are public too; never forward secret/service-role keys.
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey);
  if (!publicKey) {
    try {
      const parts = publishableKey.split('.');
      publicKey = parts.length === 3 && JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role === 'anon';
    } catch (_) {}
  }
  if (!publicKey) throw new Error('STORAGE_CAPABILITY_NOT_CONFIGURED');

  const approved = approvedPath(userId, assetId);
  const reviews = Array.from({ length: 5 }, (_, index) => reviewFramePath(userId, assetId, index + 1));
  const storage = db.storage.from(REFERENCE_DANCE_BUCKET);
  const { data: source, error: sourceError } = await storage.createSignedUrl(
    stagingPath,
    STORAGE_CAPABILITY_TTL_SECONDS
  );
  if (sourceError || !source?.signedUrl) throw new Error('STORAGE_DOWNLOAD_CAPABILITY_FAILED');

  const uploads = await Promise.all([approved, ...reviews].map(async (path) => {
    const { data, error } = await storage.createSignedUploadUrl(path, { upsert: true });
    if (error || !data?.token) throw new Error('STORAGE_UPLOAD_CAPABILITY_FAILED');
    return { path, token: data.token };
  }));

  return {
    supabaseUrl,
    publishableKey,
    sourceUrl: source.signedUrl,
    approvedUpload: uploads[0],
    reviewUploads: uploads.slice(1)
  };
}

async function inspectOnRailway({ userId, assetId, stagingPath, storageCapabilities, allowBoundaryTrim = false }) {
  const baseUrl = String(process.env.WATERMARK_SERVER_URL || '').replace(/\/+$/, '');
  const secret = String(process.env.WATERMARK_SECRET || '');
  if (!baseUrl || !secret) throw new Error('reference_dance_inspector_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSPECTION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/reference-dance-inspect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, assetId, stagingPath, storageCapabilities, allowBoundaryTrim: allowBoundaryTrim === true }),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    if (!response.ok || !data?.ok) {
      const code = typeof data?.error === 'string' ? data.error : `HTTP_${response.status}`;
      throw Object.assign(new Error(code), { inspectionCode: code, inspectionStatus: response.status, durationDiagnostics: safeDurationDiagnostics(data?.durationDiagnostics) });
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
  let trimConsent = false;
  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    if (!access.ok) return res.status(403).json({ ok: false, error: 'reference_dance_beta_forbidden' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    trimConsent = body.allowBoundaryTrim === true;
    assetId = String(body.assetId || '').trim();
    if (!isUuid(assetId)) return res.status(400).json({ ok: false, error: 'invalid_reference_video_id' });

    const { data: row, error: rowError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
      .select('*').eq('id', assetId).eq('user_id', auth.user.id).maybeSingle();
    if (rowError || !row) return res.status(404).json({ ok: false, error: 'reference_video_not_found' });
    if (!validateOwnedPath('staging', auth.user.id, assetId, row.staging_path)) {
      return res.status(400).json({ ok: false, error: 'invalid_reference_video_path' });
    }
    if (row.status === 'ready') {
      return res.status(200).json(readyResponse(row));
    }

    const { data: claim, error: claimError } = await auth.supabase.rpc('claim_seedance_reference_video_inspection', {
      p_asset_id: assetId,
      p_user_id: auth.user.id
    });
    if (claimError) throw claimError;
    if (claim?.code === 'busy') return res.status(409).json({ ok: false, error: 'reference_video_checking', retryable: true, message: '参考動画を確認中です。しばらくお待ちください。' });
    if (claim?.ok !== true) return res.status(409).json({ ok: false, error: `reference_video_${claim?.code || 'not_ready'}` });
    if (claim.code === 'ready') {
      const { data: readyRow, error: readyError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
        .select('*').eq('id', assetId).eq('user_id', auth.user.id).maybeSingle();
      if (readyError || readyRow?.status !== 'ready') throw new Error('reference_video_ready_persist_failed');
      return res.status(200).json(readyResponse(readyRow));
    }

    claimedRow = row;
    const storageCapabilities = await createStorageCapabilities(
      auth.supabase,
      auth.user.id,
      assetId,
      row.staging_path
    );
    const railwayData = await inspectOnRailway({
      userId: auth.user.id,
      assetId,
      stagingPath: row.staging_path,
      storageCapabilities,
      allowBoundaryTrim: trimConsent
    });
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
    await removeObjects(auth.supabase, [row.staging_path]);

    return res.status(200).json({
      ok: true,
      assetId,
      status: 'ready',
      durationMs: inspected.durationMs,
      billableSeconds: inspected.billableSeconds,
      sampleCredits: referenceDanceCredits(inspected.billableSeconds),
      sampleCreditsResolution: '720p',
      sampleCreditsByResolution: { '480p': referenceDanceCredits(inspected.billableSeconds, '480p'), '720p': referenceDanceCredits(inspected.billableSeconds) },
      trimApplied: railwayData.trimApplied === true || railwayData.boundaryTrimmed === true,
      durationDiagnostics: safeDurationDiagnostics(railwayData.durationDiagnostics),
      expiresAt
    });
  } catch (error) {
    console.error('[reference-dance-confirm] failed', error?.message || String(error), 'assetId:', assetId || null);
    const durations = safeDurationDiagnostics(error?.durationDiagnostics);
    const measuredSeconds = Math.max(durations.containerSeconds || 0, durations.videoSeconds || 0);
    // A reload can lose the browser's trim choice while retaining the upload.
    // Missing opt-in is recoverable, not permission to delete that source.
    if (claimedRow && !trimConsent && error?.inspectionCode === 'VIDEO_DURATION_INVALID'
        && measuredSeconds > 15 && measuredSeconds <= 60) {
      const { error: retryPersistError } = await auth.supabase.from(REFERENCE_DANCE_TABLE).update({
        status: 'uploading',
        inspection_error: 'VIDEO_DURATION_INVALID',
        updated_at: new Date().toISOString()
      }).eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking');
      if (retryPersistError) {
        return res.status(503).json({ ok: false, error: 'reference_video_check_failed', retryable: true, message: '参考動画を保持しています。時間を空けて再検査してください。' });
      }
      return res.status(422).json({
        ok: false,
        error: 'reference_video_trim_choice_required',
        reason: 'VIDEO_DURATION_INVALID',
        retryable: true,
        durationDiagnostics: durations,
        message: `読み取った長さは${measuredSeconds.toFixed(3)}秒です。動画は保持しています。「先頭15秒を使う」にチェックしてから再検査してください。`
      });
    }
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
        inspection_error: JSON.stringify({ code: error.inspectionCode, durationDiagnostics: safeDurationDiagnostics(error.durationDiagnostics) }),
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
        durationDiagnostics: safeDurationDiagnostics(error.durationDiagnostics),
        message: inspectionMessage(error.inspectionCode, error.durationDiagnostics)
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

module.exports._test = {
  validateInspection,
  createStorageCapabilities,
  inspectOnRailway,
  removeObjects,
  safeInspectionReason,
  safeDurationDiagnostics,
  inspectionMessage
};

