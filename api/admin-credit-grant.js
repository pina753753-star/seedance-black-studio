'use strict';

const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'hinaran53@gmail.com').trim().toLowerCase();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_QUERY_RE = /^[a-z0-9@.+_-]{2,254}$/i;

function validateSearchQuery(value) {
  const query = String(value || '').trim().toLowerCase();
  if (!EMAIL_QUERY_RE.test(query)) return null;
  return query;
}

function validateGrantPayload(body) {
  const requestId = String(body?.requestId || '').trim();
  const targetUserId = String(body?.targetUserId || '').trim();
  const amount = Number(body?.amount);
  const reason = String(body?.reason || '').trim();

  if (!UUID_RE.test(requestId) || !UUID_RE.test(targetUserId)) return null;
  if (!Number.isInteger(amount) || amount < 1 || amount > 10000) return null;
  if (reason.length < 2 || reason.length > 200) return null;

  return { requestId, targetUserId, amount, reason };
}

async function defaultRequireAuth(req) {
  const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
  return requireConfirmedAuth(req);
}

async function authorizeAdmin(auth) {
  const email = String(auth?.user?.email || '').trim().toLowerCase();
  if (!auth?.user?.id || !ADMIN_EMAIL || email !== ADMIN_EMAIL) return { ok: false };

  const { data, error } = await auth.supabase
    .from('profiles')
    .select('id,email,role')
    .eq('id', auth.user.id)
    .maybeSingle();

  if (error || data?.role !== 'admin' || String(data.email || '').trim().toLowerCase() !== ADMIN_EMAIL) {
    return { ok: false };
  }

  return { ok: true, admin: data };
}

async function searchUsers(db, query) {
  const { data: profiles, error: profileError } = await db
    .from('profiles')
    .select('id,email,plan')
    .ilike('email', `%${query}%`)
    .order('email', { ascending: true })
    .limit(20);

  if (profileError) throw new Error('profile_search_failed');
  const rows = profiles || [];
  if (!rows.length) return [];

  const { data: balances, error: balanceError } = await db
    .from('credit_balances')
    .select('user_id,free_credits,subscription_credits,purchased_credits')
    .in('user_id', rows.map((row) => row.id));

  if (balanceError) throw new Error('balance_search_failed');
  const balanceMap = new Map((balances || []).map((row) => [row.user_id, row]));

  return rows.map((profile) => {
    const balance = balanceMap.get(profile.id) || null;
    return {
      userId: profile.id,
      email: profile.email,
      plan: profile.plan,
      balance: balance ? {
        free: Number(balance.free_credits || 0),
        subscription: Number(balance.subscription_credits || 0),
        purchased: Number(balance.purchased_credits || 0)
      } : null
    };
  });
}

async function grantCredits(db, adminUserId, payload) {
  const { data, error } = await db.rpc('grant_admin_free_credits_atomic', {
    p_request_id: payload.requestId,
    p_admin_user_id: adminUserId,
    p_target_user_id: payload.targetUserId,
    p_amount: payload.amount,
    p_reason: payload.reason
  });

  if (error || !data?.ok) throw new Error('grant_failed');
  return data;
}

function createHandler(dependencies = {}) {
  const requireAuth = dependencies.requireAuth || defaultRequireAuth;
  const authorize = dependencies.authorize || authorizeAdmin;
  const search = dependencies.search || searchUsers;
  const grant = dependencies.grant || grantCredits;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Allow', 'POST');

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED', message: 'この操作は利用できません。' });
    }

    const auth = await requireAuth(req);
    if (!auth.ok) return res.status(auth.status).json(auth.body);

    try {
      const authorization = await authorize(auth);
      if (!authorization.ok) {
        return res.status(403).json({ ok: false, error: 'ADMIN_REQUIRED', message: '管理者権限を確認できませんでした。' });
      }

      if (req.body?.action === 'search') {
        const query = validateSearchQuery(req.body.query);
        if (!query) {
          return res.status(400).json({ ok: false, error: 'INVALID_SEARCH', message: 'メールアドレスを2文字以上で入力してください。' });
        }
        const users = await search(auth.supabase, query);
        return res.status(200).json({ ok: true, users });
      }

      if (req.body?.action === 'grant') {
        const payload = validateGrantPayload(req.body);
        if (!payload) {
          return res.status(400).json({ ok: false, error: 'INVALID_GRANT', message: '付与内容を確認してください。' });
        }
        const result = await grant(auth.supabase, authorization.admin.id, payload);
        return res.status(200).json({ ok: true, result });
      }

      return res.status(400).json({ ok: false, error: 'INVALID_ACTION', message: '操作内容を確認してください。' });
    } catch (_) {
      return res.status(500).json({
        ok: false,
        error: 'ADMIN_CREDIT_OPERATION_FAILED',
        message: '処理結果を確認できません。同じ受付IDのまま再確認してください。'
      });
    }
  };
}

const handler = createHandler();
module.exports = handler;
module.exports._test = {
  authorizeAdmin,
  createHandler,
  grantCredits,
  searchUsers,
  validateGrantPayload,
  validateSearchQuery
};
