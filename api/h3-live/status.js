'use strict';

// GET /api/h3-live/status?jobId=<uuid>
//
// Refresh one H3 Live job the caller owns. Terminal jobs are returned straight
// from the database. An active job polls fal.ai at most once per
// STATUS_UPSTREAM_MIN_INTERVAL_MS, guarded by a conditional UPDATE so
// concurrent polls cannot both hit the provider. A confirmed provider failure
// refunds the 110 credits before the failure is exposed.
//
// Standalone: no Seedance / billing / watermark code involved. Credit refunds
// go only through refund_h3_live_job_atomic.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { serviceClient, isUuid, sanitizeJob } = require('../_lib/h3-live-store.js');
const { getJobStatus } = require('../_lib/h3-live-fal.js');
const { STATUS_POLL_MS, STATUS_UPSTREAM_MIN_INTERVAL_MS, CREDIT_COST } = require('../_lib/h3-live-config.js');
const {
  UPLOADS_TABLE,
  deleteUploadObject,
  sweepStaleUploads
} = require('../_lib/h3-live-image-store.js');

const ACTIVE = ['queued', 'submitting', 'processing'];

function pollHint(status) {
  return ACTIVE.includes(status) ? STATUS_POLL_MS : 0;
}

// Best-effort: once an image-mode job reaches a terminal state its quarantined
// input frame is no longer needed. Never throws.
async function cleanupJobImage(db, jobRow) {
  if (!jobRow || jobRow.input_mode !== 'image' || !jobRow.image_upload_id) return;
  try {
    const { data: row } = await db
      .from(UPLOADS_TABLE)
      .select('*')
      .eq('id', jobRow.image_upload_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (row) await deleteUploadObject(db, row);
  } catch (_) { /* best effort */ }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'GET only.' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  // Opportunistic cleanup of abandoned image uploads (bounded, never throws).
  sweepStaleUploads(db).catch(() => {});

  const jobId = String(req.query.jobId || req.query.id || '').trim();
  if (!isUuid(jobId)) {
    return res.status(400).json({ ok: false, error: 'invalid_job_id', message: 'ジョブIDが不正です。' });
  }

  const { data: job, error: lookupError } = await db
    .from('h3_live_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (lookupError) {
    console.error('[h3-live/status] lookup error:', lookupError.message);
    return res.status(500).json({ ok: false, error: 'job_lookup_failed' });
  }
  if (!job) {
    return res.status(404).json({ ok: false, error: 'job_not_found', message: 'この生成を確認できません。' });
  }

  // Terminal — no upstream call. Best-effort retry of the input-frame cleanup:
  // an earlier terminating poll may have hit a transient storage error, and
  // cleanupJobImage is a no-op once the frame is already gone. Fire-and-forget
  // so it never delays or fails the response.
  if (!ACTIVE.includes(job.status)) {
    cleanupJobImage(db, job).catch(() => {});
    return res.status(200).json({ ok: true, job: sanitizeJob(job), nextPollAfterMs: 0 });
  }

  // Nothing to poll yet (reserved / submitting without a request id).
  if (!job.provider_poll_url || !job.provider_response_url) {
    return res.status(200).json({ ok: true, job: sanitizeJob(job), nextPollAfterMs: STATUS_POLL_MS });
  }

  // Throttle: skip the upstream call if we polled very recently.
  const nowMs = Date.now();
  const lastPolledMs = job.last_polled_at ? Date.parse(job.last_polled_at) : 0;
  if (Number.isFinite(lastPolledMs) && lastPolledMs > 0 && nowMs - lastPolledMs < STATUS_UPSTREAM_MIN_INTERVAL_MS) {
    return res.status(200).json({ ok: true, job: sanitizeJob(job), nextPollAfterMs: STATUS_POLL_MS });
  }

  // Claim the poll. Only one caller wins per interval.
  const thresholdIso = JSON.stringify(new Date(nowMs - STATUS_UPSTREAM_MIN_INTERVAL_MS).toISOString());
  const { data: claimRows, error: claimError } = await db
    .from('h3_live_jobs')
    .update({
      last_polled_at: new Date(nowMs).toISOString(),
      poll_attempt_count: (Number(job.poll_attempt_count) || 0) + 1,
      updated_at: new Date(nowMs).toISOString()
    })
    .eq('id', jobId)
    .in('status', ACTIVE)
    .or(`last_polled_at.is.null,last_polled_at.lt.${thresholdIso}`)
    .select('id');

  if (claimError) {
    console.error('[h3-live/status] poll claim update error:', claimError.message, 'jobId:', jobId);
  }

  if (!Array.isArray(claimRows) || claimRows.length !== 1) {
    // Lost the claim (concurrent poll) or the claim UPDATE errored — return
    // current state and let the client poll again.
    return res.status(200).json({ ok: true, job: sanitizeJob(job), nextPollAfterMs: STATUS_POLL_MS });
  }

  const upstream = await getJobStatus({
    statusUrl: job.provider_poll_url,
    responseUrl: job.provider_response_url
  });

  if (!upstream.ok) {
    // Transient — keep the client polling.
    return res.status(200).json({
      ok: true,
      job: sanitizeJob({ ...job, status: 'processing' }),
      nextPollAfterMs: STATUS_POLL_MS
    });
  }

  if (upstream.state === 'processing') {
    await db.from('h3_live_jobs')
      .update({ provider_status: upstream.providerStatus || 'IN_PROGRESS', updated_at: new Date().toISOString() })
      .eq('id', jobId)
      .in('status', ACTIVE);
    return res.status(200).json({
      ok: true,
      job: sanitizeJob({ ...job, status: 'processing', provider_status: upstream.providerStatus || 'IN_PROGRESS' }),
      nextPollAfterMs: STATUS_POLL_MS
    });
  }

  if (upstream.state === 'completed') {
    const doneIso = new Date().toISOString();
    const { data: claimed, error: completeError } = await db
      .from('h3_live_jobs')
      .update({
        status: 'completed',
        output_url: upstream.outputUrl,
        provider_status: 'COMPLETED',
        completed_at: doneIso,
        finished_at: doneIso,
        updated_at: doneIso
      })
      .eq('id', jobId)
      .in('status', ACTIVE)
      .select('*');

    if (completeError) {
      console.error('[h3-live/status] completed persist error:', completeError.message, 'jobId:', jobId);
    }

    let finalRow;
    if (Array.isArray(claimed) && claimed.length === 1) {
      finalRow = claimed[0];
    } else {
      const reselect = await db.from('h3_live_jobs').select('*').eq('id', jobId).maybeSingle();
      if (reselect.error) {
        console.error('[h3-live/status] completed re-select error:', reselect.error.message, 'jobId:', jobId);
      }
      finalRow = reselect.data || null;
    }

    // Only treat this as done when the row is actually terminal. If the
    // completed UPDATE errored or lost its claim and the row is still active,
    // keep the client polling and leave the input frame in place rather than
    // stranding an active job with a stopped client.
    const settled = Boolean(finalRow) && !ACTIVE.includes(finalRow.status);
    if (settled) await cleanupJobImage(db, finalRow);

    return res.status(200).json({
      ok: true,
      job: sanitizeJob(finalRow),
      nextPollAfterMs: settled ? 0 : STATUS_POLL_MS
    });
  }

  // upstream.state === 'failed' — refund before exposing the failure.
  let refund;
  try {
    const { data, error } = await db.rpc('refund_h3_live_job_atomic', {
      p_job_id: jobId,
      p_error_code: String(upstream.errorCode || 'provider_failed').slice(0, 100),
      p_error_message: String(upstream.errorMessage || '').slice(0, 1000)
    });
    refund = error ? { code: error.message } : data;
  } catch (e) {
    refund = { code: e?.message || String(e) };
  }

  const refundConfirmed = ['refunded', 'already_refunded', 'no_charge_found', 'already_completed'].includes(refund?.code);
  if (!refundConfirmed) {
    // Could not confirm the refund — keep the client polling rather than
    // reporting an unrefunded failure.
    console.error('[h3-live/status] refund unconfirmed for jobId:', jobId, 'code:', refund?.code);
    return res.status(200).json({
      ok: true,
      job: sanitizeJob({ ...job, status: 'processing' }),
      nextPollAfterMs: STATUS_POLL_MS
    });
  }

  const finalRow = (await db.from('h3_live_jobs').select('*').eq('id', jobId).maybeSingle()).data;
  await cleanupJobImage(db, finalRow);
  return res.status(200).json({
    ok: true,
    job: sanitizeJob(finalRow),
    refunded: ['refunded', 'already_refunded'].includes(refund?.code),
    creditRefunded: ['refunded', 'already_refunded'].includes(refund?.code) ? CREDIT_COST : 0,
    nextPollAfterMs: 0
  });
};
