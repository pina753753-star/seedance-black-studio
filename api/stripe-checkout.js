const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SITE_URL = process.env.SITE_URL || process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}` || 'https://flowvid-studio.vercel.app';

// Monthly subscription plans (billing_interval: month)
const SUBSCRIPTION_PLANS = {
  standard: { name: 'Standard', amount: 2980,   credits: 800,   plan: 'standard', env: 'STRIPE_PRICE_STANDARD_MONTHLY' },
  premium:  { name: 'Premium',  amount: 6980,   credits: 2100,  plan: 'premium',  env: 'STRIPE_PRICE_PREMIUM_MONTHLY'  },
  ultimate: { name: 'Ultimate', amount: 15800,  credits: 5100,  plan: 'ultimate', env: 'STRIPE_PRICE_ULTIMATE_MONTHLY' },
  team:     { name: 'Team',     amount: 298000, credits: 90000, plan: 'team',     env: 'STRIPE_PRICE_TEAM_MONTHLY'     }
};

// Annual subscription plans (billing_interval: year, billed once per year)
// Credits are granted monthly via Cron; NOT 12x upfront.
const SUBSCRIPTION_PLANS_ANNUAL = {
  standard: { name: 'Standard', amount: 35760,  monthly_credits: 800,   plan: 'standard', env: 'STRIPE_PRICE_STANDARD_YEARLY' },
  premium:  { name: 'Premium',  amount: 83760,  monthly_credits: 2100,  plan: 'premium',  env: 'STRIPE_PRICE_PREMIUM_YEARLY'  },
  ultimate: { name: 'Ultimate', amount: 189600, monthly_credits: 5100,  plan: 'ultimate', env: 'STRIPE_PRICE_ULTIMATE_YEARLY'  }
};

const CREDIT_PACKS = {
  credits_100:  { name: '100 credits',   amount: 500,  credits: 100  },
  credits_300:  { name: '300 credits',   amount: 1300, credits: 300  },
  credits_500:  { name: '500 credits',   amount: 2000, credits: 500  },
  credits_1000: { name: '1,000 credits', amount: 3600, credits: 1000 },
  credits_3000: { name: '3,000 credits', amount: 9800, credits: 3000 }
};

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function bearerToken(req) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  return auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
}

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function getUserFromToken(token) {
  const db = serviceClient();
  if (!db || !token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

const PAID_PLANS = ['standard', 'premium', 'ultimate', 'team'];

async function getActiveSubscription(db, userId) {
  const [profileRes, balanceRes] = await Promise.all([
    db.from('profiles').select('plan').eq('id', userId).maybeSingle(),
    db.from('credit_balances').select('subscription_expires_at').eq('user_id', userId).maybeSingle()
  ]);
  const plan = profileRes.data?.plan || 'free';
  if (!PAID_PLANS.includes(plan)) return null;
  const expiresAt = balanceRes.data?.subscription_expires_at;
  if (!expiresAt || new Date(expiresAt) <= new Date()) return null;
  return { plan, expiresAt };
}

// Build a Stripe line_item for a monthly subscription plan.
// Falls back to price_data only in non-production or when Price ID is missing
// (avoids silent production misconfiguration).
function lineItemForMonthly(plan) {
  const priceId = process.env[plan.env];
  if (priceId) return { price: priceId, quantity: 1 };
  if (process.env.VERCEL_ENV === 'production') {
    throw new Error(`年額Price IDが未設定です: ${plan.env}`);
  }
  return {
    quantity: 1,
    price_data: {
      currency: 'jpy',
      unit_amount: plan.amount,
      recurring: { interval: 'month' },
      product_data: { name: `FlowVid Studio ${plan.name}` }
    }
  };
}

// Build a Stripe line_item for an annual subscription plan.
function lineItemForAnnual(plan) {
  const priceId = process.env[plan.env];
  if (priceId) return { price: priceId, quantity: 1 };
  if (process.env.VERCEL_ENV === 'production') {
    throw new Error(`年額Price IDが未設定です: ${plan.env}`);
  }
  return {
    quantity: 1,
    price_data: {
      currency: 'jpy',
      unit_amount: plan.amount,
      recurring: { interval: 'year' },
      product_data: { name: `FlowVid Studio ${plan.name} 年額` }
    }
  };
}

function lineItemForPack(pack) {
  return {
    quantity: 1,
    price_data: {
      currency: 'jpy',
      unit_amount: pack.amount,
      product_data: { name: `FlowVid Studio ${pack.name}` }
    }
  };
}

// Build Stripe Embedded Checkout session params common to all modes.
function embeddedBase(user) {
  return {
    ui_mode: 'embedded',
    return_url: `${SITE_URL}/profile.html?checkout=complete&session_id={CHECKOUT_SESSION_ID}`,
    customer_email: user.email || undefined,
    client_reference_id: user.id
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, endpoint: '/api/stripe-checkout', method: 'POST' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  if (!secretKey) return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'ログインが必要です', redirect: '/login.html' });

  const body = jsonBody(req);
  const kind     = String(body.kind || '').toLowerCase();
  const id       = String(body.id || body.plan || body.pack || '').toLowerCase();
  const interval = String(body.billing_interval || body.billing || 'monthly').toLowerCase();
  const isYearly = interval === 'yearly' || interval === 'year';

  const stripe = new Stripe(secretKey);

  try {
    let session;

    if (kind === 'subscription') {
      if (isYearly) {
        // ── Annual subscription ──────────────────────────────────
        if (id === 'team') {
          return res.status(400).json({ ok: false, error: 'Teamの年額プランは準備中です' });
        }
        const plan = SUBSCRIPTION_PLANS_ANNUAL[id];
        if (!plan) return res.status(400).json({ ok: false, error: 'プランが見つかりません' });

        const metadata = {
          user_id:         user.id,
          user_email:      user.email || '',
          purchase_type:   'subscription',
          plan:            plan.plan,
          billing_interval: 'year',
          // initial grant credits (first month only)
          credits:         String(plan.monthly_credits),
          monthly_credits: String(plan.monthly_credits)
        };

        session = await stripe.checkout.sessions.create({
          ...embeddedBase(user),
          mode: 'subscription',
          line_items: [lineItemForAnnual(plan)],
          metadata,
          subscription_data: { metadata },
          allow_promotion_codes: true
        });

      } else {
        // ── Monthly subscription ─────────────────────────────────
        const plan = SUBSCRIPTION_PLANS[id];
        if (!plan) return res.status(400).json({ ok: false, error: 'プランが見つかりません' });

        const metadata = {
          user_id:          user.id,
          user_email:       user.email || '',
          purchase_type:    'subscription',
          plan:             plan.plan,
          billing_interval: 'month',
          credits:          String(plan.credits),
          monthly_credits:  String(plan.credits)
        };

        session = await stripe.checkout.sessions.create({
          ...embeddedBase(user),
          mode: 'subscription',
          line_items: [lineItemForMonthly(plan)],
          metadata,
          subscription_data: { metadata },
          allow_promotion_codes: true
        });
      }

    } else if (kind === 'credits') {
      // ── Credit pack ─────────────────────────────────────────────
      const pack = CREDIT_PACKS[id];
      if (!pack) return res.status(400).json({ ok: false, error: 'クレジットパックが見つかりません' });

      const credDb = serviceClient();
      const activeSub = credDb ? await getActiveSubscription(credDb, user.id) : null;
      if (!activeSub) {
        return res.status(403).json({
          ok: false,
          error: 'subscription_required',
          message: '追加クレジットはサブスクリプション会員限定です',
          redirect: '/pricing.html#monthly'
        });
      }

      const metadata = {
        user_id:       user.id,
        user_email:    user.email || '',
        purchase_type: 'credits',
        pack:          id,
        credits:       String(pack.credits)
      };

      session = await stripe.checkout.sessions.create({
        ...embeddedBase(user),
        mode: 'payment',
        line_items: [lineItemForPack(pack)],
        metadata,
        allow_promotion_codes: true
      });

    } else {
      return res.status(400).json({ ok: false, error: 'kind must be subscription or credits' });
    }

    // Return client_secret for Embedded Checkout (never return the secret key)
    return res.status(200).json({
      ok:           true,
      clientSecret: session.client_secret,
      sessionId:    session.id,
      uiMode:       'embedded'
    });

  } catch (e) {
    const msg = e.message || String(e);
    console.error('[stripe-checkout] error:', msg);
    const safe = process.env.VERCEL_ENV === 'production'
      ? '決済の開始に失敗しました。しばらくしてからお試しください。'
      : msg;
    return res.status(500).json({ ok: false, error: safe });
  }
};
