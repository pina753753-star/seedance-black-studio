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
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/ensure-user-credits',
      method: 'POST'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const userId = String(body.userId || body.user_id || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    if (!userId) return res.status(400).json({ ok: false, error: 'userId is required' });

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
    try {
      await supabase('profiles', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: userId, email, plan: 'free' })
      });
    } catch (_) {}

    const rows = await supabase('credit_balances', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        free_credits: 0,
        subscription_credits: 0,
        purchased_credits: 0
      })
    });

    return res.status(200).json({
      ok: true,
      created: true,
      balance: rows?.[0] || null
    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: error?.message || 'Unknown error' });
  }
};