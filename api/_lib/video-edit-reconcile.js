'use strict';
// Shared reconciliation logic for video_edit_tasks stuck in 'processing'.
//
// api/video-edit.js calls Railway's /edit endpoint synchronously and, per
// the "unclear disconnect" handling in its catch block, deliberately does
// NOT refund when its own request to Railway is ambiguous (network error,
// our AbortController firing, or the whole Vercel function being killed by
// Vercel's own timeout before we get a chance to respond) — the task is
// left in 'processing'. Without a separate recovery path, such a task (and
// the credits deducted for it) would never resolve.
//
// Recovery relies on watermark-server/server.js's /edit endpoint requiring a
// `taskId` and using it as the Storage output path
// (edited/<userId>/<taskId>.mp4). That means this module can always predict
// where a given task's finished file would be, independent of whether the
// original Vercel request that triggered the edit ever returned.
//
// Used by:
//   - api/video-edit-status.js: on-demand, when a client polls a specific
//     'processing' task.
//   - api/video-edit-reconcile.js: a Vercel Cron job (mirrors
//     api/openrouter-reconcile.js) that sweeps ALL 'processing' tasks, so
//     tasks nobody ever polls (browser closed, app backgrounded) still get
//     resolved.

const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';

// Default: Railway's own /edit budget is 5 minutes (EDIT_REQUEST_TIMEOUT_MS
// in watermark-server/server.js). 10 minutes gives a safety margin for
// queueing (MAX_CONCURRENT_EDIT_JOBS) plus request/response overhead before
// treating a task as abandoned.
const DEFAULT_STALE_MS = 10 * 60 * 1000;

function editedObjectPath(userId, taskId) {
  return `edited/${userId}/${taskId}.mp4`;
}

