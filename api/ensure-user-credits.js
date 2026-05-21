function config() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceRoleKey: process.env['SUPABASE_' + 'SERVICE_ROLE_KEY'] || ''
  };
}

const INITIAL_FREE_CREDITS = 100;
const INITIAL_FREE_USER_LIMIT = 100;

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

async function countInitialFreeUsers() {
  const { supabaseUrl, serviceRoleKey } = config();
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing Supabase environment variables');
  const response = await fetch(`${supabaseUrl}/rest/v1/credit_balances?select=user_id&free_credits=gte.${INITIAL_FREE_CREDITS}`, {
    method: 'HEAD',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: 'count=exact'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    const error = new Error(text || 'Failed to count initial free credit users');
    error.status = response.status;
    throw error;
  }
  const range = response.headers.get('content-range') || '';
  const total = Number(range.split('/')[1] || 0);
  return Number.isFinite(total) ? total : 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/ensure-user-credits',
      method: 'POST',
      initialFreeCredits: INITIAL_FREE_CREDITS,
      initialFreeUserLimit: INITIAL_FREE_USER_LIMIT
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const userId = String(body.userId || body.user_id || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    if (!userId) return res.status(400).json({ ok: false, error: 'userId is required' });

    const existing = await supabase(`credit_balances?select=*&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (existing?.[0]) {
      return res.status(200).json({ ok: true, created: false, limitedCampaign: true, balance: existing[0] });
    }

    try {
      await supabase('profiles', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ id: userId, email, plan: 'free' })
      });
    } catch (_) {}

    const grantedCount = await countInitialFreeUsers();
    const shouldGrantInitialFreeCredits = grantedCount < INITIAL_FREE_USER_LIMIT;
    const freeCredits = shouldGrantInitialFreeCredits ? INITIAL_FREE_CREDITS : 0;

    const rows = await supabase('credit_balances', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        free_credits: freeCredits,
        subscription_credits: 0,
        purchased_credits: 0
      })
    });

    return res.status(200).json({
      ok: true,
      created: true,
      limitedCampaign: true,
      initialFreeCredits: freeCredits,
      initialFreeCreditsGranted: shouldGrantInitialFreeCredits,
      grantedCountBeforeThisUser: grantedCount,
      remainingInitialFreeSlots: Math.max(0, INITIAL_FREE_USER_LIMIT - grantedCount - (shouldGrantInitialFreeCredits ? 1 : 0)),
      balance: rows?.[0] || null
    });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: error?.message || 'Unknown error' });
  }
}
