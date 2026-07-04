// POST /api/video-edit — entry point for the video editing feature.
// Gate order: auth (401) -> paid plan (403) -> credit balance (402).
// The actual edit execution (Railway /edit) is intentionally NOT wired up yet;
// paid users with credits receive a "coming soon" response. WATERMARK_SECRET
// and the Railway edit endpoint must never be exposed to the client.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const PAID_PLANS = ['standard', 'premium', 'ultimate', 'team', 'scale'];

function dbClient() {
  if (!SUPABASE_URL || !SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

function bearerToken(req) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  return auth.replace(/^Bearer\s+/i, '').trim();
}

async function getUserFromToken(db, token) {
  if (!token) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error) return null;
    return data?.user || null;
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const db = dbClient();
  if (!db) {
    return res.status(500).json({ ok: false, error: 'SERVER_NOT_CONFIGURED' });
  }

  const user = await getUserFromToken(db, bearerToken(req));
  if (!user) {
    return res.status(401).json({
      ok: false,
      error: 'AUTH_REQUIRED',
      message: 'ログインが必要です。',
      loginUrl: '/login.html'
    });
  }

  const { data: profile } = await db
    .from('profiles')
    .select('plan')
    .eq('id', user.id)
    .maybeSingle();
  const plan = String(profile?.plan || 'free').toLowerCase();
  if (!PAID_PLANS.includes(plan)) {
    return res.status(403).json({
      ok: false,
      error: 'VIDEO_EDIT_REQUIRES_PAID_PLAN',
      message: '動画編集は有料プランで利用できます。',
      upgradeUrl: '/pricing.html?feature=video-edit'
    });
  }

  const { data: bal } = await db
    .from('credit_balances')
    .select('free_credits,subscription_credits,purchased_credits')
    .eq('user_id', user.id)
    .maybeSingle();
  const balance = Number(bal?.free_credits || 0)
    + Number(bal?.subscription_credits || 0)
    + Number(bal?.purchased_credits || 0);
  if (balance <= 0) {
    return res.status(402).json({
      ok: false,
      insufficient: true,
      balance,
      error: 'クレジット不足です（残高: ' + balance + '）'
    });
  }

  // Paid plan with credits: editing itself is not enabled yet.
  return res.status(200).json({
    ok: true,
    ready: false,
    status: 'coming_soon',
    message: '動画編集機能は近日対応予定です。'
  });
};
