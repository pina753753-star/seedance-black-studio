'use strict';

/**
 * GET /api/wavespeed-reconcile
 *
 * Completes or refunds WaveSpeed Seedance 2.5 1080p tasks when the browser
 * poller is no longer running. It intentionally selects only api_provider =
 * 'wavespeed'; OpenRouter remains owned by api/openrouter-reconcile.js.
 */

const { createClient } = require('@supabase/supabase-js');
const statusHandler = require('./seedance-status.js');

const {
  findVideoUrl,
  normalizeStatus,
  isCompletedStatus,
  isFailedStatus,
  persistVideo,
  processFinalCredits,
  processRefundIfNeeded,
  recordWatermarkWait,
  isResultWaitExpired,
  validWatermarkUrl
} = statusHandler._reconcileHelpers;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const WAVESPEED_API_KEY = process.env.WAVESPEED_API_KEY || '';
const WAVESPEED_RESULT_BASE = 'https://api.wavespeed.ai/api/v3/predictions';
const MAX_PER_RUN = 5;
const ORPHAN_REFUND_AFTER_MS = 2 * 60 * 60 * 1000;

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function authenticate(req) {
  if (!CRON_SECRET) return false;
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  return auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === CRON_SECRET;
}

async function applyWatermark(db, task, videoUrl) {
  let error = null;
  try {
    const response = await fetch(`${process.env.WATERMARK_SERVER_URL}/watermark`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WATERMARK_SECRET || ''}`
      },
      body: JSON.stringify({ videoUrl, jobId: task.api_task_id })
    });
    if (response.ok) {
      const data = await response.json();
      const watermarkedUrl = validWatermarkUrl(data?.watermarkedUrl || '');
      if (watermarkedUrl) return { ok: true, watermarkedUrl };
      error = 'invalid_watermark_url';
    } else {
      error = `wm_http_${response.status}`;
    }
  } catch (caught) {
    error = caught?.message || String(caught);
  }

  const wait = await recordWatermarkWait(db, task.api_task_id, error).catch(() => ({ state: 'db_error' }));
  if (wait.state === 'ok' && isResultWaitExpired(wait.wait)) {
    const refund = await processRefundIfNeeded(db, task.api_task_id, 'failed', `watermark-failed:${String(error).slice(0, 150)}`);
    return { ok: false, final: refund.confirmed, refunded: refund.refunded, error };
  }
  return { ok: false, final: false, refunded: false, error };
}

async function reconcileTask(db, task) {
  if (!task.api_task_id) {
    const age = Date.now() - new Date(task.created_at).getTime();
    if (Number.isFinite(age) && age >= ORPHAN_REFUND_AFTER_MS) {
      const refund = await db.rpc('refund_generation_task_atomic', {
        p_task_id: task.id,
        p_error_message: 'wavespeed task orphaned: tracking never persisted'
      });
      return !refund.error && refund.data?.ok === true
        ? { state: 'failed', refunded: ['refunded', 'already_refunded'].includes(refund.data.code) }
        : { state: 'error', error: refund.error?.message || refund.data?.code || 'refund_failed' };
    }
    return { state: 'processing' };
  }

  const statusUrl = `${WAVESPEED_RESULT_BASE}/${encodeURIComponent(task.api_task_id)}/result`;
  let response;
  let data;
  try {
    response = await fetch(statusUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${WAVESPEED_API_KEY}`, 'Content-Type': 'application/json' }
    });
    const text = await response.text();
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  } catch (error) {
    return { state: 'retry', error: error?.message || String(error) };
  }

  if (!response.ok) return { state: 'retry', error: `wavespeed_http_${response.status}` };

  const status = normalizeStatus(data);
  if (isFailedStatus(status, 'wavespeed')) {
    const message = data && typeof data === 'object'
      ? (data.error || data.message || JSON.stringify(data).slice(0, 200))
      : String(data || '').slice(0, 200);
    const refund = await processRefundIfNeeded(db, task.api_task_id, 'failed', message);
    return { state: 'failed', refunded: refund.refunded, refundConfirmed: refund.confirmed };
  }
  if (!isCompletedStatus(status, 'wavespeed')) return { state: 'processing', providerStatus: status };

  const rawVideoUrl = findVideoUrl(data);
  if (!rawVideoUrl) return { state: 'processing', providerStatus: status, resultPending: true };
  const storage = await persistVideo({ jobId: task.api_task_id, videoUrl: rawVideoUrl, apiKey: WAVESPEED_API_KEY });
  if (!storage?.ok || !storage.videoUrl) return { state: 'retry', error: storage?.error || 'video_persist_failed' };

  const PAID_PLANS = ['standard', 'premium', 'ultimate', 'team', 'scale'];
  const { data: profile } = await db.from('profiles').select('plan').eq('id', task.user_id).maybeSingle();
  const isFreeUser = !profile || !PAID_PLANS.includes(profile.plan);
  let responseVideoUrl = storage.videoUrl;

  if (isFreeUser) {
    const watermark = await applyWatermark(db, task, storage.videoUrl);
    if (!watermark.ok) return watermark.final
      ? { state: 'failed', refunded: watermark.refunded }
      : { state: 'processing', watermarkPending: true };
    responseVideoUrl = watermark.watermarkedUrl;
  }

  const completed = await processFinalCredits(db, task.api_task_id, null, storage.videoUrl);
  if (!completed) {
    const { data: currentTask, error: currentTaskError } = await db.from('generation_tasks')
      .select('status')
      .eq('id', task.id)
      .maybeSingle();
    if (!currentTaskError && currentTask?.status === 'completed') return { state: 'already_settled' };
    return { state: 'retry', error: currentTaskError?.message || 'completion_not_persisted' };
  }
  if (isFreeUser) {
    await db.from('generation_tasks').update({
      watermarked_url: responseVideoUrl,
      updated_at: new Date().toISOString()
    }).eq('id', task.id).eq('status', 'completed');
  }
  return { state: 'completed' };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!authenticate(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  if (!WAVESPEED_API_KEY) return res.status(500).json({ ok: false, error: 'Missing WAVESPEED_API_KEY' });
  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  const { data: tasks, error } = await db.from('generation_tasks')
    .select('id,user_id,status,api_task_id,polling_url,created_at')
    .eq('api_provider', 'wavespeed')
    .in('status', ['queued', 'processing'])
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const results = { checked: 0, completed: 0, failed: 0, processing: 0, errors: [] };
  for (const task of tasks || []) {
    results.checked++;
    const outcome = await reconcileTask(db, task).catch((caught) => ({ state: 'error', error: caught?.message || String(caught) }));
    if (outcome.state === 'completed' || outcome.state === 'already_settled') results.completed++;
    else if (outcome.state === 'failed') results.failed++;
    else if (outcome.state === 'error' || outcome.state === 'retry') results.errors.push({ taskId: task.id, error: outcome.error });
    else results.processing++;
  }
  return res.status(200).json({ ok: true, ...results });
}

module.exports = handler;
module.exports._test = { authenticate, reconcileTask };
