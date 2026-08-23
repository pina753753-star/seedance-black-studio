'use strict';

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || 'hinaran53@gmail.com'
).trim().toLowerCase();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const HASH_RE = /^[0-9a-f]{64}$/i;

async function defaultRequireAuth(req) {
  const {
    requireConfirmedAuth
  } = require('./_lib/confirmed-auth.js');

  return requireConfirmedAuth(req);
}

async function authorizeAdmin(auth) {
  const email = String(
    auth?.user?.email || ''
  ).trim().toLowerCase();

  if (
    !auth?.user?.id ||
    !ADMIN_EMAIL ||
    email !== ADMIN_EMAIL
  ) {
    return { ok: false };
  }

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

function validateCreatePayload(body) {
  const requestId = String(body?.requestId || '').trim();
  const label = String(body?.label || '').trim();
  const codeHash = String(body?.codeHash || '').trim().toLowerCase();
  const codeHint = String(body?.codeHint || '').trim();

  if (!UUID_RE.test(requestId)) return null;
  if (label.length < 2 || label.length > 80) return null;
  if (!HASH_RE.test(codeHash)) return null;
  if (codeHint.length < 5 || codeHint.length > 40) return null;

  return {
    requestId,
    label,
    codeHash,
    codeHint
  };
}

function validateActivePayload(body) {
  const inviteCodeId = String(body?.inviteCodeId || '').trim();

  if (!UUID_RE.test(inviteCodeId)) return null;
  if (typeof body?.isActive !== 'boolean') return null;

  return {
    inviteCodeId,
    isActive: body.isActive
  };
}

function validateRequiredPayload(body) {
  if (typeof body?.inviteRequired !== 'boolean') return null;

  return {
    inviteRequired: body.inviteRequired
  };
}

async function rpc(db, name, params) {
  const { data, error } = await db.rpc(name, params);

  if (error || !data?.ok) {
    throw new Error('invite_admin_rpc_failed');
  }

  return data;
}

function createHandler(dependencies = {}) {
  const requireAuth =
    dependencies.requireAuth || defaultRequireAuth;

  const authorize =
    dependencies.authorize || authorizeAdmin;

  const invoke =
    dependencies.rpc || rpc;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Allow', 'POST');

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        message: 'この操作は利用できません。'
      });
    }

    const auth = await requireAuth(req);

    if (!auth.ok) {
      return res.status(auth.status).json(auth.body);
    }

    try {
      const authorization = await authorize(auth);

      if (!authorization.ok) {
        return res.status(403).json({
          ok: false,
          error: 'ADMIN_REQUIRED',
          message: '管理者権限を確認できませんでした。'
        });
      }

      const adminUserId = authorization.admin.id;
      const action = String(req.body?.action || '');

      if (action === 'list') {
        const result = await invoke(
          auth.supabase,
          'admin_list_invite_codes',
          { p_admin_user_id: adminUserId }
        );

        return res.status(200).json(result);
      }

      if (action === 'create') {
        const payload = validateCreatePayload(req.body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_CREATE_PAYLOAD',
            message: '発行内容を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_create_invite_code',
          {
            p_admin_user_id: adminUserId,
            p_request_id: payload.requestId,
            p_label: payload.label,
            p_code_hash: payload.codeHash,
            p_code_hint: payload.codeHint
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'setActive') {
        const payload = validateActivePayload(req.body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_ACTIVE_PAYLOAD',
            message: '変更内容を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_set_invite_code_active',
          {
            p_admin_user_id: adminUserId,
            p_invite_code_id: payload.inviteCodeId,
            p_is_active: payload.isActive
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'setRequired') {
        const payload = validateRequiredPayload(req.body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_REQUIRED_PAYLOAD',
            message: '切り替え内容を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_set_invite_required',
          {
            p_admin_user_id: adminUserId,
            p_invite_required: payload.inviteRequired
          }
        );

        return res.status(200).json(result);
      }

      return res.status(400).json({
        ok: false,
        error: 'INVALID_ACTION',
        message: '操作内容を確認してください。'
      });
    } catch (_) {
      return res.status(500).json({
        ok: false,
        error: 'ADMIN_INVITE_OPERATION_FAILED',
        message: '招待コードの処理結果を確認できませんでした。'
      });
    }
  };
}

const handler = createHandler();

module.exports = handler;
module.exports._test = {
  authorizeAdmin,
  createHandler,
  rpc,
  validateActivePayload,
  validateCreatePayload,
  validateRequiredPayload
};
