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
  referenceDanceCredits,
  klingDance
} = require('./_lib/reference-dance.js');

const INSPECTION_TIMEOUT_MS = 120000;
// Set in inspection_error only when a motion length change failed (the master already exists then).
const MOTION_RECUT_FAILURE_PREFIX = 'MOTION_RECUT:';
// Stored in inspection_error of a READY row only when the motion pipeline sealed it, i.e. staging holds the audio-free
// master a length change can start from. A Seedance asset (staging deleted after success) never carries it.
const MOTION_MASTER_MARKER = 'MOTION_MASTER';
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

function inspectionMessage(code, diagnostics, motion = false) {
  const durations = safeDurationDiagnostics(diagnostics);
  const values = [durations.containerSeconds, durations.videoSeconds].filter(n => n !== null);
  if (motion && code === 'VIDEO_DURATION_INVALID') {
    const measured = values.length ? `読み取った長さは${Math.max(...values).toFixed(3)}秒です。` : '';
    return `${measured}お手本動画は${klingDance.KLING_DANCE_MIN_SECONDS}〜${klingDance.KLING_DANCE_SOURCE_MAX_SECONDS}秒の動画を選んでください（使えるのは先頭${klingDance.KLING_DANCE_SELECTABLE_MAX_SECONDS}秒までです）。`;
  }
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

// motion: { maxDurationMs, useSeconds } — the motion profile is answered only by an inspector that says
// so (an older inspector that ignores `profile` is refused, never trusted), and a requested length must
// match the sealed file exactly: never longer than chosen and billed (ceil) as exactly that many seconds.
function validateInspection(data, userId, assetId, motion = null) {
  if (!data || data.ok !== true) return null;
  if (motion) {
    if (data.inspectorProfile !== 'motion-v1') return null;
    const ms = Number(data.durationMs);
    if (!Number.isSafeInteger(ms) || ms > motion.maxDurationMs) return null;
    if (Number.isInteger(motion.useSeconds) && (ms > motion.useSeconds * 1000 || Math.ceil(ms / 1000) !== motion.useSeconds)) return null;
  }
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
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_REFERENCE_DANCE_DURATION_MS || durationMs > (motion ? motion.maxDurationMs : MAX_REFERENCE_DANCE_DURATION_MS)) return null;
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

// The Seedance sample price exists only for the Seedance dance's 4-15 s; a longer (motion) asset has none.
function sampleCredits(seconds, resolution) {
  return Number.isInteger(seconds) && seconds <= 15 ? referenceDanceCredits(seconds, resolution) : null;
}

function readyResponse(row) {
  return {
    ok: true,
    assetId: row.id,
    status: 'ready',
    durationMs: row.duration_ms,
    billableSeconds: row.billable_seconds,
    sampleCredits: sampleCredits(Number(row.billable_seconds)),
    sampleCreditsResolution: '720p',
    sampleCreditsByResolution: { '480p': sampleCredits(Number(row.billable_seconds), '480p'), '720p': sampleCredits(Number(row.billable_seconds)) },
    expiresAt: row.expires_at
  };
}

// 'yes' | 'no' | 'unknown' (a failed lookup is never read as "missing": nothing is changed on either answer).
async function stagingMasterState(db, userId, assetId) {
  const { data, error } = await db.storage.from(REFERENCE_DANCE_BUCKET)
    .list(`staging/${userId}`, { limit: 5, search: `${assetId}.mp4` });
  if (error || !Array.isArray(data)) return 'unknown';
  return data.some((item) => item?.name === `${assetId}.mp4`) ? 'yes' : 'no';
}

const MOTION_LENGTH_UNAVAILABLE = {
  ok: false,
  error: 'motion_length_unavailable',
  message: 'このお手本動画は長さを変更できません。使う場合はそのまま選ぶか、もう一度アップロードしてください。'
};
const MOTION_LENGTH_CHECK_FAILED = {
  ok: false,
  error: 'reference_video_check_failed',
  retryable: true,
  message: '元動画の状態を確認できませんでした。少し待ってからもう一度お試しください。'
};

async function createStorageCapabilities(db, userId, assetId, stagingPath, { withMaster = false } = {}) {
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

  const uploads = await Promise.all([approved, ...reviews, ...(withMaster ? [stagingPath] : [])].map(async (path) => {
    const { data, error } = await storage.createSignedUploadUrl(path, { upsert: true });
    if (error || !data?.token) throw new Error('STORAGE_UPLOAD_CAPABILITY_FAILED');
    return { path, token: data.token };
  }));

  return {
    supabaseUrl,
    publishableKey,
    sourceUrl: source.signedUrl,
    approvedUpload: uploads[0],
    reviewUploads: uploads.slice(1, 1 + reviews.length),
    // Motion first run only: scoped token to rewrite staging with the audio-free master.
    ...(withMaster ? { masterUpload: uploads[1 + reviews.length] } : {})
  };
}

async function inspectOnRailway({ userId, assetId, stagingPath, storageCapabilities, allowBoundaryTrim = false, profile, useSeconds }) {
  const baseUrl = String(process.env.WATERMARK_SERVER_URL || '').replace(/\/+$/, '');
  const secret = String(process.env.WATERMARK_SECRET || '');
  if (!baseUrl || !secret) throw new Error('reference_dance_inspector_not_configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSPECTION_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/reference-dance-inspect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, assetId, stagingPath, storageCapabilities, allowBoundaryTrim: allowBoundaryTrim === true, ...(profile === 'motion' ? { profile: 'motion', useSeconds: useSeconds === undefined ? null : useSeconds } : {}) }),
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
  let motion = false;
  let recut = false;
  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    if (!access.ok) return res.status(403).json({ ok: false, error: 'reference_dance_beta_forbidden' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    trimConsent = body.allowBoundaryTrim === true;
    assetId = String(body.assetId || '').trim();
    if (!isUuid(assetId)) return res.status(400).json({ ok: false, error: 'invalid_reference_video_id' });

    // Motion (Kling) profile: opt-in, closed set, and only while the length choice is enabled
    // (config.maxUseSeconds > 10, flipped after the DB constraint and the inspector are live).
    let useSeconds = null;
    const hasUseSeconds = Object.prototype.hasOwnProperty.call(body, 'useSeconds');
    if (body.profile !== undefined && body.profile !== 'motion') {
      return res.status(400).json({ ok: false, error: 'invalid_profile' });
    }
    motion = body.profile === 'motion';
    if (motion) {
      if (!klingDance.isKlingDanceLengthSelectEnabled()) {
        return res.status(400).json({ ok: false, error: 'motion_profile_disabled' });
      }
      if (hasUseSeconds && body.useSeconds !== null) {
        const n = body.useSeconds;
        if (!Number.isInteger(n) || n < klingDance.KLING_DANCE_MIN_SECONDS || n > klingDance.getKlingDanceMaxSeconds()) {
          return res.status(400).json({ ok: false, error: 'invalid_use_seconds', message: `使用する長さは${klingDance.KLING_DANCE_MIN_SECONDS}〜${klingDance.getKlingDanceMaxSeconds()}秒の整数で指定してください。` });
        }
        useSeconds = n;
      }
    } else if (hasUseSeconds) {
      return res.status(400).json({ ok: false, error: 'invalid_use_seconds' });
    }
    const motionMaxMs = klingDance.KLING_DANCE_STORED_MAX_MS;

    const { data: row, error: rowError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
      .select('*').eq('id', assetId).eq('user_id', auth.user.id).maybeSingle();
    if (rowError || !row) return res.status(404).json({ ok: false, error: 'reference_video_not_found' });
    if (!validateOwnedPath('staging', auth.user.id, assetId, row.staging_path)) {
      return res.status(400).json({ ok: false, error: 'invalid_reference_video_path' });
    }
    if (row.status === 'ready' && !(motion && hasUseSeconds)) {
      return res.status(200).json(readyResponse(row));
    }

    let claim = null;
    if (row.status === 'ready') {
      // Length change on a ready motion asset: a conditional ready -> checking transition that does not
      // consume an inspection attempt, is refused once a task has used the asset (or it expired), and is
      // throttled so rapid changes cannot queue heavy inspections. The staging object is the audio-free
      // master, so nothing is re-uploaded. Exactly one concurrent request can win this update.
      if (row.used_at || Date.parse(String(row.expires_at || '')) <= Date.now()) {
        return res.status(409).json({ ok: false, error: 'reference_video_in_use', message: 'このお手本動画はすでに生成に使われたため、長さを変更できません。' });
      }
      // Only an asset the motion pipeline sealed has a master to cut from. Anything else (a Seedance asset whose
      // source was deleted, a lost object) is refused BEFORE the row is touched and stays exactly as it was.
      if (row.inspection_error !== MOTION_MASTER_MARKER) return res.status(400).json(MOTION_LENGTH_UNAVAILABLE);
      const masterState = await stagingMasterState(auth.supabase, auth.user.id, assetId);
      if (masterState === 'unknown') return res.status(503).json(MOTION_LENGTH_CHECK_FAILED);
      if (masterState === 'no') return res.status(400).json(MOTION_LENGTH_UNAVAILABLE);
      const throttleBefore = new Date(Date.now() - 1000).toISOString();
      const { data: recutClaim, error: recutClaimError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
        .update({ status: 'checking', updated_at: new Date().toISOString(), expires_at: new Date(Math.max(Date.parse(String(row.expires_at || '')) || 0, Date.now() + 60 * 60 * 1000)).toISOString() })
        .eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'ready').is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .lt('updated_at', throttleBefore).select('id');
      if (recutClaimError) throw recutClaimError;
      if (!recutClaim || recutClaim.length !== 1) {
        return res.status(409).json({ ok: false, error: 'reference_video_checking', retryable: true, message: '長さを変更中です。少し待ってからもう一度お試しください。' });
      }
      recut = true;
    } else if (motion && row.status === 'uploading' && String(row.inspection_error || '').startsWith(MOTION_RECUT_FAILURE_PREFIX)) {
      // The previous length change failed after the master existed: staging is the audio-free master, so this
      // is again a length change. It does not consume an inspection attempt (a few transient errors must not
      // permanently fail a healthy asset) and never rewrites the master.
      // Same rules as a length change on a ready asset: an expired asset is never revived (cleanup owns it), and
      // the lease is extended (never shortened) so the re-inspection has time to finish.
      if (Date.parse(String(row.expires_at || '')) <= Date.now()) {
        return res.status(409).json({ ok: false, error: 'reference_video_in_use', message: 'このお手本動画は保存期限が切れました。もう一度アップロードしてください。' });
      }
      const masterState = await stagingMasterState(auth.supabase, auth.user.id, assetId);
      if (masterState === 'unknown') return res.status(503).json(MOTION_LENGTH_CHECK_FAILED);
      if (masterState === 'no') return res.status(400).json(MOTION_LENGTH_UNAVAILABLE);
      const throttleBefore = new Date(Date.now() - 1000).toISOString();
      const { data: retryClaim, error: retryClaimError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
        .update({ status: 'checking', updated_at: new Date().toISOString(), expires_at: new Date(Math.max(Date.parse(String(row.expires_at || '')) || 0, Date.now() + 60 * 60 * 1000)).toISOString() })
        .eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'uploading').is('used_at', null)
        .gt('expires_at', new Date().toISOString())
        .lt('updated_at', throttleBefore).select('id');
      if (retryClaimError) throw retryClaimError;
      if (!retryClaim || retryClaim.length !== 1) {
        return res.status(409).json({ ok: false, error: 'reference_video_checking', retryable: true, message: '長さを変更中です。少し待ってからもう一度お試しください。' });
      }
      recut = true;
    } else {
      // A first inspection of a motion asset always uses the whole video (it also writes the audio-free master).
      // A cut is only possible once that master exists, i.e. as a length change above.
      if (motion && useSeconds !== null) {
        return res.status(400).json({ ok: false, error: 'invalid_use_seconds', message: '最初にお手本動画全体を確認してから、使う長さを選んでください。' });
      }
      const claimResult = await auth.supabase.rpc('claim_seedance_reference_video_inspection', {
        p_asset_id: assetId,
        p_user_id: auth.user.id
      });
      if (claimResult.error) throw claimResult.error;
      claim = claimResult.data;
      if (claim?.code === 'busy') return res.status(409).json({ ok: false, error: 'reference_video_checking', retryable: true, message: '参考動画を確認中です。しばらくお待ちください。' });
      if (claim?.ok !== true) return res.status(409).json({ ok: false, error: `reference_video_${claim?.code || 'not_ready'}` });
    }
    if (claim?.code === 'ready') {
      const { data: readyRow, error: readyError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
        .select('*').eq('id', assetId).eq('user_id', auth.user.id).maybeSingle();
      if (readyError || readyRow?.status !== 'ready') throw new Error('reference_video_ready_persist_failed');
      return res.status(200).json(readyResponse(readyRow));
    }

    claimedRow = row;
    // The audio-free master is written back to staging only on a whole-source run of a motion asset
    // that has not been through the motion pipeline yet (never when cutting, never on a length change).
    const storageCapabilities = await createStorageCapabilities(
      auth.supabase,
      auth.user.id,
      assetId,
      row.staging_path,
      { withMaster: motion && !recut && useSeconds === null }
    );
    const railwayData = await inspectOnRailway({
      userId: auth.user.id,
      assetId,
      stagingPath: row.staging_path,
      storageCapabilities,
      allowBoundaryTrim: motion ? false : trimConsent,
      ...(motion ? { profile: 'motion', useSeconds } : {})
    });
    const inspected = validateInspection(railwayData, auth.user.id, assetId, motion ? { maxDurationMs: motionMaxMs, useSeconds } : null);
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
      inspection_error: motion ? MOTION_MASTER_MARKER : null,
      // A length change keeps the retention it already had (extended at the claim only as far as the re-inspection
      // needs); only a first inspection starts the full retention. A change never renews the asset.
      ...(recut ? {} : { expires_at: expiresAt }),
      updated_at: new Date().toISOString()
    }).eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking').select('id,expires_at');
    if (updateError || !updated || updated.length !== 1) throw new Error('reference_video_ready_persist_failed');
    // Motion keeps staging: it now holds the audio-free master used for later length changes
    // (removed with the asset by the expiry cleanup).
    if (!motion) await removeObjects(auth.supabase, [row.staging_path]);

    return res.status(200).json({
      ok: true,
      assetId,
      status: 'ready',
      ...(motion ? { motion: {
        mode: railwayData.motion?.mode === 'cut' ? 'cut' : 'whole',
        useSeconds: Number.isInteger(railwayData.motion?.useSeconds) ? railwayData.motion.useSeconds : null,
        capped: railwayData.motion?.capped === true,
        sourceDurationMs: Number.isSafeInteger(railwayData.motion?.sourceDurationMs) ? railwayData.motion.sourceDurationMs : null,
        masterDurationMs: Number.isSafeInteger(railwayData.motion?.masterDurationMs) ? railwayData.motion.masterDurationMs : null
      } } : {}),
      durationMs: inspected.durationMs,
      billableSeconds: inspected.billableSeconds,
      sampleCredits: sampleCredits(inspected.billableSeconds),
      sampleCreditsResolution: '720p',
      sampleCreditsByResolution: { '480p': sampleCredits(inspected.billableSeconds, '480p'), '720p': sampleCredits(inspected.billableSeconds) },
      trimApplied: railwayData.trimApplied === true || railwayData.boundaryTrimmed === true,
      durationDiagnostics: safeDurationDiagnostics(railwayData.durationDiagnostics),
      expiresAt: recut ? (updated[0].expires_at || null) : expiresAt
    });
  } catch (error) {
    console.error('[reference-dance-confirm] failed', error?.message || String(error), 'assetId:', assetId || null);
    const durations = safeDurationDiagnostics(error?.durationDiagnostics);
    const measuredSeconds = Math.max(durations.containerSeconds || 0, durations.videoSeconds || 0);
    // A reload can lose the browser's trim choice while retaining the upload.
    // Missing opt-in is recoverable, not permission to delete that source.
    if (claimedRow && !motion && !trimConsent && error?.inspectionCode === 'VIDEO_DURATION_INVALID'
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
    // A rejected length request (longer than the source, out of range) touched nothing: the sealed file and
    // its stored numbers are unchanged, so a length change simply goes back to ready.
    if (claimedRow && motion && ['MOTION_USE_SECONDS_INVALID', 'MOTION_USE_EXCEEDS_SOURCE'].includes(error?.inspectionCode)) {
      if (recut) {
        // Back to exactly the state it was in: 'ready' only if it was ready (its numbers still match the sealed file);
        // a retry state after an earlier failure must never be promoted to ready.
        const { error: restoreError } = await auth.supabase.from(REFERENCE_DANCE_TABLE).update({ status: claimedRow.status === 'ready' ? 'ready' : 'uploading', updated_at: new Date().toISOString() })
          .eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking');
        if (restoreError) console.error('[reference-dance-confirm] ready restore failed', restoreError.message);
      } else {
        await auth.supabase.from(REFERENCE_DANCE_TABLE).update({ status: 'uploading', inspection_error: error.inspectionCode, updated_at: new Date().toISOString() })
          .eq('id', assetId).eq('user_id', auth.user.id).eq('status', 'checking');
      }
      return res.status(400).json({
        ok: false,
        error: 'motion_length_invalid',
        reason: error.inspectionCode,
        message: error.inspectionCode === 'MOTION_USE_EXCEEDS_SOURCE'
          ? '元の動画より長い区間は選べません。短い長さを選んでください。'
          : `使用する長さは${klingDance.KLING_DANCE_MIN_SECONDS}〜${klingDance.getKlingDanceMaxSeconds()}秒の整数で指定してください。`
      });
    }
    // A failed LENGTH CHANGE never deletes the asset it started from: even a permanent-looking inspection code goes to the
    // retry state (the master in staging is intact), so a healthy asset is never destroyed by a change request.
    if (claimedRow && !recut && isPermanentReferenceDanceInspectionError(error?.inspectionCode)) {
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
        message: inspectionMessage(error.inspectionCode, error.durationDiagnostics, motion)
      });
    }
    const reason = safeInspectionReason(error);
    if (claimedRow) {
      const now = new Date().toISOString();
      const { error: retryPersistError } = await auth.supabase.from(REFERENCE_DANCE_TABLE).update({
        status: 'uploading',
        inspection_error: recut ? `${MOTION_RECUT_FAILURE_PREFIX}${reason}` : reason,
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

