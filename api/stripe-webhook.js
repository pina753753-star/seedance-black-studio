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

// Duplicate-guard: until dedicated stripe_event_id / stripe_session_id /
// stripe_invoice_id columns exist, we embed the Stripe identifier inside the
// credit_transactions.reason text and check for a prior row with that exact
// reason before granting. This makes credit grants idempotent.
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

// Adds `credits` to the given pool (subscription_credits | purchased_credits)
// and records a credit_transactions row. The reason carries the Stripe id so
// repeated webhook deliveries do not double-grant.
function calcExpiresAt(pool) {
  const now = new Date();
  if (pool === 'subscription_credits') {
    return new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999).toISOString();
  }
  if (pool === 'purchased_credits') {
    return new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}
async function grantCredits(db, { userId, credits, pool, creditType, reason, relatedId, plan }) {
  if (!userId || !(credits > 0)) return { ok: false, skipped: 'no-credits' };

  if (await alreadyProcessed(db, reason)) {
    return { ok: true, skipped: 'duplicate' };
  }

  // Ensure a balance row exists, then read current values.
  const { data: bal } = await db
    .from('credit_balances')
    .select('free_credits,subscription_credits,purchased_credits')
    .eq('user_id', userId)
    .maybeSingle();

  if (!bal) {
    const insertRow = { user_id: userId, free_credits: 0, subscription_credits: 0, purchased_credits: 0 };
    insertRow[pool] = credits;
    const expiresAt = calcExpiresAt(pool);
    if (expiresAt) insertRow[pool === 'subscription_credits' ? 'subscription_expires_at' : 'purchased_expires_at'] = expiresAt;
    const { error: insErr } = await db.from('credit_balances').insert(insertRow);
    if (insErr) return { ok: false, error: insErr.message };
  } else {
    const current = Number(bal[pool] || 0);
    const update = { [pool]: current + credits, updated_at: new Date().toISOString() };
    const expiresAt = calcExpiresAt(pool);
    if (expiresAt) update[pool === 'subscription_credits' ? 'subscription_expires_at' : 'purchased_expires_at'] = expiresAt;
    const { error: updErr } = await db.from('credit_balances').update(update).eq('user_id', userId);
    if (updErr) return { ok: false, error: updErr.message };
  }

  await db.from('credit_transactions').insert({
    user_id: userId,
    amount: credits,
    credit_type: creditType,
    reason,
    related_task_id: relatedId || null
  });

  if (plan) {
    try {
      await db.from('profiles').update({ plan }).eq('id', userId);
    } catch (_) {}
  }

  return { ok: true, granted: credits, pool };
}

function metaFromSession(session) {
  const m = session.metadata || {};
  return {
    userId: m.user_id || session.client_reference_id || '',
    purchaseType: m.purchase_type || (session.mode === 'subscription' ? 'subscription' : 'credits'),
    plan: m.plan || '',
    credits: Math.round(Number(m.credits || 0))
  };
}

async function handleCheckoutCompleted(db, session) {
  // Only act once payment is actually collected.
  if (session.payment_status && session.payment_status !== 'paid' && session.mode !== 'subscription') {
    return { ok: true, skipped: 'unpaid' };
  }
  const meta = metaFromSession(session);
  if (session.customer && meta.userId) {
    try { await db.from('profiles').update({ stripe_customer_id: session.customer }).eq('id', meta.userId); } catch (_) {}
  }
  if (!meta.userId || !(meta.credits > 0)) return { ok: true, skipped: 'no-metadata' };

  if (meta.purchaseType === 'subscription') {
    return grantCredits(db, {
      userId: meta.userId,
      credits: meta.credits,
      pool: 'subscription_credits',
      creditType: 'subscription',
      reason: reasonTag('session', session.id),
      relatedId: session.id,
      plan: meta.plan || null
    });
  }
  return grantCredits(db, {
    userId: meta.userId,
    credits: meta.credits,
    pool: 'purchased_credits',
    creditType: 'purchased',
    reason: reasonTag('session', session.id),
    relatedId: session.id
  });
}

async function handleInvoicePaid(db, invoice) {
  // The first invoice of a new subscription is already credited by the
  // checkout.session.completed handler, so skip it here to avoid double-grant.
  // Renewal invoices have billing_reason === 'subscription_cycle'.
  if (invoice.billing_reason === 'subscription_create') {
    return { ok: true, skipped: 'initial-invoice-handled-by-checkout' };
  }
  // Subscription metadata is mirrored onto the subscription_data at checkout.
  const lineMeta = invoice.lines?.data?.[0]?.metadata || {};
  const meta = {
    userId: invoice.metadata?.user_id || lineMeta.user_id || '',
    plan: invoice.metadata?.plan || lineMeta.plan || '',
    credits: Math.round(Number(invoice.metadata?.credits || lineMeta.credits || 0))
  };
  if (!meta.userId || !(meta.credits > 0)) return { ok: true, skipped: 'no-metadata' };

  return grantCredits(db, {
    userId: meta.userId,
    credits: meta.credits,
    pool: 'subscription_credits',
    creditType: 'subscription',
    reason: reasonTag('invoice', invoice.id),
    relatedId: invoice.id,
    plan: meta.plan || null
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, endpoint: '/api/stripe-webhook', method: 'POST' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secretKey) return res.status(500).json({ ok: false, error: 'Missing STRIPE_SECRET_KEY' });
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
      result = await handleCheckoutCompleted(db, event.data.object);
    } else if (event.type === 'invoice.payment_succeeded') {
      result = await handleInvoicePaid(db, event.data.object);
    }

    return res.status(200).json({ ok: true, type: event.type, eventId: event.id, result });
  } catch (e) {
    // Return 500 so Stripe retries on transient failures.
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
