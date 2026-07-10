'use strict';
/**
 * GET /api/openrouter-reconcile
 *
 * Background reconciliation for OpenRouter generation tasks that have been
 * stuck in queued/processing for too long with no client ever completing the
 * poll loop (api/seedance-status.js only refunds when a specific client is
 * actively polling a jobId). This includes:
 *   - orphaned tasks: api_task_id never got persisted (see the tracking-persist
 *     fallback in api/_lib/seedance-start.js) — the client received a 503 and
 *     the task row still has status='queued', api_task_id=null.
 *   - abandoned tasks: a jobId/polling_url was saved, but no client ever
 *     polled it to completion (browser closed, app backgrounded, etc).
 *
 * Runs as a Vercel Cron job (see vercel.json). Requires CRON_SECRET.
 *
 * Refund uses the same atomic RPC as the (now removed) fal.ai reconciliation
 * path: public.refund_generation_task_atomic. Its idempotency guarantees
 * (unique index on credit_transactions for reason='generation_refund') make
 * this safe to run repeatedly and safe to race against any other refund path
 * for the same task.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRON_SECRET = process.env.CRON_SECRET || '';

const MAX_PER_RUN = 20;
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

async function refundTask(db, task, errMsg) {
  try {
    const { data, error } = await db.rpc('refund_generation_task_atomic', {
      p_task_id: task.id,
      p_error_message: String(errMsg || 'openrouter task stale').slice(0, 500)
    });
    if (error) {
      console.error('[openrouter-reconcile] RPC error, taskId:', task.id, 'message:', error.message);
      return { ok: false, error: error.message };
    }
    if (!data || data.ok !== true) {
      console.error('[openrouter-reconcile] RPC returned not-ok, taskId:', task.id, 'code:', data?.code);
      return { ok: false, error: data?.code || 'rpc_not_ok' };
    }
    console.log('[openrouter-reconcile] refund RPC result, taskId:', task.id, 'code:', data.code);
    return { ok: true, code: data.code };
  } catch (e) {
    console.error('[openrouter-reconcile] refund exception, taskId:', task.id, 'message:', e?.message);
    return { ok: false, error: e?.message || String(e) };
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
  const results = { checked: 0, refunded: 0, already_settled: 0, failed: 0, errors: [] };

  try {
    const staleThresholdIso = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
    const { data: staleTasks, error: fetchErr } = await db.from('generation_tasks')
      .select('id,user_id,status,api_task_id,polling_url,created_at')
      .eq('api_provider', 'openrouter')
      .in('status', ['queued', 'processing'])
      .lt('created_at', staleThresholdIso)
      .order('created_at', { ascending: true })
      .limit(MAX_PER_RUN);

    if (fetchErr) {
      console.error('[openrouter-reconcile] fetch error:', fetchErr.message);
      return res.status(500).json({ ok: false, error: fetchErr.message });
    }

    console.log(`[openrouter-reconcile] found ${(staleTasks || []).length} stale task(s) (>2h, queued/processing)`);

    for (const task of staleTasks || []) {
      results.checked++;
      const reason = task.api_task_id
        ? 'openrouter task stale: no completion after 2h'
        : 'openrouter task orphaned: tracking never persisted';
      const outcome = await refundTask(db, task, reason);
      if (!outcome.ok) {
        results.failed++;
        results.errors.push({ taskId: task.id, error: outcome.error });
        continue;
      }
      if (outcome.code === 'refunded') results.refunded++;
      else results.already_settled++;
    }

    const elapsed = Date.now() - startedAt;
    console.log(`[openrouter-reconcile] done in ${elapsed}ms`, JSON.stringify(results));

    return res.status(200).json({
      ok: true,
      elapsed_ms: elapsed,
      ...results,
      ...(results.errors.length > 0 ? { errors: results.errors } : {})
    });
  } catch (err) {
    console.error('[openrouter-reconcile] unexpected error:', err?.message);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
