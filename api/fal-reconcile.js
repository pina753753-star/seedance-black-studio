'use strict';
/**
 * GET /api/fal-reconcile
 *
 * Background reconciliation for fal.ai tasks that haven't been fully processed.
 * Runs as a Vercel Cron job every 5 minutes (requires Pro plan + CRON_SECRET env var).
 *
 * Authentication:
 *   Requires Authorization: Bearer {CRON_SECRET}. Rejects all requests if CRON_SECRET
 *   is not set (safe default — nobody can trigger processing without the secret).
 *   Vercel sets this header automatically on cron-triggered requests.
 *
 * Processing phases (up to MAX_PER_RUN = 5 tasks total):
 *   Phase A: tasks with polling_url (fal CDN URL) — full pipeline (download→upload→watermark→complete)
 *   Phase B: tasks with output_url (Supabase) but no watermarked_url — watermark retry only
 *   Phase C: legacy completed tasks missing watermarked_url — watermark apply only
 *   Stale:   tasks with no polling_url stuck >2h — log warning only, never auto-fail
 *
 * Safety:
 *   - Never auto-fails, auto-refunds, or calls fal/OpenRouter real APIs.
 *   - Watermark failure keeps status=processing; retry on next cron run.
 *   - MAX_RECONCILE_ATTEMPTS (5) prevents infinite retry on permanently broken tasks.
 *   - Tasks at max attempts stay in processing for manual review (needs_review count).
 */

const { createClient } = require('@supabase/supabase-js');
const { finalizeTask, isSupabasePublicUrl, MAX_RECONCILE_ATTEMPTS } = require('./lib/fal-finalize');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

const MAX_PER_RUN = 5;
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

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

async function processTasks(db, tasks, results) {
  for (const task of tasks) {
    if (results.processed >= MAX_PER_RUN) break;
    results.processed++;
    try {
      const result = await finalizeTask(db, task);
      if (result.reason === 'max_attempts_reached') {
        results.needs_review++;
      } else if (result.ok) {
        results.succeeded++;
      } else if (result.skipped) {
        results.skipped++;
      } else {
        results.retryable++;
        if (result.error) results.errors.push({ taskId: task.id, error: result.error });
      }
    } catch (e) {
      results.retryable++;
      results.errors.push({ taskId: task.id, error: e?.message || String(e) });
      console.error('[fal-reconcile] task exception, taskId:', task.id, e?.message);
    }
  }
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
  const results = {
    processed: 0, succeeded: 0, retryable: 0, skipped: 0,
    needs_review: 0, stale: 0, errors: []
  };

  try {
    // ── Phase A: tasks with fal CDN URL in polling_url (full pipeline) ──────────
    const { data: phaseATasks, error: fetchErrA } = await db.from('generation_tasks')
      .select('id,user_id,status,output_url,watermarked_url,polling_url,api_task_id,settings')
      .eq('api_provider', 'fal')
      .in('status', ['queued', 'processing'])
      .not('polling_url', 'is', null)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (fetchErrA) {
      console.error('[fal-reconcile] Phase A fetch error:', fetchErrA.message);
      return res.status(500).json({ ok: false, error: fetchErrA.message });
    }
    console.log(`[fal-reconcile] Phase A: ${(phaseATasks || []).length} tasks`);
    await processTasks(db, phaseATasks || [], results);

    // ── Phase B: upload done, watermark pending (watermark-only retry) ────────
    if (results.processed < MAX_PER_RUN) {
      const remaining = MAX_PER_RUN - results.processed;
      const { data: phaseBTasks } = await db.from('generation_tasks')
        .select('id,user_id,status,output_url,watermarked_url,polling_url,settings')
        .eq('api_provider', 'fal')
        .eq('status', 'processing')
        .is('watermarked_url', null)
        .not('output_url', 'is', null)
        .is('polling_url', null)
        .order('created_at', { ascending: true })
        .limit(remaining);

      console.log(`[fal-reconcile] Phase B: ${(phaseBTasks || []).length} tasks`);
      await processTasks(db, phaseBTasks || [], results);
    }

    // ── Phase C: legacy completed tasks missing watermarked_url ──────────────
    if (results.processed < MAX_PER_RUN) {
      const remaining = MAX_PER_RUN - results.processed;
      const { data: phaseCTasks } = await db.from('generation_tasks')
        .select('id,user_id,status,output_url,watermarked_url,polling_url,settings')
        .eq('api_provider', 'fal')
        .eq('status', 'completed')
        .is('watermarked_url', null)
        .not('output_url', 'is', null)
        .order('created_at', { ascending: true })
        .limit(remaining);

      console.log(`[fal-reconcile] Phase C: ${(phaseCTasks || []).length} tasks`);
      for (const task of phaseCTasks || []) {
        if (results.processed >= MAX_PER_RUN) break;
        results.processed++;
        try {
          // For completed tasks: only apply watermark (finalizeTask handles this via
          // watermarked_url check + already_has_watermarked_url path)
          const { applyWatermark } = require('./lib/fal-finalize');
          const wm = await applyWatermark(db, task, task.output_url);
          if (wm.watermarked || wm.skipped) {
            const wmUrl = wm.watermarked ? wm.url : task.output_url;
            await db.from('generation_tasks')
              .update({ watermarked_url: wmUrl, updated_at: new Date().toISOString() })
              .eq('id', task.id);
            results.succeeded++;
          } else {
            results.retryable++;
            if (wm.error) results.errors.push({ taskId: task.id, error: wm.error });
          }
        } catch (e) {
          results.retryable++;
          results.errors.push({ taskId: task.id, error: e?.message });
        }
      }
    }

    // ── Stale detection: queued/processing with no webhook after 2h ──────────
    const staleThresholdIso = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const { data: staleTasks } = await db.from('generation_tasks')
      .select('id,created_at,api_task_id')
      .eq('api_provider', 'fal')
      .in('status', ['queued', 'processing'])
      .is('polling_url', null)
      .is('output_url', null)
      .lt('created_at', staleThresholdIso)
      .limit(20);

    if (staleTasks && staleTasks.length > 0) {
      results.stale = staleTasks.length;
      // Log only — never auto-fail or auto-refund stale tasks
      console.warn('[fal-reconcile] stale fal tasks (no webhook after 2h), count:', staleTasks.length,
        'ids:', staleTasks.map(t => t.id));
    }

    const elapsed = Date.now() - startedAt;
    console.log(`[fal-reconcile] done in ${elapsed}ms`, JSON.stringify(results));

    return res.status(200).json({
      ok: true,
      elapsed_ms: elapsed,
      processed: results.processed,
      succeeded: results.succeeded,
      retryable: results.retryable,
      skipped: results.skipped,
      needs_review: results.needs_review,
      stale: results.stale,
      ...(results.errors.length > 0 ? { errors: results.errors } : {})
    });
  } catch (err) {
    console.error('[fal-reconcile] unexpected error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
