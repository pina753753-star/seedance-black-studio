'use strict';

// GET/POST /api/h3-live/reconcile — operator reconciler for stuck H3 Live jobs.
//
// A job is "stuck" in one of two ways:
//   - untrackable: still active (queued / submitting / processing) but has no
//     provider_poll_url, so /api/h3-live/status can never advance or
//     terminate it. This happens when /api/h3-live/start was interrupted after
//     the credit charge but before (or during) the fal.ai submit, or when the
//     tracking info could not be persisted.
//   - trackable_stalled: DOES have a provider_poll_url (so start.js reached
//     fal.ai), but has stayed active long after submitted_at. This covers a
//     poll that keeps failing in a way api/_lib/h3-live-fal.js classifies as
//     transient (e.g. a revoked FAL_KEY returning 401/403 on every call,
//     see AUTH_LIKE_HTTP_STATUSES there) — without this bucket such a job is
//     invisible here and status.js reports it as "processing" forever,
//     permanently occupying the user's 110 credits and one-active-job slot
//     (found in review, PR #224). updated_at cannot be used to detect this:
//     api/h3-live/status.js's poll-claim step bumps updated_at on every
//     attempt even when the upstream call itself fails, so a permanently
//     failing poll still looks "recently touched". submitted_at is written
//     once at initial submission and never touched again, so it is immune to
//     that churn and is what TRACKABLE_STALE_MINUTES below measures against.
// api/h3-live/start.js deliberately does NOT auto resend or auto-refund
// either case (double-generation / double-charge risk), so an operator
// resolves them here.
//
//   GET  /api/h3-live/reconcile                       -> list stuck jobs (read-only).
//        Each row includes providerRequestId + charged so an operator can check
//        fal.ai before deciding. `reason` distinguishes the two buckets above.
//   POST /api/h3-live/reconcile { jobId }             -> release an uncharged,
//        fully-unsubmitted job. A single guarded UPDATE atomically flips it to
//        'failed' only if it is still active, untracked, uncharged and stale —
//        so a concurrent /api/h3-live/start that has since charged it loses the
//        race and proceeds normally, and the loser here aborts.
//   POST /api/h3-live/reconcile { jobId, force:true } -> also release a CHARGED
//        or ambiguous-submit (has request id) job. The operator asserts they
//        have verified on fal.ai that nothing is running. Same guarded flip
//        (minus the uncharged / no-request-id conditions).
//   After the flip, refund_h3_live_job_atomic settles credits (refunds a real
//   charge, or reports no_charge_found), and any bound quarantine frame is
//   dropped best-effort.
//
// Auth: Authorization: Bearer <CRON_SECRET>. NOT registered in vercel.json
// `crons` (that file is out of scope for this slice) — invoke it manually or
// from an external scheduler. Shares nothing with the Seedance flow, the
// billing / Stripe code, or the watermark server; credit refunds go only
// through refund_h3_live_job_atomic.

