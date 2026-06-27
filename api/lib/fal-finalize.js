'use strict';
/**
 * Shared finalization logic for fal.ai-generated tasks.
 *
 * Called by both fal-reconcile.js (background cron) and fal-status.js (fallback when
 * user is watching). Using upsert:true and idempotency checks makes concurrent calls safe:
 * - Supabase upload: same path + upsert → last writer wins (same bytes)
 * - Watermark: watermarked_url pre-check → skipped if already done
 * - completed update: WHERE status IN ('queued','processing') → only one writer succeeds
 */

const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';
const WATERMARK_SERVER_URL = process.env.WATERMARK_SERVER_URL || '';
const MAX_RECONCILE_ATTEMPTS = 5;

function isSupabasePublicUrl(url) {
  const s = String(url || '');
  return /^https?:\/\//i.test(s) && s.includes('/storage/v1/object/public/');
}

function validVideoUrl(url) {
  const s = String(url || '').trim();
  if (!/^https:\/\//i.test(s)) return '';
  if (/\.(mp4|mov|webm)(\?|$)/i.test(s)) return s;
  if (/\/storage\/v1\/object\/public\//i.test(s)) return s;
  return '';
}

// Downloads a fal CDN video URL and uploads it to Supabase Storage.
async function downloadAndUpload(db, videoUrl, taskId) {
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    return { ok: false, error: 'invalid_video_url' };
  }

  let videoBuffer, contentType;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const dlRes = await fetch(videoUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'flowvid-studio/1.0' }
      });
      if (!dlRes.ok) return { ok: false, error: `download_http_${dlRes.status}` };
      contentType = dlRes.headers.get('content-type') || 'video/mp4';
      videoBuffer = Buffer.from(await dlRes.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    return { ok: false, error: `download_failed: ${e?.message}` };
  }

  if (!videoBuffer || videoBuffer.length < 1000) {
    return { ok: false, error: `file_too_small: ${videoBuffer?.length ?? 0} bytes` };
  }

  const safeId = String(taskId || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  const path = `fal-videos/${safeId}.mp4`;
  const upload = await db.storage.from(VIDEO_BUCKET).upload(path, videoBuffer, {
    contentType, cacheControl: '31536000', upsert: true
  });
  if (upload.error) return { ok: false, error: `supabase_upload: ${upload.error.message}` };

  const { data: urlData } = db.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  const publicUrl = urlData?.publicUrl || '';
  if (!publicUrl) return { ok: false, error: 'no_public_url_after_upload' };

  return { ok: true, publicUrl, bytes: videoBuffer.length };
}

