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

// Grant credits and write the Stripe ledger entry in one database transaction.
// The RPC is executable only by service_role and uses the unique Stripe reason
// index to make retries and concurrent webhook deliveries idempotent.
async function grantCredits(db, { userId, credits, pool, creditType, reason, plan }) {
  if (!userId || !(credits > 0)) return { ok: false, skipped: 'no-credits' };

  const expectedCreditType = pool === 'subscription_credits'
    ? 'subscription'
    : pool === 'purchased_credits'
      ? 'purchased'
      : '';
  if (!expectedCreditType || creditType !== expectedCreditType) {
    return { ok: false, error: 'invalid_credit_pool' };
  }

  const { data, error } = await db.rpc('grant_stripe_credits_atomic', {
    p_user_id: userId,
    p_credits: Math.round(credits),
    p_pool: pool,
    p_reason: reason,
    p_expires_at: calcExpiresAt(pool),
    p_plan: plan || null
  });

  if (error) {
    console.error('[stripe-webhook] atomic credit grant failed:', error.message, 'reason:', reason);
    return { ok: false, error: error.message };
  }

  if (!data || data.ok !== true) {
    return { ok: false, error: 'atomic_credit_grant_invalid_response' };
  }

  return data;
}

// ── Chargeback / fraud countermeasure (Step 2) ──────────────────────────────
// stripe_payment_ledger is an append-first ledger that links Stripe payment
// objects to a user. It is populated ONLY here (webhook code, service role) and
// is deliberately kept OUT of grant_stripe_credits_atomic so the working
// billing RPC and its migration stay untouched. Ledger write and credit grant
// are therefore two separate transactions; the flow around an existing grant
// call site is:
//   1. ensurePaymentLedgerPending() — insert (or re-find) a 'pending' row
//   2. grantCredits()               — unchanged; grants credits idempotently
//   3. markPaymentLedgerGranted()   — flip the row 'pending' -> 'granted'
// A crash between 2 and 3 leaves credits granted but the ledger row 'pending';
// Stripe's at-least-once redelivery re-runs all three, grantCredits() reports
// 'duplicate', and step 3 finishes the repair. The reverse order (grant first)
// is avoided because it can leave a granted credit with no ledger row at all,
// which would break later dispute lookups. If step 1 fails we do NOT grant and
// return an error (HTTP 500) so Stripe redelivers.
function ledgerCurrency(value) {
  return typeof value === 'string' && /^[a-zA-Z]{3}$/.test(value) ? value : null;
}

function ledgerAmount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

async function ensurePaymentLedgerPending(db, { lookupColumn, lookupValue, row }) {
  if (!lookupValue) return { ok: false, error: 'ledger_missing_lookup_value' };

  // Already recorded? (Stripe redelivery, or a prior partial run.)
  const { data: existing, error: findErr } = await db
    .from('stripe_payment_ledger')
    .select('*')
    .eq(lookupColumn, lookupValue)
    .maybeSingle();
  if (findErr) return { ok: false, error: `ledger_lookup_failed: ${findErr.message}` };

  if (existing) {
    // Guard against a mismatched reuse of the same Stripe id.
    if (row.user_id && existing.user_id && existing.user_id !== row.user_id) {
      return { ok: false, error: 'ledger_user_mismatch' };
    }
    if (existing.purchase_type && row.purchase_type && existing.purchase_type !== row.purchase_type) {
      return { ok: false, error: 'ledger_purchase_type_mismatch' };
    }
    return { ok: true, ledger: existing, created: false };
  }

  // Insert a fresh 'pending' row. stripe_event_id is set once, here, and is
  // never overwritten by a later event for the same logical payment.
  const insertRow = { ...row, grant_status: 'pending' };
  const { data: inserted, error: insErr } = await db
    .from('stripe_payment_ledger')
    .insert(insertRow)
    .select('*')
    .single();

  if (insErr) {
    // A concurrent delivery may have inserted the row between our SELECT and
    // INSERT; the UNIQUE partial index rejects ours. Re-fetch and use theirs.
    if (insErr.code === '23505') {
      const { data: raced } = await db
        .from('stripe_payment_ledger')
        .select('*')
        .eq(lookupColumn, lookupValue)
        .maybeSingle();
      if (raced) return { ok: true, ledger: raced, created: false };
    }
    return { ok: false, error: `ledger_insert_failed: ${insErr.message}` };
  }

  return { ok: true, ledger: inserted, created: true };
}

