'use strict';

// POST /api/h3-live/admin
//
// Admin-only control + monitoring surface for the H3 Live slice, called by
// admin.html. Standalone: shares nothing with the Seedance generation flow, the
// billing / Stripe code, or the watermark server. It only reads/writes
// public.h3_live_controls and reads public.h3_live_jobs, through the
// service-role client that requireConfirmedAuth already builds.
//
// Auth mirrors api/admin-invite-codes.js / api/admin-credit-grant.js:
//   Authorization: Bearer <Supabase JWT>, and the caller must be the configured
//   admin (auth email === ADMIN_EMAIL AND profiles.role === 'admin' AND
//   profiles.email === ADMIN_EMAIL).
//
// Body: { "action": "getControl" | "setControl" | "listAlerts", ... }
//   getControl  -> { ok, enabled, note, updatedAt, missing? }
//   setControl  { enabled: boolean, note?: string }
//               -> { ok, enabled, note, updatedAt }
//   listAlerts  -> { ok, staleMinutes, stuck: [...], unrefunded: [...] }
//
// No schema change. supabase/migrations/20260831090000_create_h3_live_slice.sql
// already grants service_role SELECT+UPDATE on public.h3_live_controls and ALL
// on public.h3_live_jobs.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, CONTROL_KEY } = require('../_lib/h3-live-store.js');

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || 'hinaran53@gmail.com'
).trim().toLowerCase();

// An active job with no provider_poll_url that has been quiet this long has a
// provably-dead originating /start request (a Vercel function cannot outlive
// this). Kept in step with api/h3-live/reconcile.js STALE_MINUTES.
const STALE_MINUTES = 20;
const LIST_LIMIT = 100;
const ACTIVE = ['queued', 'submitting', 'processing'];

async function authorizeAdmin(auth) {
  const email = String(auth?.user?.email || '').trim().toLowerCase();
  if (!auth?.user?.id || !ADMIN_EMAIL || email !== ADMIN_EMAIL) return { ok: false };

  const { data, error } = await auth.supabase
    .from('profiles')
    .select('id,email,role')
    .eq('id', auth.user.id)
    .maybeSingle();

  if (
    error ||
    data?.role !== 'admin' ||
    String(data.email || '').trim().toLowerCase() !== ADMIN_EMAIL
  ) {
    return { ok: false };
  }

  return { ok: true, admin: data };
}

// Keep a short, human-readable audit note on the control row: who flipped it,
// to what, plus any operator-supplied reason.
function noteText(raw, adminId, enabled) {
  const base = `admin ${adminId}: ` + (enabled ? 'enabled' : 'disabled');
  const extra = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 200);
  return extra ? `${base} — ${extra}` : base;
}

async function getControl(db) {
  const { data, error } = await db
    .from('h3_live_controls')
    .select('enabled,note,updated_at')
    .eq('control_key', CONTROL_KEY)
    .maybeSingle();

  if (error) {
    console.error('[h3-live/admin] control read error:', error.message);
    return {
      status: 503,
      body: { ok: false, error: 'control_read_failed', message: 'H3 Live の状態を取得できませんでした。' }
    };
  }
  if (!data) {
    // Row missing -> migration 20260831090000 not applied yet.
    return {
      status: 200,
      body: { ok: true, enabled: false, note: null, updatedAt: null, missing: true }
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      enabled: data.enabled === true,
      note: data.note || null,
      updatedAt: data.updated_at || null
    }
  };
}

