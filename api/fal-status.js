'use strict';
/**
 * GET /api/fal-status?taskId={taskId}
 *
 * Returns the current status of a fal.ai generation task.
 * Primary role: read DB state and return it to the frontend.
 *
 * Fallback role: if a fal CDN URL is in polling_url (webhook fired but user is watching),
 * triggers download+upload+watermark inline so the user sees a result immediately
 * without waiting for the next cron run. This path is idempotent and safe to run
 * concurrently with fal-reconcile.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { finalizeTask, isSupabasePublicUrl, validVideoUrl } = require('./lib/fal-finalize');

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

    // ── Completed ─────────────────────────────────────────────────────────────
    if (task.status === 'completed') {
      if (task.watermarked_url && isSupabasePublicUrl(task.watermarked_url)) {
        return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl: task.watermarked_url, taskId });
      }
      if (task.output_url && isSupabasePublicUrl(task.output_url)) {
        return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl: task.output_url, taskId });
      }
      // Completed but no persistent URL — fall through to try finalizing
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

    // ── Queued / Processing: check for fal CDN URL in polling_url ─────────────
    // If webhook has fired and fal CDN URL is available, finalize inline
    // (fallback for when user is watching; reconcile cron handles the background case).
    if (task.polling_url && !isSupabasePublicUrl(task.polling_url)) {
      console.log('[fal-status] fal CDN URL found, finalizing inline, taskId:', taskId);
      const result = await finalizeTask(db, task);

      if (result.ok) {
        // Re-fetch to get the updated URLs
        const { data: updated } = await db.from('generation_tasks')
          .select('output_url,watermarked_url')
          .eq('id', task.id)
          .maybeSingle();
        const videoUrl = (updated?.watermarked_url && isSupabasePublicUrl(updated.watermarked_url))
          ? updated.watermarked_url
          : (updated?.output_url && isSupabasePublicUrl(updated.output_url) ? updated.output_url : null);
        if (videoUrl) {
          return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl, taskId });
        }
      }
      // Finalize failed — return done:false so client retries (reconcile will pick it up)
      console.warn('[fal-status] inline finalize failed, returning done:false, taskId:', taskId);
      return res.status(200).json({ ok: true, done: false, status: 'processing', taskId });
    }

    // ── No fal CDN URL yet — still waiting for webhook ────────────────────────
    return res.status(200).json({ ok: true, done: false, status: task.status || 'queued', taskId });
  } catch (err) {
    console.error('[fal-status] error:', err?.message, 'taskId:', taskId);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