async function markPaymentLedgerGranted(db, ledgerId, { creditsGranted } = {}) {
  if (!ledgerId) return { ok: false, error: 'ledger_missing_id' };
  const patch = { grant_status: 'granted', updated_at: new Date().toISOString() };
  if (creditsGranted != null && Number.isFinite(creditsGranted)) {
    patch.credits_granted = Math.max(0, Math.round(creditsGranted));
  }
  // Only advance from 'pending' — never pull a row back out of 'held'/'reversed'
  // set by a dispute/fraud handler that raced ahead of this grant.
  const { error } = await db
    .from('stripe_payment_ledger')
    .update(patch)
    .eq('id', ledgerId)
    .eq('grant_status', 'pending');
  if (error) return { ok: false, error: `ledger_mark_granted_failed: ${error.message}` };
  return { ok: true };
}

// Best-effort back-fill of a ledger row's Stripe ids. Used for subscription
// Checkout Sessions, whose initial charge lives on the generated invoice rather
// than on session.payment_intent, leaving charge_id / payment_intent_id blank
// on the ledger row (which later dispute/fraud lookups need). Only fills columns
// that are still null (never overwrites), never touches stripe_event_id, and
// returns a status object instead of throwing — callers treat failure here as a
// non-critical ledger gap and must NOT let it block the credit grant.
async function enrichPaymentLedgerIds(db, ledgerId, { paymentIntentId, chargeId } = {}) {
  if (!ledgerId || (!paymentIntentId && !chargeId)) return { ok: true, skipped: 'nothing-to-set' };

  const { data: current, error: readErr } = await db
    .from('stripe_payment_ledger')
    .select('payment_intent_id,charge_id')
    .eq('id', ledgerId)
    .maybeSingle();
  if (readErr || !current) return { ok: false, error: readErr ? readErr.message : 'ledger_row_missing' };

  const patch = {};
  if (paymentIntentId && !current.payment_intent_id) patch.payment_intent_id = paymentIntentId;
  if (chargeId && !current.charge_id) patch.charge_id = chargeId;
  if (Object.keys(patch).length === 0) return { ok: true, skipped: 'already-set' };

  patch.updated_at = new Date().toISOString();
  const { error: updErr } = await db
    .from('stripe_payment_ledger')
    .update(patch)
    .eq('id', ledgerId);
  if (updErr) return { ok: false, error: updErr.message };
  return { ok: true, set: Object.keys(patch).filter((k) => k !== 'updated_at') };
}

