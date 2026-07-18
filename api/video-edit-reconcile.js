'use strict';
/**
 * GET /api/video-edit-reconcile
 *
 * Background reconciliation for video_edit_tasks stuck in 'processing' with
 * no client ever polling api/video-edit-status.js to resolve them (browser
 * closed, app backgrounded, etc — mirrors api/openrouter-reconcile.js's
 * rationale for generation_tasks). Delegates the actual
 * complete-or-refund decision to api/_lib/video-edit-reconcile.js, the same
 * logic api/video-edit-status.js uses for on-demand checks, so both paths
 * agree on when a task is stale and never double-refund (guarded by
 * refund_video_edit_task's refunded_at check).
 *
 * Runs as a Vercel Cron job (see vercel.json). Requires CRON_SECRET, same
 * auth pattern as api/openrouter-reconcile.js.
 */

const { createClient } = require('@supabase/supabase-js');
const { reconcileVideoEditTask } = require('./_lib/video-edit-reconcile.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

const MAX_PER_RUN = 20;

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function authenticate(req) {
  if (!CRON_SECRET) return false; // safe default: reject all if secret not configured
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  return auth.slice(7).trim() === CRON_SECRET;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!authenticate(req)) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const db = serviceClient();
  if (!db) {
    return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });
  }

  const startedAt = Date.now();
  const results = { checked: 0, completed: 0, refunded: 0, still_processing: 0, errors: [] };

  try {
    const { data: processingTasks, error: fetchErr } = await db
      .from('video_edit_tasks')
      .select('id,user_id,status,requested_output_duration,actual_output_duration,created_at,started_at')
      .eq('status', 'processing')
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (fetchErr) {
      console.error('[video-edit-reconcile] fetch error:', fetchErr.message);
      return res.status(500).json({ ok: false, error: fetchErr.message });
    }

    console.log(`[video-edit-reconcile] found ${(processingTasks || []).length} processing task(s)`);

    for (const task of processingTasks || []) {
      results.checked++;
      try {
        const outcome = await reconcileVideoEditTask(db, task);
        if (outcome.status === 'completed') results.completed++;
        else if (outcome.status === 'failed') results.refunded++;
        else results.still_processing++;
      } catch (err) {
        results.errors.push({ taskId: task.id, error: err?.message || String(err) });
      }
    }

    const elapsed = Date.now() - startedAt;
    console.log(`[video-edit-reconcile] done in ${elapsed}ms`, JSON.stringify(results));

    return res.status(200).json({
      ok: true,
      elapsed_ms: elapsed,
      ...results,
      ...(results.errors.length > 0 ? { errors: results.errors } : {})
    });
  } catch (err) {
    console.error('[video-edit-reconcile] unexpected error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
