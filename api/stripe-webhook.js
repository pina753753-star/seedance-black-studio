const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Stripe signature verification requires the raw request body, so we must
// disable Vercel's automatic body parsing for this endpoint.
module.exports.config = { api: { bodyParser: false } };

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Duplicate-guard: embed the Stripe identifier inside credit_transactions.reason
// and check for a prior row before granting. This makes credit grants idempotent.
// Note: related_task_id is uuid and cannot hold Stripe text IDs; we leave it null.
function reasonTag(kind, stripeId) {
  return `stripe:${kind}:${stripeId}`;
}

async function alreadyProcessed(db, reason) {
  const { data, error } = await db
    .from('credit_transactions')
    .select('id')
    .eq('reason', reason)
    .limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

// Expires-at helpers
function calcExpiresAt(pool) {
  const now = new Date();
  if (pool === 'subscription_credits') {
    // End of the month after the current month
    return new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999).toISOString();
  }
  if (pool === 'purchased_credits') {
    return new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

// Grant credits to a pool (subscription_credits | purchased_credits).
// Uses upsert-style logic: INSERT if no row exists, UPDATE otherwise.
// related_task_id is intentionally left null for Stripe-sourced grants
// (the column is uuid; Stripe IDs are text and cannot be stored there).
async function grantCredits(db, { userId, credits, pool, creditType, reason, plan }) {
  if (!userId || !(credits > 0)) return { ok: false, skipped: 'no-credits' };

  if (await alreadyProcessed(db, reason)) {
    return { ok: true, skipped: 'duplicate' };
  }

  const { data: bal } = await db
    .from('credit_balances')
    .select('free_credits,subscription_credits,purchased_credits')
    .eq('user_id', userId)
    .maybeSingle();

  const expiresAt = calcExpiresAt(pool);
  const expiresCol = pool === 'subscription_credits' ? 'subscription_expires_at' : 'purchased_expires_at';

  if (!bal) {
    const insertRow = { user_id: userId, free_credits: 0, subscription_credits: 0, purchased_credits: 0, [pool]: credits };
    if (expiresAt) insertRow[expiresCol] = expiresAt;
    const { error: insErr } = await db.from('credit_balances').insert(insertRow);
    if (insErr) return { ok: false, error: insErr.message };
  } else {
    const current = Number(bal[pool] || 0);
    const update = { [pool]: current + credits, updated_at: new Date().toISOString() };
    if (expiresAt) update[expiresCol] = expiresAt;
    const { error: updErr } = await db.from('credit_balances').update(update).eq('user_id', userId);
    if (updErr) return { ok: false, error: updErr.message };
  }

  const { error: txErr } = await db.from('credit_transactions').insert({
    user_id: userId,
    amount: credits,
    credit_type: creditType,
    reason,
    related_task_id: null  // uuid column cannot hold Stripe text IDs
  });
  if (txErr) {
    // Log but don't swallow: credits already granted; return partial success with warning.
    console.error('[stripe-webhook] credit_transactions insert failed:', txErr.message, 'reason:', reason);
  }

  if (plan) {
    try {
      await db.from('profiles').update({ plan }).eq('id', userId);
    } catch (_) {}
  }

  return { ok: true, granted: credits, pool };
}

// Upsert user_subscriptions row from a Stripe Subscription object.
async function upsertSubscription(db, sub, extraMeta) {
  if (!sub || !sub.id) return;
  const meta = { ...((sub.metadata) || {}), ...((extraMeta) || {}) };
  const userId = meta.user_id || '';
  if (!userId) return;

  const billingInterval = sub.items?.data?.[0]?.price?.recurring?.interval || meta.billing_interval || 'month';
  const monthlyCredits = Number(meta.monthly_credits || meta.credits || 0);
  const plan = meta.plan || '';
  if (!plan || monthlyCredits <= 0) return;

  const periodStart = sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null;
  const periodEnd   = sub.current_period_end   ? new Date(sub.current_period_end   * 1000).toISOString() : null;
  const anchor      = sub.billing_cycle_anchor  ? new Date(sub.billing_cycle_anchor  * 1000).toISOString() : null;
  const canceledAt  = sub.canceled_at           ? new Date(sub.canceled_at           * 1000).toISOString() : null;

  // For annual subs, compute next_credit_grant_at = anchor + 1 month (first time)
  // Subsequent advances are handled by the Cron RPC.
  // We only set this on insert (upsert does not overwrite if already set).
  let nextGrantAt = null;
  if (billingInterval === 'year' && anchor) {
    const anchorDate = new Date(anchor);
    nextGrantAt = new Date(Date.UTC(
      anchorDate.getUTCFullYear(),
      anchorDate.getUTCMonth() + 1,
      anchorDate.getUTCDate(),
      anchorDate.getUTCHours(),
      anchorDate.getUTCMinutes(),
      anchorDate.getUTCSeconds()
    )).toISOString();
  }

  const row = {
    stripe_subscription_id: sub.id,
    user_id:                 userId,
    stripe_customer_id:      String(sub.customer || ''),
    plan,
    billing_interval:        billingInterval,
    monthly_credits:         monthlyCredits,
    status:                  sub.status || 'active',
    current_period_start:    periodStart,
    current_period_end:      periodEnd,
    billing_cycle_anchor:    anchor,
    cancel_at_period_end:    sub.cancel_at_period_end || false,
    canceled_at:             canceledAt,
    updated_at:              new Date().toISOString()
  };

  // Only set next_credit_grant_at on first insert for annual subs
  const { data: existing } = await db
    .from('user_subscriptions')
    .select('next_credit_grant_at')
    .eq('stripe_subscription_id', sub.id)
    .maybeSingle();

  if (!existing) {
    if (nextGrantAt) row.next_credit_grant_at = nextGrantAt;
    row.created_at = new Date().toISOString();
    await db.from('user_subscriptions').insert(row);
  } else {
    // Update period/status but preserve next_credit_grant_at (Cron manages it)
    await db.from('user_subscriptions').update(row).eq('stripe_subscription_id', sub.id);
  }
}

function metaFromSession(session) {
  const m = session.metadata || {};
  return {
    userId:          m.user_id || session.client_reference_id || '',
    purchaseType:    m.purchase_type || (session.mode === 'subscription' ? 'subscription' : 'credits'),
    plan:            m.plan || '',
    credits:         Math.round(Number(m.credits || 0)),
    billingInterval: m.billing_interval || 'month'
  };
}

async function handleCheckoutCompleted(db, stripe, session) {
  if (session.payment_status && session.payment_status !== 'paid' && session.mode !== 'subscription') {
    return { ok: true, skipped: 'unpaid' };
  }
  const meta = metaFromSession(session);
  if (session.customer && meta.userId) {
    try { await db.from('profiles').update({ stripe_customer_id: session.customer }).eq('id', meta.userId); } catch (_) {}
  }
  if (!meta.userId || !(meta.credits > 0)) return { ok: true, skipped: 'no-metadata' };

  if (meta.purchaseType === 'subscription') {
    // Fetch the Stripe subscription to upsert into user_subscriptions
    if (session.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(session.subscription);
        await upsertSubscription(db, sub, session.metadata || {});
      } catch (e) {
        console.error('[stripe-webhook] subscription retrieve failed:', e.message);
      }
    }

    return grantCredits(db, {
      userId:     meta.userId,
      credits:    meta.credits,
      pool:       'subscription_credits',
      creditType: 'subscription',
      reason:     reasonTag('session', session.id),
      plan:       meta.plan || null
    });
  }

  return grantCredits(db, {
    userId:     meta.userId,
    credits:    meta.credits,
    pool:       'purchased_credits',
    creditType: 'purchased',
    reason:     reasonTag('session', session.id)
  });
}

async function handleInvoicePaid(db, stripe, invoice) {
  // Initial invoice: already handled by checkout.session.completed
  if (invoice.billing_reason === 'subscription_create') {
    return { ok: true, skipped: 'initial-invoice-handled-by-checkout' };
  }

  // Annual renewal invoice: update period in user_subscriptions only.
  // Monthly credit grants for annual subs are handled by the Cron job.
  const lineMeta = invoice.lines?.data?.[0]?.metadata || {};
  const subMeta  = invoice.subscription_details?.metadata || {};
  const billingInterval = subMeta.billing_interval || lineMeta.billing_interval || 'month';

  if (billingInterval === 'year') {
    // Update subscription period dates; do NOT grant 12 months of credits here
    if (invoice.subscription) {
      try {
        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        await upsertSubscription(db, sub, subMeta);
      } catch (e) {
        console.error('[stripe-webhook] annual renewal subscription retrieve failed:', e.message);
      }
    }
    return { ok: true, skipped: 'annual-renewal-handled-by-cron' };
  }

  // Monthly renewal: grant one month of credits
  const meta = {
    userId:  invoice.metadata?.user_id || subMeta.user_id || lineMeta.user_id || '',
    plan:    invoice.metadata?.plan    || subMeta.plan    || lineMeta.plan    || '',
    credits: Math.round(Number(invoice.metadata?.credits || subMeta.credits || lineMeta.credits || 0))
  };
  if (!meta.userId || !(meta.credits > 0)) return { ok: true, skipped: 'no-metadata' };

  return grantCredits(db, {
    userId:     meta.userId,
    credits:    meta.credits,
    pool:       'subscription_credits',
    creditType: 'subscription',
    reason:     reasonTag('invoice', invoice.id),
    plan:       meta.plan || null
  });
}

async function handleSubscriptionUpdated(db, sub) {
  // Keep user_subscriptions in sync with Stripe
  const meta = sub.metadata || {};
  await upsertSubscription(db, sub, meta);
  return { ok: true };
}

async function handleSubscriptionDeleted(db, sub) {
  const { error } = await db
    .from('user_subscriptions')
    .update({ status: sub.status || 'canceled', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', sub.id);
  if (error) console.error('[stripe-webhook] subscription delete sync failed:', error.message);
  return { ok: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, endpoint: '/api/stripe-webhook', method: 'POST' });
  }

  const secretKey    = process.env.STRIPE_SECRET_KEY    || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secretKey)     return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });
  if (!webhookSecret) return res.status(500).json({ ok: false, error: 'Missing STRIPE_WEBHOOK_SECRET' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  const stripe = new Stripe(secretKey);

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (e) {
    return res.status(400).json({ ok: false, error: `Webhook signature verification failed: ${e.message}` });
  }

  try {
    let result = { ok: true, skipped: 'unhandled' };

    if (event.type === 'checkout.session.completed') {
      result = await handleCheckoutCompleted(db, stripe, event.data.object);
    } else if (event.type === 'invoice.payment_succeeded') {
      result = await handleInvoicePaid(db, stripe, event.data.object);
    } else if (event.type === 'customer.subscription.updated') {
      result = await handleSubscriptionUpdated(db, event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      result = await handleSubscriptionDeleted(db, event.data.object);
    }

    return res.status(200).json({ ok: true, type: event.type, eventId: event.id, result });
  } catch (e) {
    // Return 500 so Stripe retries on transient failures
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
