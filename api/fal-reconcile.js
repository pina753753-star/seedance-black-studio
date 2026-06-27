'use strict';
/**
 * GET /api/fal-reconcile
 *
 * Background reconciliation for fal.ai tasks whose Webhook has fired but whose
 * Supabase download+upload+watermark haven't completed yet (e.g. the user closed
 * the browser before /api/fal-status was polled).
 *
 * Intended to run as a Vercel Cron job every 5 minutes (requires Pro plan).
 * Can also be triggered manually with a valid Authorization: Bearer {CRON_SECRET} header.
 *
 * Authentication:
 *   - Requires CRON_SECRET environment variable to be set.
 *   - All requests without a matching Bearer token are rejected (403).
 *   - If CRON_SECRET is not configured, ALL requests are rejected (safe default).
 *   - Vercel sets Authorization: Bearer {CRON_SECRET} on cron-triggered requests automatically.
 *
 * Safety:
 *   - Processes at most MAX_PER_RUN tasks per execution.
 *   - Idempotent: safe to run concurrently with fal-status.js or another cron instance.
 *   - Never auto-fails, auto-refunds, or calls fal/OpenRouter real APIs.
 *   - Stale tasks (no webhook, stuck >2h) are only logged, never auto-failed.
 */

const { createClient } = require('@supabase/supabase-js');
const { finalizeTask, isSupabasePublicUrl, MAX_RECONCILE_ATTEMPTS } = require('./lib/fal-finalize');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

// Maximum tasks to process per single cron execution.
// Conservative: 5 × max 12s each = 60s max, fits within Vercel's 60s Function limit.
const MAX_PER_RUN = 5;

// Tasks stuck in queued/processing with no fal CDN URL (webhook never arrived) after this
// duration are considered stale. Only logged — never auto-failed or auto-refunded.
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function authenticate(req) {
  if (!CRON_SECRET) return false; // safe default: reject all if secret not configured
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  const token = auth.slice(7).trim();
  return token === CRON_SECRET;
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
  const results = { processed: 0, succeeded: 0, failed: 0, skipped: 0, stale: 0, errors: [] };

  try {
    // ── Phase 1: Finalize tasks that have a fal CDN URL in polling_url ──────────
    // These are tasks where webhook fired successfully but download+upload hasn't run yet.
    const { data: pendingTasks, error: fetchErr } = await db.from('generation_tasks')
      .select('id,user_id,status,output_url,watermarked_url,polling_url,api_task_id,settings')
      .eq('api_provider', 'fal')
      .in('status', ['queued', 'processing'])
      .not('polling_url', 'is', null)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (fetchErr) {
      console.error('[fal-reconcile] fetch error:', fetchErr.message);
      return res.status(500).json({ ok: false, error: fetchErr.message });
    }

    const tasks = pendingTasks || [];
    console.log(`[fal-reconcile] found ${tasks.length} pending fal tasks`);

    for (const task of tasks) {
      results.processed++;
      try {
        const taskSettings = (task.settings && typeof task.settings === 'object') ? task.settings : {};
        const attempts = Number(taskSettings.reconcile_attempts || 0);

        if (attempts >= MAX_RECONCILE_ATTEMPTS) {
          console.warn('[fal-reconcile] skipping max-attempts task, taskId:', task.id, 'attempts:', attempts);
          results.skipped++;
          continue;
        }

        const result = await finalizeTask(db, task);
        if (result.ok) {
          results.succeeded++;
        } else if (result.skipped) {
          results.skipped++;
        } else {
          results.failed++;
          results.errors.push({ taskId: task.id, error: result.error });
        }
      } catch (e) {
        results.failed++;
        results.errors.push({ taskId: task.id, error: e?.message || String(e) });
        console.error('[fal-reconcile] task exception, taskId:', task.id, e?.message);
      }
    }

    // ── Phase 2: Detect stale tasks (webhook never arrived) ─────────────────────
    // Only log — do NOT auto-fail, auto-refund, or call fal API.
    const staleThresholdIso = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const { data: staleTasks } = await db.from('generation_tasks')
      .select('id,created_at,api_task_id')
      .eq('api_provider', 'fal')
      .in('status', ['queued', 'processing'])
      .is('polling_url', null)
      .lt('created_at', staleThresholdIso)
      .limit(20);

    if (staleTasks && staleTasks.length > 0) {
      results.stale = staleTasks.length;
      console.warn('[fal-reconcile] stale fal tasks (no webhook after 2h):', staleTasks.map(t => t.id));
    }

    // ── Phase 3: Apply watermark to already-uploaded tasks missing watermarked_url ─
    // Covers tasks where upload succeeded but watermark step failed previously.
    if (results.processed < MAX_PER_RUN) {
      const remaining = MAX_PER_RUN - results.processed;
      const { data: watermarkPending } = await db.from('generation_tasks')
        .select('id,user_id,status,output_url,watermarked_url,polling_url,settings')
        .eq('api_provider', 'fal')
        .eq('status', 'completed')
        .is('watermarked_url', null)
        .not('output_url', 'is', null)
        .order('created_at', { ascending: true })
        .limit(remaining);

      for (const task of watermarkPending || []) {
        if (!task.output_url || !isSupabasePublicUrl(task.output_url)) continue;
        try {
          const result = await finalizeTask(db, task);
          if (result.ok || result.skipped) results.succeeded++;
          else { results.failed++; results.errors.push({ taskId: task.id, error: result.error }); }
        } catch (e) {
          results.failed++;
          results.errors.push({ taskId: task.id, error: e?.message });
          console.error('[fal-reconcile] watermark-phase exception, taskId:', task.id, e?.message);
        }
      }
    }

    const elapsed = Date.now() - startedAt;
    console.log(`[fal-reconcile] done in ${elapsed}ms`, results);

    return res.status(200).json({
      ok: true,
      elapsed_ms: elapsed,
      ...results,
      errors: results.errors.length > 0 ? results.errors : undefined
    });
  } catch (err) {
    console.error('[fal-reconcile] unexpected error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
