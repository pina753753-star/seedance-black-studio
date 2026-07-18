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
// Recovery relies on watermark-server/server.js's /edit endpoint now
// accepting a `taskId` and using it as a deterministic Storage output path
// (edited/<userId>/<taskId>.mp4) instead of a random uuid — see the
// `outputId` parameter added there. That means this module can always
// predict where a given task's finished file would be, independent of
// whether the original Vercel request that triggered the edit ever
// returned.
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

// Confirms a Storage object exists and looks like a video, without
// downloading the body. Mirrors verifyPublicObject() in api/seedance-status.js
// and verifyStorageObjectExists() in api/generated-videos.js.
async function verifyEditedObjectExists(db, path) {
  try {
    const { data } = db.storage.from(VIDEO_BUCKET).getPublicUrl(path);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) return { exists: false };

    const headRes = await fetch(publicUrl, { method: 'HEAD' });
    const headContentType = headRes.headers.get('content-type') || '';
    const headContentLength = Number(headRes.headers.get('content-length') || 0);
    if (headRes.ok && /video|octet-stream/i.test(headContentType) && headContentLength >= 1024) {
      return { exists: true, publicUrl, bytes: headContentLength };
    }

    const rangeRes = await fetch(publicUrl, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
    const contentType = rangeRes.headers.get('content-type') || '';
    await rangeRes.body?.cancel().catch(() => {});

    if (!rangeRes.ok && rangeRes.status !== 206) return { exists: false };

    const contentRange = rangeRes.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const totalBytes = totalMatch ? Number(totalMatch[1]) : Number(rangeRes.headers.get('content-length') || 0);
    if (!totalBytes || totalBytes < 1024) return { exists: false };
    if (!/video|octet-stream/i.test(contentType)) return { exists: false };

    return { exists: true, publicUrl, bytes: totalBytes };
  } catch (_) {
    // Network error / timeout: unverifiable, treat as not-yet-found so the
    // caller keeps waiting rather than prematurely refunding.
    return { exists: false };
  }
}

// Attempts to resolve a single task currently in 'processing'. Returns:
//   { changed: false, status: 'processing' }                      — still waiting, not stale yet
//   { changed: true,  status: 'completed', editedUrl }             — Storage object found, task claimed
//   { changed: true,  status: 'failed', refunded: true }           — stale + refunded
//   { changed: false, status: 'processing' }                       — lost a race (another caller already resolved it)
// Never throws; never refunds twice (refund_video_edit_task RPC guards that).
async function reconcileVideoEditTask(db, task) {
  if (!task || task.status !== 'processing') {
    return { changed: false, status: task?.status || 'unknown' };
  }

  const path = editedObjectPath(task.user_id, task.id);
  const check = await verifyEditedObjectExists(db, path);

  if (check.exists) {
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
