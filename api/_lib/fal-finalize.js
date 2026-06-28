'use strict';
/**
 * Shared finalization logic for fal.ai-generated tasks.
 *
 * Completion contract for fal tasks:
 *   status=completed iff: Supabase upload done AND (watermark applied OR not needed)
 *   watermarked_url is always set when status=completed:
 *     - Free user: watermarked URL from Railway
 *     - Paid user / no watermark server: copy of output_url
 *
 * Watermark failure → status stays 'processing', output_url saved, polling_url cleared.
 * Next cron run picks up the task via Phase B query (output_url set, watermarked_url null).
 *
 * Idempotent: safe to call concurrently with fal-status.js.
 *   - Supabase upload: upsert:true (same path per taskId)
 *   - Watermark: watermarked_url pre-check prevents double watermark
 *   - status update: conditional WHERE IN ('queued','processing') prevents double-complete
 */

const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';
const WATERMARK_SERVER_URL = process.env.WATERMARK_SERVER_URL || '';
const WATERMARK_SECRET = process.env.WATERMARK_SECRET || '';
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

/**
 * Attempts to apply a watermark for free users via Railway.
 *
 * Returns:
 *   { watermarked: true, url }         — watermark applied; url is the watermarked URL
 *   { watermarked: false, skipped }    — watermark not needed (paid user / no server); url = original
 *   { watermarked: false, error }      — watermark needed but failed; should retry
 */
