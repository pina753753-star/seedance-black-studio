'use strict';

// Temporary, bounded Preview-only diagnostic. Never merge to main.
// No credential/auth override and no independent debit or worker request.
const EXPIRES_AT = Date.parse('2026-10-23T05:20:00Z');
const BRANCH = 'verify/pina-worker-auth-20261023';
const HOST = 'flowvid-studio-git-verify-pina-worker-au-4f7aef-pina-s-projects.vercel.app';
const CLIENT_REQUEST_ID = 'pina-recovery-edit-20261023-v1';
const MAX_COST = 10;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 10;
const MAX_HEAD_ATTEMPTS = 3;
const HEAD_TIMEOUT_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_ERRORS = new Set([
  'METHOD_NOT_ALLOWED', 'UNAUTHORIZED', 'EMAIL_NOT_CONFIRMED',
  'SERVER_NOT_CONFIGURED', 'VIDEO_EDIT_REQUIRES_PAID_PLAN',
  'VIDEO_EDIT_SERVER_NOT_CONFIGURED', 'GENERATION_EMERGENCY_STOP',
  'GENERATION_CONTROL_UNAVAILABLE', 'generation_emergency_stop',
  'video_not_found', 'video_source_unavailable', 'lookup_failed',
  'clip_trim_exceeds_source_duration', 'video_edit_already_in_progress',
  'insufficient_credits'
]);

function fixedBody(videoId) {
  return {
    clientRequestId: CLIENT_REQUEST_ID,
    clips: [{ videoId, start: 0, end: 1 }],
    transition: 'cut'
  };
}

function isAllowedOutput(value, taskId, userId, storageOrigin) {
  if (typeof value !== 'string' || !UUID.test(taskId || '') || !UUID.test(userId || '') || !storageOrigin) return false;
  try {
    const url = new URL(value);
    return url.origin === storageOrigin && url.protocol === 'https:'
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === `/storage/v1/object/public/reference-images/edited/${userId}/${taskId}.mp4`;
  } catch (_) { return false; }
}

function safeResult(body, userId, storageOrigin) {
  const output = { ok: body?.ok === true };
  if (UUID.test(body?.taskId || '')) output.taskId = body.taskId;
  if (['queued', 'processing', 'completed', 'failed'].includes(body?.status)) output.status = body.status;
  for (const key of ['duplicate', 'refunded']) {
    if (typeof body?.[key] === 'boolean') output[key] = body[key];
  }
  for (const key of ['creditCost', 'creditRefunded', 'required', 'actualOutputDuration']) {
    if (typeof body?.[key] === 'number' && Number.isFinite(body[key]) && body[key] >= 0) output[key] = body[key];
  }
  if (!output.ok) output.error = SAFE_ERRORS.has(body?.error) ? body.error : 'EDIT_FAILED_DO_NOT_RETRY';
  if (output.ok && output.status === 'completed') {
    if (isAllowedOutput(body?.editedUrl, output.taskId, userId, storageOrigin)) output.editedUrl = body.editedUrl;
    else output.outputUnavailable = true;
  }
  // Never expose core error details, request headers, tokens or source URLs.
  return output;
}

function emptyBody(body) {
  return body === undefined || body === null
    || (typeof body === 'object' && !Array.isArray(body)
      && (Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null)
      && Reflect.ownKeys(body).length === 0);
}

function storageOriginFromEnv(env) {
  try {
    const url = new URL(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '');
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    return url.origin;
  } catch (_) { return null; }
}

function allowedSource(value, storageOrigin) {
  try {
    const url = new URL(value);
    return url.origin === storageOrigin && url.protocol === 'https:'
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith('/storage/v1/object/public/reference-images/');
  } catch (_) { return false; }
}

async function availableSource(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { method: 'HEAD', redirect: 'error', signal: controller.signal });
    const rawLength = response.headers.get('content-length') || '';
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    return !controller.signal.aborted && response.status === 200 && !response.redirected && /^\d+$/.test(rawLength)
      && Number(rawLength) > 0 && Number(rawLength) <= MAX_SOURCE_BYTES && type === 'video/mp4';
  } catch (_) { return false; }
  finally {
    clearTimeout(timer);
    controller.abort();
    try { if (response?.body) Promise.resolve(response.body.cancel()).catch(() => {}); } catch (_) {}
  }
}

async function selectSource(db, userId, storageOrigin, fetchImpl, enabled) {
  const { data, error } = await db.from('generation_tasks')
    .select('id,user_id,status,output_url,watermarked_url,duration_seconds,created_at')
    .eq('user_id', userId).eq('status', 'completed')
    .gte('duration_seconds', 1).lte('duration_seconds', 4)
    .order('duration_seconds', { ascending: true })
    .order('created_at', { ascending: false }).order('id', { ascending: true })
    .limit(MAX_CANDIDATES);
  if (error) return { error: 'SOURCE_LOOKUP_FAILED' };
  let attempted = 0;
  for (const row of (Array.isArray(data) ? data : []).slice(0, MAX_CANDIDATES)) {
    if (!enabled()) return { error: 'PROBE_DISABLED' };
    const duration = Number(row.duration_seconds);
    const sourceUrl = row.watermarked_url || row.output_url || '';
    if (!UUID.test(row.id || '') || row.user_id !== userId || row.status !== 'completed'
      || !Number.isFinite(duration) || duration < 1 || duration > 4 || !allowedSource(sourceUrl, storageOrigin)) continue;
    if (attempted >= MAX_HEAD_ATTEMPTS) break;
    attempted++;
    if (await availableSource(sourceUrl, fetchImpl)) return { videoId: row.id };
  }
  return { error: 'SOURCE_UNAVAILABLE' };
}