// Record a Stripe fraud/dispute signal: write the Stripe-side fact into
// payment_risk_events, and move any matching ledger row from 'granted' to
// 'held'. 'held' means "a Stripe-side reversal is on record; the credit
// balance has NOT been clawed back yet" — the actual balance decrement and the
// 'held' -> 'reversed' transition are a later step. This never touches
// credit_balances or the billing RPC.
async function recordPaymentRiskEvent(db, {
  stripeEventId, stripeEventType, stripeObjectId, eventType, chargeId, paymentIntentId, reason
}) {
  // Resolve the user (and the ledger rows to hold) from whichever id we have.
  let userId = null;
  let ledgerRows = [];
  const orParts = [];
  if (chargeId) orParts.push(`charge_id.eq.${chargeId}`);
  if (paymentIntentId) orParts.push(`payment_intent_id.eq.${paymentIntentId}`);
  if (orParts.length) {
    const { data, error } = await db
      .from('stripe_payment_ledger')
      .select('id,user_id,grant_status')
      .or(orParts.join(','));
    if (error) return { ok: false, error: `risk_ledger_lookup_failed: ${error.message}` };
    ledgerRows = data || [];
    if (ledgerRows.length && ledgerRows[0].user_id) userId = ledgerRows[0].user_id;
  }

  // stripe_event_id is UNIQUE, so a Stripe redelivery of the same event no-ops.
  const { error: insErr } = await db
    .from('payment_risk_events')
    .insert({
      stripe_event_id:   stripeEventId,
      stripe_event_type: stripeEventType,
      stripe_object_id:  stripeObjectId,
      user_id:           userId,
      event_type:        eventType,
      charge_id:         chargeId || null,
      reason:            reason || null
    });
  if (insErr && insErr.code !== '23505') {
    return { ok: false, error: `risk_event_insert_failed: ${insErr.message}` };
  }

  let heldCount = 0;
  for (const lr of ledgerRows) {
    if (lr.grant_status !== 'granted') continue;
    const { error: updErr } = await db
      .from('stripe_payment_ledger')
      .update({ grant_status: 'held', updated_at: new Date().toISOString() })
      .eq('id', lr.id)
      .eq('grant_status', 'granted');
    if (updErr) return { ok: false, error: `ledger_hold_failed: ${updErr.message}` };
    heldCount += 1;
  }

  return { ok: true, userId, held: heldCount };
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
  // Day is clamped to the last day of the target month when the anchor day
  // doesn't exist there (e.g. anchor=Jan 31 -> Feb 28/29, not overflowing
  // into March like plain Date.UTC(y, m+1, 31) would).
  let nextGrantAt = null;
  if (billingInterval === 'year' && anchor) {
    const anchorDate = new Date(anchor);
    const anchorDay = anchorDate.getUTCDate();
    const targetYear = anchorDate.getUTCFullYear();
    const targetMonth = anchorDate.getUTCMonth() + 1;
    const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    nextGrantAt = new Date(Date.UTC(
      targetYear,
      targetMonth,
      Math.min(anchorDay, lastDayOfTargetMonth),
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
  const { data: existing, error: existingError } = await db
    .from('user_subscriptions')
    .select('next_credit_grant_at')
    .eq('stripe_subscription_id', sub.id)
    .maybeSingle();
  if (existingError) throw existingError;

  if (!existing) {
    if (nextGrantAt) row.next_credit_grant_at = nextGrantAt;
    row.created_at = new Date().toISOString();
    const { error } = await db.from('user_subscriptions').insert(row);
    if (error) throw error;
  } else {
    // Update period/status but preserve next_credit_grant_at (Cron manages it)
    const { error } = await db.from('user_subscriptions').update(row).eq('stripe_subscription_id', sub.id);
    if (error) throw error;
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

async function handleCheckoutCompleted(db, stripe, session, event) {
  if (session.payment_status && session.payment_status !== 'paid' && session.mode !== 'subscription') {
    return { ok: true, skipped: 'unpaid' };
  }
  const meta = metaFromSession(session);
  if (session.customer && meta.userId) {
    try { await db.from('profiles').update({ stripe_customer_id: session.customer }).eq('id', meta.userId); } catch (_) {}
  }
  if (!meta.userId || !(meta.credits > 0)) return { ok: true, skipped: 'no-metadata' };

  const isSubscription = meta.purchaseType === 'subscription';

  // Step 2: record this payment in stripe_payment_ledger BEFORE granting.
  const ledger = await ensurePaymentLedgerPending(db, {
    lookupColumn: 'checkout_session_id',
    lookupValue:  session.id,
    row: {
      user_id:             meta.userId,
      checkout_session_id: session.id,
      payment_intent_id:   session.payment_intent ? String(session.payment_intent) : null,
      invoice_id:          session.invoice ? String(session.invoice) : null,
      customer_id:         session.customer ? String(session.customer) : null,
      subscription_id:     session.subscription ? String(session.subscription) : null,
      purchase_type:       isSubscription ? 'subscription' : 'credit_pack',
      amount:              ledgerAmount(session.amount_total),
      currency:            ledgerCurrency(session.currency),
      credits_granted:     0,
      stripe_event_id:     event && event.id ? event.id : null
    }
  });
  if (!ledger.ok) return { ok: false, error: ledger.error };

  let result;
  if (isSubscription) {
    // Fetch the Stripe subscription to upsert into user_subscriptions
    if (session.subscription) {
      const sub = await stripe.subscriptions.retrieve(session.subscription);
      await upsertSubscription(db, sub, session.metadata || {});

      // Step 2 (Y): the initial subscription charge is on the generated invoice,
      // not on session.payment_intent, so back-fill the ledger row's ids from
      // that invoice. Best-effort: any failure here is logged and swallowed so
      // the credit grant below is never blocked by it.
      try {
        const invoiceId = session.invoice || sub.latest_invoice || null;
        if (invoiceId && ledger.ledger && ledger.ledger.id) {
          const inv = await stripe.invoices.retrieve(String(invoiceId), { expand: ['payment_intent'] });
          const pi = inv && inv.payment_intent;
          const paymentIntentId = pi ? String(typeof pi === 'string' ? pi : pi.id) : null;
          const chargeId = inv && inv.charge
            ? String(inv.charge)
            : (pi && typeof pi === 'object' && pi.latest_charge ? String(pi.latest_charge) : null);
          const enrich = await enrichPaymentLedgerIds(db, ledger.ledger.id, { paymentIntentId, chargeId });
          if (!enrich.ok) {
            console.error('[stripe-webhook] initial-subscription ledger id back-fill error:', enrich.error);
          }
        }
      } catch (e) {
        console.error('[stripe-webhook] initial-subscription ledger id back-fill failed:', e && e.message);
      }
    }

    result = await grantCredits(db, {
      userId:     meta.userId,
      credits:    meta.credits,
      pool:       'subscription_credits',
      creditType: 'subscription',
      reason:     reasonTag('session', session.id),
      plan:       meta.plan || null
    });
  } else {
    result = await grantCredits(db, {
      userId:     meta.userId,
      credits:    meta.credits,
      pool:       'purchased_credits',
      creditType: 'purchased',
      reason:     reasonTag('session', session.id)
    });
  }

  // Step 2: flip the ledger row to 'granted' once credits are in (grantCredits
  // returns ok:true both on a fresh grant and on an idempotent 'duplicate').
  if (result && result.ok) {
    const marked = await markPaymentLedgerGranted(db, ledger.ledger.id, { creditsGranted: meta.credits });
    if (!marked.ok) return { ok: false, error: marked.error };
  }
  return result;
}

async function handleInvoicePaid(db, stripe, invoice, event) {
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
      const sub = await stripe.subscriptions.retrieve(invoice.subscription);
      await upsertSubscription(db, sub, subMeta);
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

  // Step 2: record this renewal payment in stripe_payment_ledger BEFORE granting.
  const ledger = await ensurePaymentLedgerPending(db, {
    lookupColumn: 'invoice_id',
    lookupValue:  invoice.id,
    row: {
      user_id:           meta.userId,
      invoice_id:        invoice.id,
      payment_intent_id: invoice.payment_intent ? String(invoice.payment_intent) : null,
      charge_id:         invoice.charge ? String(invoice.charge) : null,
      customer_id:       invoice.customer ? String(invoice.customer) : null,
      subscription_id:   invoice.subscription ? String(invoice.subscription) : null,
      purchase_type:     'subscription',
      amount:            ledgerAmount(invoice.amount_paid),
      currency:          ledgerCurrency(invoice.currency),
      credits_granted:   0,
      stripe_event_id:   event && event.id ? event.id : null
    }
  });
  if (!ledger.ok) return { ok: false, error: ledger.error };

  const result = await grantCredits(db, {
    userId:     meta.userId,
    credits:    meta.credits,
    pool:       'subscription_credits',
    creditType: 'subscription',
    reason:     reasonTag('invoice', invoice.id),
    plan:       meta.plan || null
  });

  // Step 2: flip the ledger row to 'granted' once credits are in.
  if (result && result.ok) {
    const marked = await markPaymentLedgerGranted(db, ledger.ledger.id, { creditsGranted: meta.credits });
    if (!marked.ok) return { ok: false, error: marked.error };
  }
  return result;
}

// Subscription statuses that mean the subscription is no longer entitling the
// user to paid features (as opposed to cancel_at_period_end=true, which stays
// active until the period actually ends). profiles.plan is a display hint only
// (real entitlement checks use credit_balances.subscription_expires_at), but we
// still clear it here so a canceled/ended subscription doesn't leave a stale
// paid plan name on profiles.
const SUBSCRIPTION_ENDED_STATUSES = ['canceled', 'unpaid', 'incomplete_expired'];

// Statuses that still entitle the user while this particular subscription
// object is concerned (mirrors the Cron RPC's own 'active'/'past_due' notion
// of "still valid", plus 'trialing').
const SUBSCRIPTION_ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

async function clearProfilePlanIfEnded(db, sub) {
  const userId = sub.metadata?.user_id || '';
  if (!userId) return;

  // The subscription that just ended may not be the user's only one — do not
  // blindly downgrade to free if another subscription for this user is still
  // active (e.g. an out-of-order webhook for an already-replaced plan).
  const { data: others, error: lookupErr } = await db
    .from('user_subscriptions')
    .select('plan,status,current_period_end')
    .eq('user_id', userId)
    .neq('stripe_subscription_id', sub.id)
    .in('status', SUBSCRIPTION_ACTIVE_STATUSES)
    .order('current_period_end', { ascending: false, nullsFirst: false });

  if (lookupErr) {
    console.error('[stripe-webhook] active-subscription lookup failed:', lookupErr.message, 'userId:', userId);
    throw lookupErr;
  }

  const stillActive = (others || []).find(
    (row) => !row.current_period_end || new Date(row.current_period_end) > new Date()
  );

  const nextPlan = stillActive ? stillActive.plan : 'free';
  const { error } = await db.from('profiles').update({ plan: nextPlan }).eq('id', userId);
  if (error) throw error;
}

async function handleSubscriptionUpdated(db, sub) {
  // Keep user_subscriptions in sync with Stripe
  const meta = sub.metadata || {};
  await upsertSubscription(db, sub, meta);
  if (SUBSCRIPTION_ENDED_STATUSES.includes(sub.status)) {
    await clearProfilePlanIfEnded(db, sub);
  }
  return { ok: true };
}

async function handleSubscriptionDeleted(db, sub) {
  const { error } = await db
    .from('user_subscriptions')
    .update({ status: sub.status || 'canceled', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', sub.id);
  if (error) throw error;
  await clearProfilePlanIfEnded(db, sub);
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
      result = await handleCheckoutCompleted(db, stripe, event.data.object, event);
    } else if (event.type === 'invoice.payment_succeeded') {
      result = await handleInvoicePaid(db, stripe, event.data.object, event);
    } else if (event.type === 'customer.subscription.updated') {
      result = await handleSubscriptionUpdated(db, event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      result = await handleSubscriptionDeleted(db, event.data.object);
    } else if (event.type === 'charge.dispute.created') {
      const d = event.data.object || {};
      result = await recordPaymentRiskEvent(db, {
        stripeEventId:   event.id,
        stripeEventType: event.type,
        stripeObjectId:  d.id,
        eventType:       'dispute',
        chargeId:        d.charge ? String(d.charge) : null,
        paymentIntentId: d.payment_intent ? String(d.payment_intent) : null,
        reason:          d.reason || null
      });
    } else if (event.type === 'radar.early_fraud_warning.created') {
      const w = event.data.object || {};
      result = await recordPaymentRiskEvent(db, {
        stripeEventId:   event.id,
        stripeEventType: event.type,
        stripeObjectId:  w.id,
        eventType:       'early_fraud_warning',
        chargeId:        w.charge ? String(w.charge) : null,
        paymentIntentId: w.payment_intent ? String(w.payment_intent) : null,
        reason:          w.fraud_type || null
      });
    } else if (event.type === 'review.opened') {
      const rv = event.data.object || {};
      result = await recordPaymentRiskEvent(db, {
        stripeEventId:   event.id,
        stripeEventType: event.type,
        stripeObjectId:  rv.id,
        eventType:       'review',
        chargeId:        rv.charge ? String(rv.charge) : null,
        paymentIntentId: rv.payment_intent ? String(rv.payment_intent) : null,
        reason:          rv.reason || null
      });
    }

    if (result && !result.ok && !result.skipped) {
      console.error('[stripe-webhook] handler failed:', event.type, JSON.stringify(result));
      return res.status(500).json({ ok: false, type: event.type, eventId: event.id, result });
    }
    return res.status(200).json({ ok: true, type: event.type, eventId: event.id, result });
  } catch (e) {
    // Return 500 so Stripe retries on transient failures
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
