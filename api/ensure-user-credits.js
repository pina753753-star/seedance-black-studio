const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

function config() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceRoleKey: process.env['SUPABASE_' + 'SERVICE_ROLE_KEY'] || ''
  };
}

async function supabase(path, options = {}) {
  const { supabaseUrl, serviceRoleKey } = config();
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing Supabase environment variables');
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const error = new Error(typeof data === 'string' ? data : JSON.stringify(data));
    error.status = response.status;
    error.headers = response.headers;
    throw error;
  }
  return data;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/ensure-user-credits',
      method: 'POST'
    });
  }

  try {
    const auth = await requireConfirmedAuth(req);
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    const userId = auth.user.id;
    const email = String(auth.user.email || '').trim().toLowerCase();
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    } catch (_) {
      return res.status(400).json({ ok: false, error: 'INVALID_BODY' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'INVALID_BODY' });
    }
    // Legacy identity fields may be supplied, but can never select another user.
    if (['userId', 'user_id'].some(key => Object.hasOwn(body, key) && body[key] !== userId)
      || (Object.hasOwn(body, 'email') && (typeof body.email !== 'string' || body.email.trim().toLowerCase() !== email))) {
      return res.status(403).json({ ok: false, error: 'IDENTITY_MISMATCH' });
    }

    const existing = await supabase(`credit_balances?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (existing?.[0]) {
      return res.status(200).json({
        ok: true,
        created: false,
        balance: existing[0]
      });
    }

    // 通常はauth.users作成時のhandle_new_user()がprofilesと
    // credit_balancesを作成する。
    // このAPIは、何らかの理由で行が欠けている場合の補完専用とし、
    // キャンペーンクレジットは一切付与しない。
    // Ignore conflicts: never reset an existing profile's plan or other fields.
    await supabase('profiles?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ id: userId, email, plan: 'free' })
    });

    const rows = await supabase('credit_balances?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        user_id: userId,
        free_credits: 0,
        subscription_credits: 0,
        purchased_credits: 0
      })
    });

    // Another request/trigger may have initialized the balance in the meantime.
    const balance = rows?.[0] || (await supabase(`credit_balances?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`))?.[0];
    if (!balance) throw new Error('Balance initialization failed');
    return res.status(200).json({
      ok: true,
      created: Boolean(rows?.[0]),
      balance
    });
  } catch (_) {
    return res.status(500).json({ ok: false, error: 'CREDIT_INITIALIZATION_FAILED' });
  }
};