async function setControl(db, adminId, body) {
  if (typeof body?.enabled !== 'boolean') {
    return {
      status: 400,
      body: { ok: false, error: 'invalid_enabled', message: 'enabled は true / false で指定してください。' }
    };
  }

  const { data, error } = await db
    .from('h3_live_controls')
    .update({
      enabled: body.enabled,
      note: noteText(body.note, adminId, body.enabled),
      updated_at: new Date().toISOString()
    })
    .eq('control_key', CONTROL_KEY)
    .select('enabled,note,updated_at');

  if (error) {
    console.error('[h3-live/admin] control write error:', error.message);
    return {
      status: 503,
      body: { ok: false, error: 'control_write_failed', message: 'H3 Live の状態を更新できませんでした。' }
    };
  }
  if (!Array.isArray(data) || data.length !== 1) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'control_row_missing',
        message: 'H3 Live の制御レコードがありません（マイグレーション 20260831090000 未適用の可能性があります）。'
      }
    };
  }
  return {
    status: 200,
    body: {
      ok: true,
      enabled: data[0].enabled === true,
      note: data[0].note || null,
      updatedAt: data[0].updated_at || null
    }
  };
}

function sanitizeAlertJob(r) {
  return {
    id: r.id,
    userId: r.user_id || null,
    status: r.status,
    inputMode: r.input_mode === 'image' ? 'image' : 'text',
    charged: Boolean(r.charged_at),
    refunded: Boolean(r.refunded_at),
    providerRequestId: r.provider_request_id || null,
    errorCode: r.error_code || null,
    ageMinutes: r.updated_at
      ? Math.max(0, Math.floor((Date.now() - Date.parse(r.updated_at)) / 60000))
      : null,
    createdAt: r.created_at || null,
    updatedAt: r.updated_at || null
  };
}

async function listAlerts(db) {
  const staleCutoffIso = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
  const cols =
    'id,user_id,status,input_mode,charged_at,refunded_at,provider_request_id,provider_poll_url,error_code,created_at,updated_at';

  const [stuckRes, unrefundedRes] = await Promise.all([
    // Active but untrackable and stale -> /api/h3-live/status can never advance
    // or terminate these. Covers tracking_persist_failed and the
    // charged-but-unsubmittable ("送信不明") case.
    db.from('h3_live_jobs')
      .select(cols)
      .in('status', ACTIVE)
      .is('provider_poll_url', null)
      .lt('updated_at', staleCutoffIso)
      .order('updated_at', { ascending: true })
      .limit(LIST_LIMIT),
    // Charged, ended failed, but no refund recorded -> credits owed back. Covers
    // the refund_state_uncertain outcomes that left the job terminal-failed.
    db.from('h3_live_jobs')
      .select(cols)
      .eq('status', 'failed')
      .not('charged_at', 'is', null)
      .is('refunded_at', null)
      .order('updated_at', { ascending: false })
      .limit(LIST_LIMIT)
  ]);

  if (stuckRes.error || unrefundedRes.error) {
    console.error(
      '[h3-live/admin] alerts lookup error:',
      stuckRes.error?.message || unrefundedRes.error?.message
    );
    return {
      status: 503,
      body: { ok: false, error: 'alerts_lookup_failed', message: 'H3 Live の要対応ジョブを取得できませんでした。' }
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      staleMinutes: STALE_MINUTES,
      stuck: (stuckRes.data || []).map(sanitizeAlertJob),
      unrefunded: (unrefundedRes.data || []).map(sanitizeAlertJob)
    }
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'POST');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'POST only.' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const body = jsonBody(req);
  const action = String(body.action || '');

  try {
    const authorization = await authorizeAdmin(auth);
    if (!authorization.ok) {
      return res.status(403).json({ ok: false, error: 'ADMIN_REQUIRED', message: '管理者権限を確認できませんでした。' });
    }

    const db = auth.supabase;
    if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

    let out;
    if (action === 'getControl') out = await getControl(db);
    else if (action === 'setControl') out = await setControl(db, authorization.admin.id, body);
    else if (action === 'listAlerts') out = await listAlerts(db);
    else return res.status(400).json({ ok: false, error: 'invalid_action', message: '操作内容を確認してください。' });

    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error('[h3-live/admin] operation failed:', action, e?.message || e);
    return res.status(500).json({ ok: false, error: 'h3_admin_operation_failed', message: '処理結果を確認できませんでした。' });
  }
};

module.exports._test = { authorizeAdmin, noteText, sanitizeAlertJob, STALE_MINUTES };
