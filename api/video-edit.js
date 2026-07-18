// POST /api/video-edit — video editing feature, stage 1 (trim + cut concatenation).
//
// Async task/status pattern mirroring api/seedance-start-priced.js +
// api/seedance-status.js: this endpoint reserves a task + deducts credits
// atomically (reserve_video_edit_task RPC), then calls the Railway
// watermark-server's /edit endpoint SYNCHRONOUSLY (that server already
// implements clip download/trim/concat — see watermark-server/server.js
// app.post('/edit', ...)). /api/video-edit-status.js is the separate
// state-check endpoint the client polls, both for a normal "processing"
// response and to recover if this request's connection drops before the
// Railway call returns.
//
// IMPORTANT — UNCONFIRMED: Vercel's serverless function execution time
// limit for this project (Hobby/Pro plan, vercel.json functions.maxDuration)
// has not been verified as of this writing. Railway's /edit itself budgets
// up to 5 minutes (EDIT_REQUEST_TIMEOUT_MS in watermark-server/server.js);
// measured processing time is up to ~64s for 3 clips and ~127s for 6 clips.
// VIDEO_EDIT_TIMEOUT_MS below is sized for that measured worst case plus
// margin. Regardless of whether Vercel's own limit is shorter than this
// value (in which case Vercel kills the function first, before our own
// AbortController fires), correctness does not depend on this number: if
// this request is killed or its own fetch to Railway times out, the task is
// simply left in 'processing' and recovered later via
// api/_lib/video-edit-reconcile.js (used by both api/video-edit-status.js
// on-demand and the api/video-edit-reconcile.js cron job), which checks for
// the finished file at a path Railway can produce independently of whether
// this request ever returns. This value should still be revisited once
// Vercel's actual limit is confirmed, so a request has the best chance of
// returning the "completed" response directly instead of falling back to
// the async recovery path.
const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { calculateVideoEditCreditCost } = require('./_lib/video-edit-pricing.js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

const MAX_CLIPS = 6;
const MAX_CLIP_DURATION_SECONDS = 30; // mirrors watermark-server EDIT_MAX_CLIP_DURATION_SEC
const MAX_TOTAL_DURATION_SECONDS = 180; // mirrors watermark-server EDIT_MAX_TOTAL_DURATION_SEC
// Measured worst case: ~127s for 6 clips. 180s leaves ~53s margin while
// staying well under Railway's own 5-minute /edit budget. See the module
// header comment above for why correctness doesn't hinge on this value.
const VIDEO_EDIT_TIMEOUT_MS = Number(process.env.VIDEO_EDIT_TIMEOUT_MS) || 180000;
const CLIP_DURATION_TOLERANCE_SECONDS = 1; // rounding/encoding slack when comparing against stored duration_seconds
const CLIENT_REQUEST_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const EDIT_SOURCE_PATH_PREFIX = '/storage/v1/object/public/reference-images/';

function dbClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function isAllowedSourceUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return false; }
  let supabaseHost;
  try { supabaseHost = new URL(SUPABASE_URL).host; } catch (_) { return false; }
  return parsed.protocol === 'https:'
    && parsed.host === supabaseHost
    && parsed.pathname.startsWith(EDIT_SOURCE_PATH_PREFIX);
}

// Validates and normalizes the request body's clips array. Returns
// { ok: true, clips: [{videoId, start, end}], totalDuration } or
// { ok: false, status, body } for the first validation failure found.
function validateClips(rawClips) {
  if (!Array.isArray(rawClips) || rawClips.length < 1 || rawClips.length > MAX_CLIPS) {
    return { ok: false, status: 400, body: { ok: false, error: 'invalid_clips', message: `clipsは1〜${MAX_CLIPS}件の配列で指定してください。` } };
  }

  const clips = [];
  let totalDuration = 0;

  for (let i = 0; i < rawClips.length; i++) {
    const raw = rawClips[i];
    const videoId = String(raw?.videoId || '').trim();
    const start = Number(raw?.start);
    const end = Number(raw?.end);

    if (!videoId) {
      return { ok: false, status: 400, body: { ok: false, error: 'invalid_clip', message: `${i + 1}番目のクリップにvideoIdがありません。` } };
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      return { ok: false, status: 400, body: { ok: false, error: 'invalid_trim_range', message: `${i + 1}番目のクリップのトリム範囲が不正です。` } };
    }
    const duration = end - start;
    if (duration > MAX_CLIP_DURATION_SECONDS) {
      return { ok: false, status: 400, body: { ok: false, error: 'clip_too_long', message: `${i + 1}番目のクリップが長すぎます（最大${MAX_CLIP_DURATION_SECONDS}秒）。` } };
    }

    clips.push({ videoId, start, end });
    totalDuration += duration;
  }

  if (totalDuration > MAX_TOTAL_DURATION_SECONDS) {
    return { ok: false, status: 400, body: { ok: false, error: 'total_duration_too_long', message: `合計尺が長すぎます（最大${MAX_TOTAL_DURATION_SECONDS}秒）。` } };
  }

  return { ok: true, clips, totalDuration };
}

