'use strict';

// Shared data helpers for the api/h3-live/* endpoints: request-body parsing,
// the H3 Live kill-switch read, a service-role client fallback, and the single
// place that decides which h3_live_jobs columns are safe to send to the
// browser. No dependency on Seedance / billing / watermark code.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';

const CONTROL_KEY = 'h3_live';

function jsonBody(req) {
  if (typeof req?.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req?.body || {};
}

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// Reads public.h3_live_controls. Fails CLOSED: a missing row or any read error
// returns { ok:false }, so an uncertain control state can never start a job.
async function checkH3LiveEnabled(db) {
  try {
    const { data, error } = await db
      .from('h3_live_controls')
      .select('enabled')
      .eq('control_key', CONTROL_KEY)
      .maybeSingle();
    if (error) return { ok: false, reason: 'control_read_error' };
    if (!data) return { ok: false, reason: 'control_row_missing' };
    return { ok: Boolean(data.enabled), reason: data.enabled ? null : 'disabled' };
  } catch (_) {
    return { ok: false, reason: 'control_read_exception' };
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

// Whitelist of fields returned to the browser. Never exposes provider URLs,
// request ids, per-pool deduction amounts, or internal error text.
function sanitizeJob(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    status: row.status,
    instruction: row.instruction,
    inputMode: row.input_mode === 'image' ? 'image' : 'text',
    providerStatus: row.provider_status || null,
    durationSeconds: row.duration_seconds,
    resolution: row.resolution,
    creditCost: row.credit_cost,
    videoUrl: row.status === 'completed' ? (row.output_url || null) : null,
    errorCode: row.status === 'failed' ? (row.error_code || null) : null,
    refunded: Boolean(row.refunded_at),
    createdAt: row.created_at || null,
    completedAt: row.completed_at || null,
    finishedAt: row.finished_at || null,
    updatedAt: row.updated_at || null
  };
}

module.exports = {
  CONTROL_KEY,
  jsonBody,
  serviceClient,
  checkH3LiveEnabled,
  isUuid,
  sanitizeJob
};
