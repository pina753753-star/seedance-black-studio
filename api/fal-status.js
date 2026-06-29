'use strict';
/**
 * GET /api/fal-status?taskId={taskId}
 *
 * Returns the current status of a fal.ai generation task.
 *
 * done:true conditions (fal tasks):
 *   status=completed AND watermarked_url is a valid Supabase URL
 *   (watermarked_url is always set when status=completed — either Railway-watermarked
 *    for free users, or a copy of output_url for paid users / no-watermark-server)
 *
 * done:false cases:
 *   - status=queued or processing (watermark pending or not yet started)
 *   - status=completed but watermarked_url missing (legacy task; reconcile will fix)
 *   - reconcile_attempts >= MAX (manual review needed; still shown as "processing" to user)
 *
 * Never returns fal CDN URLs or raw output_url as the final videoUrl.
 * Fallback: if polling_url is set (user is watching), calls finalizeTask inline.
 */

const { createClient } = require('@supabase/supabase-js');
const { finalizeTask, isSupabasePublicUrl, MAX_RECONCILE_ATTEMPTS } = require('./_lib/fal-finalize');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function bearerToken(req) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

async function getUserFromToken(token) {
  if (!token) return null;
  const db = serviceClient();
  if (!db) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch (_) { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const taskId = String(req.query.taskId || '').trim();
  if (!taskId) return res.status(400).json({ ok: false, error: 'taskId is required' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  try {
    const { data: task, error } = await db.from('generation_tasks')
      .select('id,user_id,status,output_url,watermarked_url,polling_url,error_message,api_provider,api_task_id,settings')
      .eq('id', taskId)
      .eq('user_id', user.id)
      .eq('api_provider', 'fal')
      .maybeSingle();

    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!task) return res.status(404).json({ ok: false, error: 'task_not_found' });

    // ── Completed with watermarked_url → done:true ────────────────────────────
    // watermarked_url is set for both free users (Railway watermark) and paid users
    // (output_url copy). This is the only path to done:true for fal tasks.
    if (task.status === 'completed' && task.watermarked_url && isSupabasePublicUrl(task.watermarked_url)) {
      return res.status(200).json({
        ok: true, done: true, status: 'completed',
        videoUrl: task.watermarked_url, taskId
      });
    }

    // ── Completed but watermarked_url missing (legacy / race condition) ────────
    // Do not return done:true. Reconcile cron will apply watermark and set watermarked_url.
    if (task.status === 'completed') {
      return res.status(200).json({ ok: true, done: false, status: 'processing', taskId });
    }

    // ── Failed / Cancelled ────────────────────────────────────────────────────
    if (task.status === 'failed' || task.status === 'cancelled') {
      let refunded = false;
      try {
        const { data: txs } = await db.from('credit_transactions')
          .select('id').eq('related_task_id', taskId).eq('reason', 'generation_refund').limit(1);
        refunded = Boolean(txs && txs.length > 0);
      } catch (_) {}
      return res.status(200).json({
        ok: false, done: true, failed: true, status: task.status,
        message: '動画生成に失敗しました。', refunded, taskId
      });
    }

    // ── Queued / Processing: check if at attempt limit (needs manual review) ──
    const settings = (task.settings && typeof task.settings === 'object') ? task.settings : {};
    const attempts = Number(settings.reconcile_attempts || 0);
    if (attempts >= MAX_RECONCILE_ATTEMPTS) {
      // Keep user-visible status as "processing" — do not expose internal error details
      console.warn('[fal-status] task at max attempts, needs review, taskId:', taskId);
      return res.status(200).json({ ok: true, done: false, status: 'processing', taskId });
    }

    // ── Queued / Processing: inline finalize if polling_url is set ────────────
    // Triggered when user is watching and webhook has fired; avoids waiting for next cron.
    if (task.polling_url && !isSupabasePublicUrl(task.polling_url)) {
      console.log('[fal-status] fal CDN URL found, finalizing inline, taskId:', taskId);
      const result = await finalizeTask(db, task);

      if (result.ok) {
        // Re-fetch to get the updated watermarked_url
        const { data: updated } = await db.from('generation_tasks')
          .select('watermarked_url')
          .eq('id', task.id)
          .maybeSingle();
        if (updated?.watermarked_url && isSupabasePublicUrl(updated.watermarked_url)) {
          return res.status(200).json({
            ok: true, done: true, status: 'completed',
            videoUrl: updated.watermarked_url, taskId
          });
        }
      }
      // Finalize returned ok:false (watermark failed or upload failed) — client retries
      console.warn('[fal-status] inline finalize not yet complete, returning done:false, taskId:', taskId);
      return res.status(200).json({ ok: true, done: false, status: 'processing', taskId });
    }

    // ── Still waiting for webhook or watermark ─────────────────────────────────
    return res.status(200).json({ ok: true, done: false, status: task.status || 'queued', taskId });
  } catch (err) {
    console.error('[fal-status] error:', err?.message, 'taskId:', taskId);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
