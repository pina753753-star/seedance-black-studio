'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

function jsonBody(req) {
  if (typeof req?.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req?.body || {};
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return UUID_RE.test(String(value || '').trim());
}

async function checkDirectorEnabled(db) {
  try {
    const { data, error } = await db
      .from('h3_director_controls')
      .select('enabled')
      .eq('control_key', 'h3_director')
      .maybeSingle();
    if (error || !data) return { ok: false };
    return { ok: data.enabled === true };
  } catch (_) {
    return { ok: false };
  }
}

async function getDirectorEntitlement(db, userId, allowedPlans) {
  try {
    const [profile, balance] = await Promise.all([
      db.from('profiles').select('plan,account_status').eq('id', userId).maybeSingle(),
      db.from('credit_balances')
        .select('free_credits,subscription_credits,purchased_credits,subscription_expires_at,purchased_expires_at')
        .eq('user_id', userId)
        .maybeSingle()
    ]);
    if (profile.error || balance.error || !profile.data || !balance.data) {
      return { ok: false, allowed: false };
    }

    const now = Date.now();
    const plan = String(profile.data.plan || 'free').trim().toLowerCase();
    const subscriptionExpiry = Date.parse(String(balance.data.subscription_expires_at || ''));
    const purchasedExpiry = Date.parse(String(balance.data.purchased_expires_at || ''));
    const subscription = Number.isFinite(subscriptionExpiry) && subscriptionExpiry > now
      ? Number(balance.data.subscription_credits || 0) : 0;
    const purchased = !Number.isFinite(purchasedExpiry) || purchasedExpiry > now
      ? Number(balance.data.purchased_credits || 0) : 0;
    const free = Number(balance.data.free_credits || 0);

    return {
      ok: true,
      allowed: allowedPlans.includes(plan) && Number.isFinite(subscriptionExpiry) && subscriptionExpiry > now,
      plan,
      accountStatus: String(profile.data.account_status || 'active'),
      balance: Math.max(0, subscription) + Math.max(0, free) + Math.max(0, purchased)
    };
  } catch (_) {
    return { ok: false, allowed: false };
  }
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    prompt: row.initial_prompt,
    durationSeconds: row.duration_limit_seconds,
    resolution: row.resolution,
    aspectRatio: row.aspect_ratio,
    creditCost: row.credit_cost,
    expiresAt: row.expires_at || null,
    connectedAt: row.connected_at || null,
    endedAt: row.ended_at || null,
    refunded: Boolean(row.refunded_at),
    errorCode: ['failed', 'needs_review'].includes(row.status) ? row.error_code : null,
    recordingStatus: row.recording_status || 'pending',
    recordingReady: row.recording_status === 'ready',
    recordingSizeBytes: row.recording_size_bytes == null ? null : Number(row.recording_size_bytes),
    recordedAt: row.recorded_at || null,
    createdAt: row.created_at || null
  };
}

module.exports = {
  serviceClient,
  jsonBody,
  isUuid,
  checkDirectorEnabled,
  getDirectorEntitlement,
  publicSession
};