const { createClient } = require('@supabase/supabase-js');
const { isUuid, sanitizeJob } = require('../_lib/h3-live-store.js');
const { UPLOADS_TABLE, deleteUploadObject } = require('../_lib/h3-live-image-store.js');
const { deleteJobReferenceImages } = require('../_lib/h3-max-reference-image-store.js');
const { CREDIT_COST } = require('../_lib/h3-live-config.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

// Only treat a job as stuck once it has sat untouched this long. A live
// /api/h3-live/start invocation cannot outlive a Vercel function (single-digit
// minutes, well under this), so a job with no activity for STALE_MINUTES has a
// provably-dead originating request. (An idempotent *replay* can still arrive
// later; the guarded status flip in releaseJob handles that separately.)
const STALE_MINUTES = 20;
// 30 minutes is a generous multiple of the expected single-digit-minute
// queue+generation time for a 15s H3 Max video (that exact figure is
// unverified — see api/_lib/h3-live-fal.js's header comment; tune this if
// real-world data says otherwise). Kept separate from STALE_MINUTES because a
// trackable job genuinely may still be running past 20 minutes in a slow
// queue, whereas an untrackable job past 20 minutes is provably dead (a
// Vercel function cannot outlive that).
const TRACKABLE_STALE_MINUTES = 30;
const LIST_LIMIT = 100;

function staleCutoffIso() {
  return new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
}

function trackableStaleCutoffIso() {
  return new Date(Date.now() - TRACKABLE_STALE_MINUTES * 60 * 1000).toISOString();
}

const ACTIVE = ['queued', 'submitting', 'processing'];
const REFUND_TERMINAL_CODES = ['refunded', 'already_refunded', 'no_charge_found', 'already_completed'];

function authenticate(req) {
  if (!CRON_SECRET) return false;
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  return auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === CRON_SECRET;
}

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function jsonBody(req) {
  if (typeof req?.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req?.body || {};
}

const LIST_COLUMNS =
  'id, user_id, status, input_mode, image_upload_id, charged_at, provider_request_id, provider_poll_url, submitted_at, created_at, updated_at';

function toStuckJob(r, reason) {
  // trackable_stalled measures age from submitted_at (see the header comment
  // and TRACKABLE_STALE_MINUTES above for why updated_at cannot be used here).
  const ageBasisIso = reason === 'trackable_stalled' ? r.submitted_at : r.updated_at;
  return {
    id: r.id,
    userId: r.user_id,
    status: r.status,
    inputMode: ['image', 'reference', 'storyboard'].includes(r.input_mode) ? r.input_mode : 'text',
    charged: Boolean(r.charged_at),
    providerRequestId: r.provider_request_id || null,
    reason,
    ageMinutes: ageBasisIso ? Math.floor((Date.now() - Date.parse(ageBasisIso)) / 60000) : null,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null
  };
}

async function listStuck(db) {
  const cutoffIso = staleCutoffIso();
  const trackableCutoffIso = trackableStaleCutoffIso();

  const [untrackableRes, trackableRes] = await Promise.all([
    // Bucket 1: /start never got a usable provider poll URL.
    db.from('h3_live_jobs')
      .select(LIST_COLUMNS)
      .in('status', ACTIVE)
      .is('provider_poll_url', null)
      .lt('updated_at', cutoffIso)
      .order('updated_at', { ascending: true })
      .limit(LIST_LIMIT),
    // Bucket 2: has a provider poll URL but has sat active long past
    // submitted_at — status.js's own polling is not making progress.
    db.from('h3_live_jobs')
      .select(LIST_COLUMNS)
      .in('status', ACTIVE)
      .not('provider_poll_url', 'is', null)
      .not('submitted_at', 'is', null)
      .lt('submitted_at', trackableCutoffIso)
      .order('submitted_at', { ascending: true })
      .limit(LIST_LIMIT)
  ]);

  if (untrackableRes.error) return { ok: false, error: untrackableRes.error.message };
  if (trackableRes.error) return { ok: false, error: trackableRes.error.message };

  const jobs = [
    ...(untrackableRes.data || []).map((r) => toStuckJob(r, 'untrackable')),
    ...(trackableRes.data || []).map((r) => toStuckJob(r, 'trackable_stalled'))
  ];
  return { ok: true, jobs };
}

// Run the (idempotent) credit settlement for a job that reconcile has already
// flipped to a terminal 'failed' state, then drop any bound frame. Shared by
// the normal release path and the settle-retry path so a settlement that did
// not confirm on the first POST can still be completed on a later one.
async function settleReleasedJob(db, jobId, jobRow, extraBody = {}) {
  let settle;
  try {
    const { data, error } = await db.rpc('refund_h3_live_job_atomic', {
      p_job_id: jobId,
      p_error_code: 'operator_reconcile_release',
      p_error_message: 'released by api/h3-live/reconcile'
    });
    settle = error ? { code: error.message } : data;
  } catch (e) {
    settle = { code: e?.message || String(e) };
  }

  if (!REFUND_TERMINAL_CODES.includes(settle?.code)) {
    console.error('[h3-live/reconcile] release settle unconfirmed. jobId:', jobId, 'code:', settle?.code);
    return { status: 503, body: { ok: false, error: 'settle_state_uncertain', jobId, settleCode: settle?.code || null } };
  }
  if (settle?.code === 'already_completed') {
    // Unreachable with the normal writer set (nothing completes a job that has
    // no tracking URLs) — log it as an anomaly rather than swallowing it.
    console.warn('[h3-live/reconcile] settle returned already_completed for a released job — unexpected. jobId:', jobId);
  }

  // Best-effort: drop the quarantined input frame for image jobs.
  if (jobRow && jobRow.input_mode === 'image' && jobRow.image_upload_id) {
    try {
      const { data: uploadRow } = await db
        .from(UPLOADS_TABLE)
        .select('*')
        .eq('id', jobRow.image_upload_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (uploadRow) await deleteUploadObject(db, uploadRow);
    } catch (_) { /* best effort */ }
  }

  // Best-effort: drop ALL bound reference/storyboard images for this job.
  // Independent of the single-image cleanup above — never touches
  // h3_live_image_uploads.
  if (jobRow && (jobRow.input_mode === 'reference' || jobRow.input_mode === 'storyboard')) {
    try { await deleteJobReferenceImages(db, jobId); } catch (_) { /* best effort */ }
  }

  const reselect = await db.from('h3_live_jobs').select('*').eq('id', jobId).maybeSingle();
  if (reselect.error) {
    console.error('[h3-live/reconcile] post-release re-select error:', reselect.error.message, 'jobId:', jobId);
  }

  return {
    status: 200,
    body: {
      ok: true,
      // 'already_completed' is unreachable with the normal writer set; if some
      // other service-role writer ever completes a job we flagged for release,
      // do not claim we released it.
      released: settle?.code !== 'already_completed',
      settleCode: settle?.code || null,
      creditRefundedNow: settle?.code === 'refunded' ? CREDIT_COST : 0,
      alreadyRefunded: settle?.code === 'already_refunded',
      ...extraBody,
      job: sanitizeJob(reselect.data || null)
    }
  };
}

async function releaseJob(db, jobId, { force = false } = {}) {
  const { data: job, error: lookupError } = await db
    .from('h3_live_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (lookupError) return { status: 500, body: { ok: false, error: 'job_lookup_failed' } };
  if (!job) return { status: 404, body: { ok: false, error: 'job_not_found' } };

  // Settle-retry: a prior POST already flipped this job to 'failed' via
  // operator_reconcile_release, but the credit settlement did not confirm (503
  // settle_state_uncertain). Re-run the idempotent settle so an outstanding
  // charge can still be refunded. All settle outcomes are terminal codes:
  // refunded / already_refunded / no_charge_found.
  if (job.status === 'failed' && job.error_code === 'operator_reconcile_release') {
    return settleReleasedJob(db, jobId, job, { retriedSettlement: true });
  }

  if (!ACTIVE.includes(job.status)) {
    return {
      status: 409,
      body: { ok: false, error: 'job_not_active', message: `job is already ${job.status}`, job: sanitizeJob(job) }
    };
  }

  // A trackable job (has a poll/response URL) is only released once it has
  // been stalled long past submission — see toStuckJob's "trackable_stalled"
  // bucket and the header comment for why submitted_at, not updated_at, is
  // the staleness basis. An untrackable job keeps the original updated_at
  // cutoff. Either way this guards against releasing a job that could still
  // be genuinely in flight.
  const isTrackable = Boolean(job.provider_poll_url || job.provider_response_url);
  const cutoffIso = isTrackable ? trackableStaleCutoffIso() : staleCutoffIso();
  const staleBasisIso = isTrackable ? job.submitted_at : job.updated_at;

  if (!staleBasisIso || Date.parse(staleBasisIso) >= Date.parse(cutoffIso)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'job_not_stale',
        message: isTrackable
          ? `job has provider tracking and was submitted within the last ${TRACKABLE_STALE_MINUTES} min; re-check before releasing`
          : `job was active within the last ${STALE_MINUTES} min; re-check before releasing`,
        job: sanitizeJob(job)
      }
    };
  }

  // A trackable job always needs force=true — it has a fal.ai request id by
  // definition, so the operator must first verify on fal.ai that nothing is
  // actually running before we release it. An untrackable job needs
  // force=true only once it turns out to already be charged and/or carries a
  // request id (ambiguous submit). providerRequestId is returned either way
  // so that fal.ai check is possible from the API alone.
  if (!force && (isTrackable || job.charged_at || job.provider_request_id)) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'force_required',
        message: isTrackable
          ? 'job has provider tracking — verify on fal.ai, then POST again with { "force": true }'
          : 'charged and/or ambiguous-submit job — verify on fal.ai, then POST again with { "force": true }',
        providerRequestId: job.provider_request_id || null,
        charged: Boolean(job.charged_at),
        job: sanitizeJob(job)
      }
    };
  }

  // The claim IS an atomic guarded terminal transition. Doing the status flip
  // and every guard in ONE statement is what makes this race-free without a
  // DB-side change:
  //   - a concurrent /api/h3-live/start that has since charged the job sets
  //     charged_at + bumps updated_at, so (non-force, untrackable path) this
  //     UPDATE matches 0 rows and we abort — the charge/submit proceeds
  //     normally elsewhere;
  //   - if a concurrent /api/h3-live/status completes or fails the job first,
  //     status is no longer ACTIVE, so this UPDATE matches 0 rows too;
  //   - if this UPDATE wins, the row is 'failed', so a concurrent deduct RPC
  //     sees a non-queued status and returns job_not_chargeable instead of
  //     charging;
  //   - a second reconcile call finds status already 'failed' and matches 0
  //     rows too.
  const nowIso = new Date().toISOString();
  let claimQ = db
    .from('h3_live_jobs')
    .update({
      status: 'failed',
      error_code: 'operator_reconcile_release',
      error_message: 'released by api/h3-live/reconcile',
      failed_at: nowIso,
      finished_at: nowIso,
      updated_at: nowIso
    })
    .eq('id', jobId)
    .in('status', ACTIVE);

  if (isTrackable) {
    // Re-check tracking + submitted_at staleness at claim time (not
    // updated_at, which api/h3-live/status.js's poll-claim step may have
    // bumped since we read `job` above). force is already guaranteed true
    // here (checked above), so no provider_request_id/charged_at condition.
    claimQ = claimQ
      .not('provider_poll_url', 'is', null)
      .not('submitted_at', 'is', null)
      .lt('submitted_at', cutoffIso);
  } else {
    claimQ = claimQ
      .is('provider_poll_url', null)
      .is('provider_response_url', null)
      .lt('updated_at', cutoffIso);
    if (!force) {
      // Non-force path only ever releases a fully-unsubmitted, uncharged job.
      claimQ = claimQ.is('provider_request_id', null).is('charged_at', null);
    }
  }

  const { data: flipped, error: flipError } = await claimQ.select('*');

  if (flipError) {
    console.error('[h3-live/reconcile] claim flip error:', flipError.message, 'jobId:', jobId);
    return { status: 503, body: { ok: false, error: 'reconcile_claim_failed' } };
  }
  if (!Array.isArray(flipped) || flipped.length !== 1) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'job_no_longer_stuck',
        message: 'job changed state (charged / tracked / already released); re-list before releasing'
      }
    };
  }
  const claimedJob = flipped[0];

  // Audit: record that an operator flipped this job, whether force was used, and
  // the pre-flip provider state. The DB keeps error_code='operator_reconcile_
  // release'; this line preserves the rest.
  console.warn(
    '[h3-live/reconcile] operator release flip. jobId:', jobId,
    'force:', force,
    'charged:', Boolean(claimedJob.charged_at),
    'providerRequestId:', claimedJob.provider_request_id || null
  );

  return settleReleasedJob(db, jobId, claimedJob, {
    forceApplied: force,
    providerRequestIdAtFlip: claimedJob.provider_request_id || null,
    chargedAtFlip: Boolean(claimedJob.charged_at)
  });
}

module.exports = async function handler(req, res) {
  if (!authenticate(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  if (req.method === 'GET') {
    const result = await listStuck(db);
    if (!result.ok) {
      return res.status(503).json({ ok: false, error: 'reconcile_list_failed', detail: result.error });
    }
    return res.status(200).json({
      ok: true,
      staleMinutes: STALE_MINUTES,
      count: result.jobs.length,
      jobs: result.jobs
    });
  }

  if (req.method === 'POST') {
    const body = jsonBody(req);
    const jobId = String(body.jobId || '').trim();
    if (!isUuid(jobId)) return res.status(400).json({ ok: false, error: 'invalid_job_id' });
    const out = await releaseJob(db, jobId, { force: body.force === true });
    return res.status(out.status).json(out.body);
  }

  return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'GET or POST.' });
};

module.exports._test = { authenticate, STALE_MINUTES, TRACKABLE_STALE_MINUTES };
