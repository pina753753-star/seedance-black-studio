const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

function toIso(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

function subscriptionToResponse(sub) {
  const item = sub.items?.data?.[0];
  const plan = sub.metadata?.plan || item?.price?.nickname || 'unknown';
  const billingInterval = item?.price?.recurring?.interval || sub.metadata?.billing_interval || 'month';
  return {
    plan,
    billingInterval,
    status: sub.status,
    currentPeriodEnd: toIso(sub.current_period_end),
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end)
  };
}

// Requires: Stripe customer on the subscription matches profiles.stripe_customer_id.
// If the subscription has metadata.user_id, it must also match the logged-in user.
// A subscription with no metadata.user_id is allowed through on customer-id match alone.
function verifySubscriptionOwnership(sub, profileStripeCustomerId, userId) {
  const subCustomerId = String(sub.customer || '');
  if (!profileStripeCustomerId || subCustomerId !== profileStripeCustomerId) {
    return false;
  }
  const metaUserId = sub.metadata?.user_id || '';
  if (metaUserId && metaUserId !== userId) {
    return false;
  }
  return true;
}

// Locates the caller's single active/trialing/past_due subscription.
// 1) Look in user_subscriptions by user_id first.
// 2) If that finds nothing, fall back to listing Stripe subscriptions for
//    profiles.stripe_customer_id (covers subscriptions not yet synced by webhook).
// Either path: 0 matches -> no_active_subscription, 1 -> use it, 2+ -> multiple_active_subscriptions.
async function findActiveSubscriptionId(db, stripe, userId, profileStripeCustomerId) {
  const { data: rows, error } = await db
    .from('user_subscriptions')
    .select('stripe_subscription_id,status')
    .eq('user_id', userId)
    .in('status', ACTIVE_STATUSES);

  if (error) {
    return { error: 'db_error' };
  }

  if (rows && rows.length > 0) {
    if (rows.length > 1) return { error: 'multiple_active_subscriptions' };
    return { subscriptionId: rows[0].stripe_subscription_id };
  }

  if (!profileStripeCustomerId) {
    return { error: 'no_active_subscription' };
  }

  const list = await stripe.subscriptions.list({
    customer: profileStripeCustomerId,
    status: 'all',
    limit: 10,
    expand: ['data.items.data.price']
  });
  const active = (list.data || []).filter((s) => ACTIVE_STATUSES.includes(s.status));

  if (active.length === 0) return { error: 'no_active_subscription' };
  if (active.length > 1) return { error: 'multiple_active_subscriptions' };
  return { subscriptionId: active[0].id, subscription: active[0] };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(200).json({ ok: true, endpoint: '/api/cancel-subscription', methods: ['GET', 'POST'] });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  if (!secretKey) return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });

  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data: { user }, error: authError } = await db.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ ok: false, error: 'Invalid token' });

  const stripe = new Stripe(secretKey);

  try {
    const { data: profile } = await db
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .maybeSingle();
    const profileStripeCustomerId = profile?.stripe_customer_id || '';

    const found = await findActiveSubscriptionId(db, stripe, user.id, profileStripeCustomerId);
    if (found.error === 'no_active_subscription') {
      return res.status(404).json({ ok: false, error: 'no_active_subscription' });
    }
    if (found.error === 'multiple_active_subscriptions') {
      return res.status(409).json({ ok: false, error: 'multiple_active_subscriptions' });
    }
    if (found.error) {
      return res.status(500).json({ ok: false, error: found.error });
    }

    // Always re-fetch a fresh copy from Stripe: this is both the source of
    // truth for ownership metadata and, for GET, the current cancel/period state.
    const sub = found.subscription && found.subscription.id === found.subscriptionId
      ? found.subscription
      : await stripe.subscriptions.retrieve(found.subscriptionId, { expand: ['items.data.price'] });

    if (!verifySubscriptionOwnership(sub, profileStripeCustomerId, user.id)) {
      return res.status(403).json({ ok: false, error: 'subscription_ownership_mismatch' });
    }

    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, subscription: subscriptionToResponse(sub) });
    }

    // POST: schedule cancellation at period end.
    if (sub.cancel_at_period_end) {
      const already = subscriptionToResponse(sub);
      return res.status(200).json({
        ok: true,
        alreadyScheduled: true,
        status: already.status,
        cancelAtPeriodEnd: true,
        currentPeriodEnd: already.currentPeriodEnd
      });
    }

    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    const result = subscriptionToResponse(updated);
    return res.status(200).json({
      ok: true,
      status: result.status,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: result.currentPeriodEnd
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