// Confirms whether a Storage object exists and looks like a video, without
// downloading the body. Mirrors verifyPublicObject() in
// api/seedance-status.js and verifyStorageObjectExists() in
// api/generated-videos.js, but — unlike those — distinguishes "definitely
// not there" from "couldn't tell", because the caller (reconcileVideoEditTask)
// must never treat an inconclusive check as grounds for a refund:
//   { state: 'exists',  publicUrl, bytes } — confirmed present and readable as a video
//   { state: 'missing' }                   — HEAD returned 404 AND the follow-up Range GET
//                                             also returned 404. This is the ONLY condition
//                                             that produces 'missing' — any other HEAD/Range
//                                             combination (including a HEAD/Range mismatch,
//                                             e.g. HEAD 200 but Range 404, or HEAD 500) falls
//                                             through to 'unknown' instead.
//   { state: 'unknown' }                   — fetch threw (network error/timeout), a response
//                                             came back but was inconclusive (wrong
//                                             content-type, too small, non-404/non-206/non-2xx
//                                             status), or HEAD and Range disagreed — NOT proof
//                                             of absence
async function verifyEditedObjectExists(db, path) {
  const { data } = db.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  const publicUrl = data?.publicUrl;
  if (!publicUrl) return { state: 'unknown' };

  let headRes;
  try {
    headRes = await fetch(publicUrl, { method: 'HEAD' });
  } catch (_) {
    return { state: 'unknown' };
  }

  const headContentType = headRes.headers.get('content-type') || '';
  const headContentLength = Number(headRes.headers.get('content-length') || 0);
  if (headRes.ok && /video|octet-stream/i.test(headContentType) && headContentLength >= 1024) {
    return { state: 'exists', publicUrl, bytes: headContentLength };
  }
  if (headRes.status !== 404) {
    // HEAD succeeded but wasn't a clean "found" or "404" (e.g. inconclusive
    // content-type/length, or a non-404 error) — fall through to the Range
    // GET for a second opinion rather than deciding from HEAD alone.
    let rangeRes;
    try {
      rangeRes = await fetch(publicUrl, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
    } catch (_) {
      return { state: 'unknown' };
    }
    const contentType = rangeRes.headers.get('content-type') || '';
    await rangeRes.body?.cancel().catch(() => {});

    // HEAD was not a clean 404 here (that's the only branch that reaches
    // this code), so a 404 from the Range GET is a HEAD/Range mismatch, not
    // an agreed-upon "missing" — 'missing' is only ever returned from the
    // HEAD-404 branch below, where both checks agree.
    if (rangeRes.status === 404) return { state: 'unknown' };
    if (!rangeRes.ok && rangeRes.status !== 206) return { state: 'unknown' };

    const contentRange = rangeRes.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const totalBytes = totalMatch ? Number(totalMatch[1]) : Number(rangeRes.headers.get('content-length') || 0);
    if (!totalBytes || totalBytes < 1024) return { state: 'unknown' };
    if (!/video|octet-stream/i.test(contentType)) return { state: 'unknown' };

    return { state: 'exists', publicUrl, bytes: totalBytes };
  }

  // HEAD returned a clean 404 — confirm with a Range GET before deciding
  // "missing" (some Storage/CDN layers respond inconsistently to HEAD).
  let rangeRes;
  try {
    rangeRes = await fetch(publicUrl, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
  } catch (_) {
    return { state: 'unknown' };
  }
  await rangeRes.body?.cancel().catch(() => {});
  return rangeRes.status === 404 ? { state: 'missing' } : { state: 'unknown' };
}

// Attempts to resolve a single task currently in 'processing'. Returns:
//   { changed: true,  status: 'completed', editedUrl }             — Storage object confirmed present, task claimed
//   { changed: true,  status: 'failed', refunded: true }           — confirmed missing + stale -> refunded
//   { changed: false, status: 'processing' }                       — still waiting (not stale, storage check
//                                                                     inconclusive, or lost a race to another caller)
// Never throws; never refunds twice (refund_video_edit_task RPC guards that).
// Critically: a Storage check result of 'unknown' (network error, timeout,
// or an inconclusive response) is NEVER treated as evidence the file is
// missing — only a confirmed 'missing' result counts toward the staleness
// clock's refund decision. This avoids refunding a task whose edit actually
// succeeded but whose Storage object we simply failed to verify this time.
async function reconcileVideoEditTask(db, task) {
  if (!task || task.status !== 'processing') {
    return { changed: false, status: task?.status || 'unknown' };
  }

  const path = editedObjectPath(task.user_id, task.id);
  const check = await verifyEditedObjectExists(db, path);

  if (check.state === 'exists') {
    const { data: updated, error: updateErr } = await db
      .from('video_edit_tasks')
      .update({
        status: 'completed',
        edited_url: check.publicUrl,
        // The exact rendered duration isn't recoverable without downloading
        // and probing the file (which this endpoint deliberately avoids).
        // requested_output_duration is the closest available estimate.
        actual_output_duration: task.actual_output_duration ?? task.requested_output_duration,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', task.id)
      .eq('status', 'processing')
      .select('id');

    if (updateErr) {
      console.error('[video-edit-reconcile] completion update failed, taskId:', task.id, updateErr.message);
      return { changed: false, status: 'processing' };
    }
    if (updated && updated.length > 0) {
      return { changed: true, status: 'completed', editedUrl: check.publicUrl };
    }
    // 0 rows updated: another concurrent reconcile/status call already claimed it.
    return { changed: false, status: 'processing' };
  }

  if (check.state === 'unknown') {
    // Inconclusive check (network error, timeout, or an ambiguous
    // response) — do nothing. Never counts toward staleness/refund.
    return { changed: false, status: 'processing' };
  }

  // check.state === 'missing': confirmed absent. Only refund once this has
  // been true for long enough that Railway's own processing budget has
  // certainly elapsed.
  const staleMs = Number(process.env.VIDEO_EDIT_RECONCILE_STALE_MS) || DEFAULT_STALE_MS;
  const referenceTime = task.started_at || task.created_at;
  const ageMs = referenceTime ? Date.now() - new Date(referenceTime).getTime() : 0;

  if (Number.isFinite(ageMs) && ageMs >= staleMs) {
    try {
      const { data: refundRows, error: refundErr } = await db.rpc('refund_video_edit_task', {
        p_task_id: task.id,
        p_failure_code: 'processing_timeout'
      });
      if (refundErr) {
        console.error('[video-edit-reconcile] refund RPC error, taskId:', task.id, refundErr.message);
        return { changed: false, status: 'processing' };
      }
      const refundRow = Array.isArray(refundRows) ? refundRows[0] : refundRows;
      if (refundRow?.ok) {
        console.log('[video-edit-reconcile] refunded stale processing task:', task.id);
        return { changed: true, status: 'failed', refunded: true };
      }
      // not_refundable / already_refunded / not_found: another caller
      // already resolved this task (completed or refunded) between our
      // storage check and the RPC call.
      return { changed: false, status: 'processing' };
    } catch (err) {
      console.error('[video-edit-reconcile] refund exception, taskId:', task.id, err?.message);
      return { changed: false, status: 'processing' };
    }
  }

  return { changed: false, status: 'processing' };
}

module.exports = {
  VIDEO_BUCKET,
  DEFAULT_STALE_MS,
  editedObjectPath,
  verifyEditedObjectExists,
  reconcileVideoEditTask
};