function compatibleExisting(row, userId, storageOrigin) {
  const clips = row.input_manifest?.clips;
  return row.user_id === userId && UUID.test(row.id || '') && row.credit_cost === MAX_COST
    && row.transition === 'cut' && row.clip_count === 1 && Number(row.requested_output_duration) === 1
    && Array.isArray(clips) && clips.length === 1 && UUID.test(clips[0]?.videoId || '')
    && clips[0].start === 0 && clips[0].end === 1 && allowedSource(clips[0].sourceUrl, storageOrigin);
}

function createHandler(deps = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const env = deps.env || process.env;
    const now = deps.now || Date.now;
    const reply = (status, error) => res.status(status).json({ ok: false, error });
    const enabled = () => {
      const time = now();
      return env.VERCEL_ENV === 'preview' && env.VERCEL_GIT_COMMIT_REF === BRANCH
        && Number.isFinite(time) && time < EXPIRES_AT;
    };
    if (!enabled()) return reply(410, 'PROBE_DISABLED');
    if (req.method !== 'POST') return reply(405, 'METHOD_NOT_ALLOWED');
    if (req.headers?.host !== HOST || req.headers?.origin !== `https://${HOST}`
      || (req.headers?.['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return reply(403, 'ORIGIN_REJECTED');
    }
    if (!emptyBody(req.body) || (req.query && Object.keys(req.query).length)) {
      return reply(400, 'EMPTY_BODY_REQUIRED');
    }

    try {
      const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
      const storageOrigin = storageOriginFromEnv(env);
      if (!adminEmail || !storageOrigin) return reply(503, 'PROBE_NOT_CONFIGURED');
      const requireAuth = deps.requireAuth || require('./_lib/confirmed-auth.js').requireConfirmedAuth;
      const auth = await requireAuth(req);
      if (!auth?.ok) return reply(401, 'UNAUTHORIZED');
      const userId = auth.user?.id;
      if (!UUID.test(userId || '') || String(auth.user.email || '').trim().toLowerCase() !== adminEmail || !auth.supabase) {
        return reply(403, 'ADMIN_REQUIRED');
      }
      const db = auth.supabase;
      const { data, error } = await db.from('profiles').select('id,email,role')
        .eq('id', userId).maybeSingle();
      if (error || data?.id !== userId || data?.role !== 'admin'
        || String(data.email || '').trim().toLowerCase() !== adminEmail) {
        return reply(403, 'ADMIN_REQUIRED');
      }
      // A replay must use the original task, never reselect a different source.
      const { data: existing, error: existingError } = await db.from('video_edit_tasks')
        .select('id,user_id,status,edited_url,actual_output_duration,credit_cost,input_manifest,transition,clip_count,requested_output_duration')
        .eq('user_id', userId).eq('client_request_id', CLIENT_REQUEST_ID).maybeSingle();
      if (existingError) return reply(503, 'EXISTING_TASK_LOOKUP_FAILED');
      if (!enabled()) return reply(410, 'PROBE_DISABLED');
      if (existing) {
        if (!compatibleExisting(existing, userId, storageOrigin)) return reply(409, 'EXISTING_TASK_MISMATCH');
        return res.status(200).json(safeResult({
          ok: true, taskId: existing.id, status: existing.status,
          editedUrl: existing.status === 'completed' ? existing.edited_url : null,
          actualOutputDuration: existing.actual_output_duration,
          creditCost: existing.credit_cost, duplicate: true
        }, userId, storageOrigin));
      }

      const calculateCost = deps.calculateCost || require('./_lib/video-edit-pricing.js').calculateVideoEditCreditCost;
      let cost;
      try { cost = calculateCost({ clipCount: 1, totalDurationSeconds: 1 }); }
      catch (_) { return reply(503, 'CREDIT_COST_CHANGED'); }
      if (cost !== MAX_COST) return reply(503, 'CREDIT_COST_CHANGED');
      const source = await selectSource(db, userId, storageOrigin, deps.fetch || fetch, enabled);
      if (!enabled() || source.error === 'PROBE_DISABLED') return reply(410, 'PROBE_DISABLED');
      if (source.error) return reply(503, source.error);
      const edit = deps.edit || require('./video-edit.js');
      const coreReq = Object.create(req);
      coreReq.body = fixedBody(source.videoId);
      let statusCode = 200;
      const coreRes = {
        status(code) { statusCode = Number.isInteger(code) && code >= 100 && code <= 599 ? code : 500; return this; },
        json(body) { return res.status(statusCode).json(safeResult(body, userId, storageOrigin)); }
      };
      // Core reauthenticates and preserves ownership, plan, emergency-stop,
      // pricing, reservation, refund and storage controls. The selected source
      // is persisted only in the existing RPC's input manifest. Concurrent
      // selections may differ; the RPC's unique (user_id, client_request_id)
      // and advisory transaction lock select ONE task before any worker call.
      // This wrapper is not an atomic lock. Never rotate the fixed request ID.
      return await edit(coreReq, coreRes);
    } catch (_) {
      return reply(502, 'EDIT_RESULT_UNKNOWN_DO_NOT_RETRY');
    }
  };
}

module.exports = createHandler();
module.exports._test = {
  createHandler, safeResult, isAllowedOutput, fixedBody, storageOriginFromEnv,
  allowedSource, availableSource, selectSource, compatibleExisting,
  EXPIRES_AT, BRANCH, HOST, CLIENT_REQUEST_ID, MAX_COST,
  MAX_SOURCE_BYTES, MAX_CANDIDATES, MAX_HEAD_ATTEMPTS, HEAD_TIMEOUT_MS
};