async function applyWatermark(db, task, videoUrl) {
  if (!WATERMARK_SERVER_URL) {
    return { watermarked: false, skipped: 'no_server', url: videoUrl };
  }
  try {
    const { data: profile } = await db.from('profiles')
      .select('plan').eq('id', task.user_id).maybeSingle();
    const plan = String(profile?.plan || 'free').toLowerCase();
    const isFreeUser = !['paid', 'pro', 'premium', 'business', 'creator', 'ultimate'].includes(plan);
    if (!isFreeUser) {
      return { watermarked: false, skipped: 'paid_user', url: videoUrl };
    }

    if (!WATERMARK_SECRET) {
      console.warn('[fal-finalize] watermark_secret_missing, calling watermark server without auth');
    }
    const wmHeaders = { 'Content-Type': 'application/json' };
    if (WATERMARK_SECRET) wmHeaders['Authorization'] = `Bearer ${WATERMARK_SECRET}`;
    const wmRes = await fetch(`${WATERMARK_SERVER_URL}/watermark`, {
      method: 'POST',
      headers: wmHeaders,
      body: JSON.stringify({ videoUrl, userId: task.user_id })
    });
    if (!wmRes.ok) {
      return { watermarked: false, error: `watermark_http_${wmRes.status}`, url: videoUrl };
    }

    const wmData = await wmRes.json().catch(() => null);
    const wmUrl = validVideoUrl(wmData?.watermarkedUrl || '');
    if (!wmUrl) {
      return { watermarked: false, error: 'invalid_watermarked_url', url: videoUrl };
    }
    if (!isSupabasePublicUrl(wmUrl)) {
      return { watermarked: false, error: 'watermark_not_supabase_url', url: videoUrl };
    }

    return { watermarked: true, url: wmUrl };
  } catch (e) {
    return { watermarked: false, error: `watermark_exception: ${e?.message}`, url: videoUrl };
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
 * Completion only when watermark is satisfied (applied or not needed).
 * Watermark failure keeps status=processing and increments reconcile_attempts.
 *
 * Returns { ok, skipped?, reason?, watermarked?, error?, retryable? }
 */
async function finalizeTask(db, task) {
  const now = new Date().toISOString();

  // Already has a valid watermarked_url — nothing to do
  if (task.watermarked_url && isSupabasePublicUrl(task.watermarked_url)) {
    // Ensure status is completed (handles legacy inconsistency)
    if (task.status !== 'completed') {
      await db.from('generation_tasks')
        .update({ status: 'completed', updated_at: now })
        .eq('id', task.id)
        .in('status', ['queued', 'processing']);
    }
    return { ok: true, skipped: true, reason: 'already_has_watermarked_url' };
  }

  const settings = (task.settings && typeof task.settings === 'object') ? task.settings : {};
  const attempts = Number(settings.reconcile_attempts || 0);

  // Max attempts reached — skip processing; leave in processing for manual review
  if (attempts >= MAX_RECONCILE_ATTEMPTS) {
    console.warn('[fal-finalize] max attempts reached, needs review, taskId:', task.id, 'attempts:', attempts);
    return { ok: false, skipped: true, reason: 'max_attempts_reached', attempts };
  }

  // ── Determine publicUrl (skip download if already uploaded) ───────────────
  let publicUrl = task.output_url && isSupabasePublicUrl(task.output_url) ? task.output_url : null;

  if (!publicUrl) {
    const pollingUrl = task.polling_url;
    if (!pollingUrl || isSupabasePublicUrl(pollingUrl)) {
      return { ok: false, skipped: true, reason: 'no_fal_cdn_url' };
    }

    const uploadResult = await downloadAndUpload(db, pollingUrl, task.id);
    if (!uploadResult.ok) {
      console.warn('[fal-finalize] upload failed:', uploadResult.error, 'taskId:', task.id, 'attempt:', attempts + 1);
      await mergeSettings(db, task.id, {
        reconcile_attempts: attempts + 1,
        last_reconcile_error: uploadResult.error,
        last_reconcile_at: now
      });
      return { ok: false, error: uploadResult.error, retryable: true };
    }
    publicUrl = uploadResult.publicUrl;
    console.log('[fal-finalize] upload success, taskId:', task.id, 'bytes:', uploadResult.bytes);

    // Save output_url and clear polling_url immediately after upload so that:
    // - next retry skips re-download (output_url is now Supabase URL)
    // - polling_url won't be re-processed by Phase A even if watermark fails
    await db.from('generation_tasks')
      .update({ output_url: publicUrl, polling_url: null, updated_at: now })
      .eq('id', task.id)
      .in('status', ['queued', 'processing']);
  }

  // ── Apply watermark ────────────────────────────────────────────────────────
  const wm = await applyWatermark(db, task, publicUrl);

  // Watermark requirement satisfied: applied successfully OR not needed
  const watermarkSatisfied = wm.watermarked || Boolean(wm.skipped);

  if (!watermarkSatisfied) {
    // Watermark failed — keep status=processing, increment attempt counter
    console.warn('[fal-finalize] watermark failed:', wm.error, 'taskId:', task.id, 'attempt:', attempts + 1);
    await mergeSettings(db, task.id, {
      reconcile_attempts: attempts + 1,
      last_reconcile_error: wm.error,
      last_reconcile_at: now
    });
    return { ok: false, error: wm.error, retryable: true };
  }

  // Watermark satisfied:
  //   - wm.watermarked === true  → wm.url is the Railway-watermarked URL
  //   - wm.skipped (paid/no-server) → use publicUrl as the delivery URL
  // Always set watermarked_url so fal-status can use it as the "ready" signal.
  const watermarkedUrl = wm.watermarked ? wm.url : publicUrl;

  // Mark completed. Conditional WHERE prevents race with concurrent finalize calls.
  // finished_at is set by DB trigger on first terminal transition to completed/failed.
  await db.from('generation_tasks')
    .update({
      status: 'completed',
      output_url: publicUrl,
      watermarked_url: watermarkedUrl,
      polling_url: null,
      updated_at: now
    })
    .eq('id', task.id)
    .in('status', ['queued', 'processing']);

  // Clear attempt tracking on success
  await mergeSettings(db, task.id, {
    reconcile_attempts: 0,
    last_reconcile_error: null,
    last_reconcile_at: now
  });

  console.log('[fal-finalize] task completed, taskId:', task.id,
    'watermarked:', wm.watermarked, 'skipped:', wm.skipped || false);
  return { ok: true, publicUrl, watermarkedUrl, watermarked: wm.watermarked };
}

module.exports = {
  downloadAndUpload,
  applyWatermark,
  finalizeTask,
  isSupabasePublicUrl,
  validVideoUrl,
  MAX_RECONCILE_ATTEMPTS
};