// Resolves each clip's videoId to a completed, owned generation_tasks row's
// storage URL. The browser-supplied videoUrl is never trusted — only the
// videoId is taken from the request, and the URL is looked up server-side.
async function resolveClipSources(db, userId, clips) {
  const videoIds = [...new Set(clips.map((c) => c.videoId))];
  const { data: rows, error } = await db
    .from('generation_tasks')
    .select('id,user_id,status,output_url,watermarked_url,duration_seconds')
    .in('id', videoIds);

  if (error) return { ok: false, status: 500, body: { ok: false, error: 'lookup_failed', message: '動画情報の確認に失敗しました。' } };

  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const resolved = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const row = byId.get(clip.videoId);
    if (!row || row.user_id !== userId || row.status !== 'completed') {
      return { ok: false, status: 404, body: { ok: false, error: 'video_not_found', message: '指定された動画が見つからないか、まだ完了していません。' } };
    }
    const sourceUrl = row.watermarked_url || row.output_url || '';
    if (!isAllowedSourceUrl(sourceUrl)) {
      return { ok: false, status: 422, body: { ok: false, error: 'video_source_unavailable', message: '指定された動画は編集に利用できません。' } };
    }
    // Cross-check the requested trim range against the source video's
    // recorded generation duration (generation_tasks.duration_seconds — the
    // length Seedance was asked to generate, and the closest duration figure
    // available without downloading/probing the file ourselves). A missing
    // or non-positive value means it can't be verified here; Railway's own
    // ffprobe-based check (CLIP_TRIM_INVALID) remains the authoritative
    // guard in that case.
    const sourceDuration = Number(row.duration_seconds);
    if (Number.isFinite(sourceDuration) && sourceDuration > 0 && clip.end > sourceDuration + CLIP_DURATION_TOLERANCE_SECONDS) {
      return { ok: false, status: 400, body: { ok: false, error: 'clip_trim_exceeds_source_duration', message: `${i + 1}番目のクリップのトリム範囲が元動画の長さを超えています。` } };
    }
    resolved.push({ ...clip, sourceUrl });
  }

  return { ok: true, resolved };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const user = auth.user;
  const db = auth.supabase || dbClient();
  if (!db) return res.status(500).json({ ok: false, error: 'SERVER_NOT_CONFIGURED' });

  // Paid-plan gate on server-owned state only. Same approach as the
  // previous version of this file: subscription_expires_at is refreshed by
  // the Stripe webhook (service role) on every paid payment, so a future
  // timestamp means an active paid subscription. Any missing/unreadable
  // state fails closed to 403.
  const { data: bal, error: balError } = await db
    .from('credit_balances')
    .select('free_credits,subscription_credits,purchased_credits,subscription_expires_at,purchased_expires_at')
    .eq('user_id', user.id)
    .maybeSingle();
  const now = new Date();
  const subExpires = bal?.subscription_expires_at ? new Date(bal.subscription_expires_at) : null;
  const hasActiveSubscription = !balError
    && subExpires instanceof Date
    && !Number.isNaN(subExpires.getTime())
    && subExpires > now;
  if (!hasActiveSubscription) {
    return res.status(403).json({
      ok: false,
      error: 'VIDEO_EDIT_REQUIRES_PAID_PLAN',
      message: '動画編集は有料プランで利用できます。',
      upgradeUrl: '/pricing.html?feature=video-edit'
    });
  }

  const railwayBaseUrl = process.env.WATERMARK_SERVER_URL || '';
  const railwaySecret = process.env.WATERMARK_SECRET || '';
  if (!railwayBaseUrl || !railwaySecret) {
    console.error('[video-edit] Missing WATERMARK_SERVER_URL/WATERMARK_SECRET configuration');
    return res.status(500).json({ ok: false, error: 'VIDEO_EDIT_SERVER_NOT_CONFIGURED' });
  }

  const body = jsonBody(req);
  const clientRequestId = String(body.clientRequestId || '').trim();
  if (!CLIENT_REQUEST_ID_RE.test(clientRequestId)) {
    return res.status(400).json({ ok: false, error: 'invalid_client_request_id', message: 'clientRequestIdが不正です。' });
  }

  const rawTransition = body.transition;
  if (rawTransition !== undefined && rawTransition !== null && rawTransition !== 'cut') {
    return res.status(400).json({ ok: false, error: 'unsupported_transition', message: '現在サポートされているtransitionは"cut"のみです。' });
  }

  const clipsCheck = validateClips(body.clips);
  if (!clipsCheck.ok) return res.status(clipsCheck.status).json(clipsCheck.body);
  const { clips, totalDuration } = clipsCheck;

  const sourcesCheck = await resolveClipSources(db, user.id, clips);
  if (!sourcesCheck.ok) return res.status(sourcesCheck.status).json(sourcesCheck.body);
  const resolvedClips = sourcesCheck.resolved;

  let creditCost;
  try {
    creditCost = calculateVideoEditCreditCost({ clipCount: clips.length, totalDurationSeconds: totalDuration });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.code || 'pricing_error', message: err.message });
  }

  const inputManifest = {
    clips: resolvedClips.map((c) => ({ videoId: c.videoId, start: c.start, end: c.end, sourceUrl: c.sourceUrl }))
  };

  let taskId = null;
  let railwayReached = false; // true once we've received *any* HTTP response from Railway

  try {
    // Atomically reserve the task + deduct credits (advisory lock + active
    // check + balance check + INSERT + ledger, all inside one transaction).
    // Idempotent on (user_id, client_request_id): a retried request with the
    // same clientRequestId returns the existing task without charging again
    // or calling Railway a second time.
    const { data: reserveRows, error: reserveErr } = await db.rpc('reserve_video_edit_task', {
      p_user_id: user.id,
      p_client_request_id: clientRequestId,
      p_credit_cost: creditCost,
      p_input_manifest: inputManifest,
      p_transition: 'cut',
      p_clip_count: clips.length,
      p_requested_output_duration: totalDuration
    });

    if (reserveErr) {
      console.error('[video-edit] reserve_video_edit_task RPC error:', reserveErr.message);
      return res.status(500).json({ ok: false, error: 'タスクの作成に失敗しました。もう一度お試しください。' });
    }

    const reserveRow = Array.isArray(reserveRows) ? reserveRows[0] : reserveRows;
    if (!reserveRow) {
      console.error('[video-edit] reserve_video_edit_task: no row returned');
      return res.status(500).json({ ok: false, error: 'タスクの作成に失敗しました。もう一度お試しください。' });
    }

    if (reserveRow.rejection_reason === 'active_edit') {
      return res.status(409).json({ ok: false, error: 'video_edit_already_in_progress', message: '現在処理中の動画編集があります。完了後にもう一度お試しください。' });
    }
    if (reserveRow.rejection_reason === 'insufficient_credits') {
      return res.status(402).json({ ok: false, error: 'insufficient_credits', message: `クレジット不足です（必要: ${creditCost}）`, required: creditCost });
    }

    taskId = reserveRow.task_id;
    if (!taskId) {
      console.error('[video-edit] reserve_video_edit_task: no task_id and no rejection_reason');
      return res.status(500).json({ ok: false, error: 'タスクの作成に失敗しました。もう一度お試しください。' });
    }

    if (reserveRow.existing) {
      // Idempotent replay of an already-submitted clientRequestId. Do not
      // call Railway again — just report the task's current state.
      const { data: existingTask } = await db
        .from('video_edit_tasks')
        .select('status,edited_url,actual_output_duration,credit_cost')
        .eq('id', taskId)
        .maybeSingle();
      return res.status(200).json({
        ok: true,
        taskId,
        status: existingTask?.status || 'queued',
        editedUrl: existingTask?.status === 'completed' ? (existingTask?.edited_url || null) : null,
        actualOutputDuration: existingTask?.actual_output_duration ?? null,
        creditCost: existingTask?.credit_cost ?? creditCost,
        duplicate: true
      });
    }

    await db.from('video_edit_tasks')
      .update({ status: 'processing', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', taskId)
      .eq('status', 'queued');

    const railwayPayload = {
      clips: resolvedClips.map((c) => ({ videoUrl: c.sourceUrl, start: c.start, end: c.end })),
      transition: 'cut',
      userId: user.id,
      // Deterministic Storage output path (edited/<userId>/<taskId>.mp4 on
      // the Railway side — see watermark-server/server.js's outputId
      // handling). Lets api/_lib/video-edit-reconcile.js find the finished
      // file even if this request never gets a response back from Railway.
      taskId
    };

    let railwayResponse, railwayText, railwayData;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VIDEO_EDIT_TIMEOUT_MS);
    try {
      railwayResponse = await fetch(`${railwayBaseUrl.replace(/\/+$/, '')}/edit`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${railwaySecret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(railwayPayload),
        signal: controller.signal
      });
      railwayReached = true;
      railwayText = await railwayResponse.text();
      try { railwayData = railwayText ? JSON.parse(railwayText) : null; } catch (_) { railwayData = null; }
    } finally {
      clearTimeout(timer);
    }

    if (!railwayResponse.ok || !railwayData || railwayData.ok !== true || !railwayData.editedUrl) {
      // Railway gave us a definite (non-success) HTTP response — safe to
      // refund now rather than waiting.
      const errMsg = (railwayData && typeof railwayData.error === 'string') ? railwayData.error : `HTTP ${railwayResponse.status}`;
      console.error('[video-edit] Railway /edit failed:', railwayResponse.status, errMsg, 'taskId:', taskId);

      await db.from('video_edit_tasks')
        .update({ railway_error_code: errMsg.slice(0, 200), updated_at: new Date().toISOString() })
        .eq('id', taskId);

      const { data: refundRows } = await db.rpc('refund_video_edit_task', { p_task_id: taskId, p_failure_code: 'railway_error' });
      const refundRow = Array.isArray(refundRows) ? refundRows[0] : refundRows;
      const refunded = Boolean(refundRow?.ok);

      return res.status(502).json({
        ok: false,
        error: '動画編集に失敗しました。',
        detail: errMsg,
        taskId,
        refunded,
        creditRefunded: refunded ? creditCost : 0
      });
    }

    const editedUrl = String(railwayData.editedUrl);
    const actualDuration = Number(railwayData.duration);

    const { data: completedRows, error: completeErr } = await db
      .from('video_edit_tasks')
      .update({
        status: 'completed',
        edited_url: editedUrl,
        actual_output_duration: Number.isFinite(actualDuration) ? actualDuration : totalDuration,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .eq('status', 'processing')
      .select('id');

    if (completeErr || !completedRows || completedRows.length === 0) {
      // Railway succeeded and credits were already spent; the task row just
      // failed to record completion. Log loudly — /api/video-edit-status.js
      // will still report whatever status the row is actually in, and this
      // is surfaced to the client as a success since the edit itself worked.
      console.error('[video-edit] ORPHAN: edit succeeded but completion persist failed, taskId:', taskId, completeErr?.message);
    }

    return res.status(200).json({
      ok: true,
      taskId,
      status: 'completed',
      editedUrl,
      actualOutputDuration: Number.isFinite(actualDuration) ? actualDuration : totalDuration,
      creditCost
    });
  } catch (error) {
    console.error('[video-edit] unexpected error:', error?.message, 'taskId:', taskId, 'railwayReached:', railwayReached);

    if (taskId && !railwayReached) {
      // We reserved the task and deducted credits, but never got a response
      // from Railway (including our own timeout/AbortController firing) —
      // this is exactly the "unclear disconnect" case the task description
      // calls out: do NOT refund here. Leave the task in 'processing' so
      // /api/video-edit-status.js can be polled later to resolve it.
      return res.status(202).json({
        ok: true,
        taskId,
        status: 'processing',
        message: '処理に時間がかかっています。しばらくしてから状態をご確認ください。',
        creditCost
      });
    }

    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', taskId });
  }
};