// Applies a watermark for free users. Returns the best available URL.
// Failures are logged but do not block completion (matches existing OpenRouter behavior).
async function applyWatermark(db, task, videoUrl) {
  if (!WATERMARK_SERVER_URL) return { url: videoUrl, watermarked: false };
  try {
    const { data: profile } = await db.from('profiles')
      .select('plan').eq('id', task.user_id).maybeSingle();
    const plan = String(profile?.plan || 'free').toLowerCase();
    const isFreeUser = !['paid', 'pro', 'premium', 'business', 'creator', 'ultimate'].includes(plan);
    if (!isFreeUser) return { url: videoUrl, watermarked: false, skipped: 'paid_user' };

    const wmRes = await fetch(`${WATERMARK_SERVER_URL}/watermark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl, userId: task.user_id })
    });
    if (!wmRes.ok) return { url: videoUrl, watermarked: false, error: `watermark_http_${wmRes.status}` };

    const wmData = await wmRes.json().catch(() => null);
    const wmUrl = validVideoUrl(wmData?.watermarkedUrl || '');
    if (!wmUrl) return { url: videoUrl, watermarked: false, error: 'invalid_watermarked_url' };
    if (!isSupabasePublicUrl(wmUrl)) return { url: videoUrl, watermarked: false, error: 'watermark_not_supabase_url' };

    return { url: wmUrl, watermarked: true };
  } catch (e) {
    return { url: videoUrl, watermarked: false, error: `watermark_exception: ${e?.message}` };
  }
}

// Merges reconcile tracking fields into the task's settings JSONB without overwriting unrelated keys.
async function mergeSettings(db, taskId, patch) {
  try {
    const { data: t } = await db.from('generation_tasks')
      .select('settings').eq('id', taskId).maybeSingle();
    const base = (t?.settings && typeof t.settings === 'object' && !Array.isArray(t.settings))
      ? t.settings : {};
    const merged = { ...base, ...patch };
    await db.from('generation_tasks')
      .update({ settings: merged, updated_at: new Date().toISOString() })
      .eq('id', taskId);
  } catch (_) {
    // settings update is best-effort; do not block main flow
  }
}

/**
 * Finalize a single fal task: download → upload → watermark → mark completed.
 *
 * Returns { ok, skipped?, reason?, watermarked?, error? }
 *
 * Idempotent: safe to call multiple times for the same task.
 */
async function finalizeTask(db, task) {
  // Skip if already finalized
  if (task.status === 'completed' && task.output_url && isSupabasePublicUrl(task.output_url)) {
    // Still try watermark if missing
    if (task.watermarked_url && isSupabasePublicUrl(task.watermarked_url)) {
      return { ok: true, skipped: true, reason: 'already_completed_with_watermark' };
    }
    // Apply watermark to already-uploaded video
    const wm = await applyWatermark(db, task, task.output_url);
    if (wm.watermarked) {
      await db.from('generation_tasks')
        .update({ watermarked_url: wm.url, updated_at: new Date().toISOString() })
        .eq('id', task.id);
    }
    return { ok: true, skipped: true, reason: 'already_completed_applying_watermark', watermarked: wm.watermarked };
  }

  // Check attempt count to avoid infinite retry on permanently broken tasks
  const settings = (task.settings && typeof task.settings === 'object') ? task.settings : {};
  const attempts = Number(settings.reconcile_attempts || 0);
  if (attempts >= MAX_RECONCILE_ATTEMPTS) {
    console.warn('[fal-finalize] max attempts reached, skipping taskId:', task.id, 'attempts:', attempts);
    return { ok: false, skipped: true, reason: 'max_attempts_reached', attempts };
  }

  const pollingUrl = task.polling_url;
  if (!pollingUrl || isSupabasePublicUrl(pollingUrl)) {
    // No fal CDN URL available — webhook hasn't arrived or URL already replaced
    return { ok: false, skipped: true, reason: 'no_fal_cdn_url' };
  }

  // Use existing Supabase output_url if already uploaded (skip re-download)
  let publicUrl = task.output_url && isSupabasePublicUrl(task.output_url) ? task.output_url : null;

  if (!publicUrl) {
    const uploadResult = await downloadAndUpload(db, pollingUrl, task.id);
    if (!uploadResult.ok) {
      console.warn('[fal-finalize] upload failed:', uploadResult.error, 'taskId:', task.id, 'attempt:', attempts + 1);
      await mergeSettings(db, task.id, {
        reconcile_attempts: attempts + 1,
        last_reconcile_error: uploadResult.error,
        last_reconcile_at: new Date().toISOString()
      });
      return { ok: false, error: uploadResult.error };
    }
    publicUrl = uploadResult.publicUrl;
    console.log('[fal-finalize] upload success, taskId:', task.id, 'bytes:', uploadResult.bytes);
  }

  // Apply watermark
  let watermarkedUrl = null;
  if (!task.watermarked_url || !isSupabasePublicUrl(task.watermarked_url)) {
    const wm = await applyWatermark(db, task, publicUrl);
    if (wm.watermarked) {
      watermarkedUrl = wm.url;
    } else if (wm.error) {
      console.warn('[fal-finalize] watermark failed:', wm.error, 'taskId:', task.id);
    }
  }

  // Mark completed. Use conditional UPDATE to prevent race conditions.
  // finished_at is set by DB trigger on first terminal transition (if trigger exists).
  const updatePayload = {
    status: 'completed',
    output_url: publicUrl,
    polling_url: null,
    updated_at: new Date().toISOString()
  };
  if (watermarkedUrl) updatePayload.watermarked_url = watermarkedUrl;

  await db.from('generation_tasks')
    .update(updatePayload)
    .eq('id', task.id)
    .in('status', ['queued', 'processing']);

  // Clear attempt tracking on success
  await mergeSettings(db, task.id, {
    reconcile_attempts: 0,
    last_reconcile_error: null,
    last_reconcile_at: new Date().toISOString()
  });

  console.log('[fal-finalize] task finalized, taskId:', task.id, 'watermarked:', Boolean(watermarkedUrl));
  return { ok: true, publicUrl, watermarked: Boolean(watermarkedUrl) };
}

module.exports = {
  downloadAndUpload,
  applyWatermark,
  finalizeTask,
  isSupabasePublicUrl,
  validVideoUrl,
  MAX_RECONCILE_ATTEMPTS
};
