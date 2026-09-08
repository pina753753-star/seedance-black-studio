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

// ── Chargeback / fraud countermeasure (Step 2) ──────────────────────────────
// stripe_payment_ledger is an append-first ledger that links Stripe payment
// objects to a user. It is populated ONLY here (webhook code, service role) and
// is deliberately kept OUT of grant_stripe_credits_atomic so the working
// billing RPC and its migration stay untouched. Ledger write and credit grant
// (or ledger-only confirmation, for annual renewals) are done via dedicated
// atomic RPCs so there is no window where a crash leaves credits granted but
// the ledger still 'pending', or the ledger 'granted' while an open dispute
// exists. The flow around a credit-granting call site is:
//   1. ensurePaymentLedgerPending()  — insert (or re-find) a 'pending' row
//   2. grantCreditsWithLedger()      — grant_stripe_credits_with_ledger_atomic:
//                                      locks the ledger row, re-checks for an
//                                      open/reviewing risk event, grants
//                                      credits via grant_stripe_credits_atomic,
//                                      and flips the row to 'granted' — all in
//                                      one transaction.
// A ledger-only confirmation (annual renewal invoices, which do not grant
// credits here) uses markPaymentLedgerGranted() ->
// confirm_payment_ledger_without_credit_atomic instead, which is the same
// atomic sequence minus the credit grant. Stripe's at-least-once redelivery
// re-running either RPC is idempotent (grant_stripe_credits_atomic reports
// 'duplicate'; the ledger row is already 'granted' and the RPC no-ops via its
// already-granted check). If step 1 fails we do NOT grant and return an
// error (HTTP 500) so Stripe redelivers.
function ledgerCurrency(value) {
  return typeof value === 'string' && /^[a-zA-Z]{3}$/.test(value) ? value : null;
}

function ledgerAmount(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

// Stripe fields are sometimes an expanded object, sometimes a bare id string.
function stripeObjectId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value.id ? String(value.id) : null;
}

// Resolves an invoice's payment_intent_id / charge_id, covering both the
// classic Invoice shape (invoice.payment_intent / invoice.charge) and the
// newer Invoice Payments API shape (invoice.payments.data[], where the
// payment_intent lives one level deeper under each payment's `.payment`).
async function resolveInvoicePaymentIds(stripe, invoiceOrId) {
  let invoice = invoiceOrId;

  if (typeof invoiceOrId === 'string') {
    invoice = await stripe.invoices.retrieve(invoiceOrId);
  }

  let paymentIntentId = stripeObjectId(invoice && invoice.payment_intent);
  let chargeId = stripeObjectId(invoice && invoice.charge);

  // New Invoice Payments API fallback (no top-level payment_intent field).
  if (!paymentIntentId) {
    const payments = (invoice && invoice.payments && invoice.payments.data) || [];
    const invoicePayment =
      payments.find((p) => p.status === 'paid' && p.is_default) ||
      payments.find((p) => p.status === 'paid') ||
      payments[0];

    if (invoicePayment && invoicePayment.payment && invoicePayment.payment.type === 'payment_intent') {
      paymentIntentId = stripeObjectId(invoicePayment.payment.payment_intent);
    }
  }

  if (paymentIntentId && !chargeId) {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    chargeId = stripeObjectId(paymentIntent.latest_charge);
  }

  return { paymentIntentId, chargeId };
}

// Fields that must not silently change value between two writes of "the same"
// ledger row (matched by checkout_session_id / invoice_id). A mismatch here
// means the incoming Stripe payload disagrees with what we already recorded
// for this id, which should never happen for a genuine redelivery.
function validateExistingLedger(existing, incoming) {
  const immutableFields = [
    'user_id',
    'purchase_type',
    'amount',
    'currency',
    'customer_id',
    'subscription_id'
  ];

  for (const field of immutableFields) {
    const oldValue = existing[field];
    const newValue = incoming[field];

    if (
      oldValue != null &&
      newValue != null &&
      String(oldValue) !== String(newValue)
    ) {
      return {
        ok: false,
        error: `ledger_${field}_mismatch`
      };
    }
  }

  return { ok: true };
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
    const check = validateExistingLedger(existing, row);
    if (!check.ok) return check;
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
      const { data: raced, error: raceReadErr } = await db
        .from('stripe_payment_ledger')
        .select('*')
        .eq(lookupColumn, lookupValue)
        .maybeSingle();
      if (raceReadErr) return { ok: false, error: `ledger_race_lookup_failed: ${raceReadErr.message}` };
      if (raced) {
        const check = validateExistingLedger(raced, row);
        if (!check.ok) return check;
        return { ok: true, ledger: raced, created: false };
      }
    }
    return { ok: false, error: `ledger_insert_failed: ${insErr.message}` };
  }

  return { ok: true, ledger: inserted, created: true };
}

// Confirms a ledger row to 'granted' WITHOUT granting any credits (e.g. an
// annual renewal invoice, where the monthly credit grant is handled
// separately by the Cron job). Calls confirm_payment_ledger_without_credit_atomic,
// which is grant_stripe_credits_with_ledger_atomic with the credit-grant step
// removed: same row lock, same user-match check, same held/reversed early
// return, same open/reviewing risk re-check — so an annual renewal invoice is
// never confirmed 'granted' while a dispute/fraud signal is on record for it.
async function markPaymentLedgerGranted(db, ledgerId, userId) {
  if (!ledgerId) return { ok: false, error: 'ledger_missing_id' };
  if (!userId) return { ok: false, error: 'ledger_missing_user_id' };

  const { data, error } = await db.rpc('confirm_payment_ledger_without_credit_atomic', {
    p_ledger_id: ledgerId,
    p_user_id: userId
  });

  if (error) {
    console.error('[stripe-webhook] atomic ledger-only confirm failed:', error.message, 'ledgerId:', ledgerId);
    return { ok: false, error: `atomic_ledger_confirm_failed: ${error.message}` };
  }

  if (!data || data.ok !== true) {
    return { ok: false, error: 'atomic_ledger_confirm_invalid_response' };
  }

  return data;
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

  if (paymentIntentId || chargeId) {
    patch.id_enrichment_status = 'complete';
    patch.id_enrichment_error = null;
  }

  if (Object.keys(patch).length === 0) return { ok: true, skipped: 'already-set' };

  patch.updated_at = new Date().toISOString();
  const { data: updated, error: updErr } = await db
    .from('stripe_payment_ledger')
    .update(patch)
    .eq('id', ledgerId)
    .select('id,payment_intent_id,charge_id,id_enrichment_status')
    .maybeSingle();
  if (updErr) return { ok: false, error: updErr.message };
  if (!updated) return { ok: false, error: 'ledger_enrichment_updated_zero_rows' };
  return {
    ok: true,
    set: Object.keys(patch).filter((k) => k !== 'updated_at' && k !== 'id_enrichment_error')
  };
}

// Persists that a ledger row's Stripe id back-fill failed, so the gap is
// visible in the table itself (id_enrichment_status='needs_review') instead
// of only in a console.error line that no one is watching.
async function markLedgerEnrichmentNeedsReview(db, ledgerId, error) {
  const message = String((error && error.message) || error || 'unknown').slice(0, 1000);

  const { data, error: updateErr } = await db
    .from('stripe_payment_ledger')
    .update({
      id_enrichment_status: 'needs_review',
      id_enrichment_error: message,
      updated_at: new Date().toISOString()
    })
    .eq('id', ledgerId)
    .select('id')
    .maybeSingle();

  if (updateErr || !data) {
    console.error(
      '[stripe-webhook] could not persist ledger enrichment failure:',
      (updateErr && updateErr.message) || 'ledger row not updated'
    );
  }
}

// Grants credits and confirms the payment ledger row in a single database
// transaction via grant_stripe_credits_with_ledger_atomic. This replaces the
// old two-step sequence of a plain grant_stripe_credits_atomic call followed
// by a separate markPaymentLedgerGranted() update, for every call site that
// grants credits (checkout completion, monthly renewal) — closing the window
// where a crash between the two left the ledger row 'pending' after credits
// were already granted. Ledger confirmations that do NOT grant credits
// (annual renewal invoices) still use markPaymentLedgerGranted() directly.
async function grantCreditsWithLedger(db, { ledgerId, userId, credits, pool, creditType, reason, plan }) {
  if (!ledgerId) return { ok: false, error: 'ledger_missing_id' };
  if (!userId || !(credits > 0)) return { ok: false, skipped: 'no-credits' };

  const expectedCreditType = pool === 'subscription_credits'
    ? 'subscription'
    : pool === 'purchased_credits'
      ? 'purchased'
      : '';
  if (!expectedCreditType || creditType !== expectedCreditType) {
    return { ok: false, error: 'invalid_credit_pool' };
  }

  const { data, error } = await db.rpc('grant_stripe_credits_with_ledger_atomic', {
    p_ledger_id: ledgerId,
    p_user_id: userId,
    p_credits: Math.round(credits),
    p_pool: pool,
    p_reason: reason,
    p_expires_at: calcExpiresAt(pool),
    p_plan: plan || null
  });

  if (error) {
    console.error('[stripe-webhook] atomic ledger credit grant failed:', error.message, 'reason:', reason);
    return { ok: false, error: `atomic_ledger_credit_grant_failed: ${error.message}` };
  }

  if (!data || data.ok !== true) {
    return { ok: false, error: 'atomic_ledger_credit_grant_invalid_response' };
  }

  return data;
}

// Record a Stripe fraud/dispute signal: write the Stripe-side fact into
// payment_risk_events, and move any matching ledger row from 'pending'/
// 'granted' to 'held'. 'held' means "a Stripe-side reversal is on record;
// the credit balance has NOT been clawed back yet" — the actual balance
// decrement and the 'held' -> 'reversed' transition are a later step. This
// never touches credit_balances or the billing RPC. The insert-and-hold
// sequence runs atomically in record_payment_risk_event_atomic so a grant
// racing this event cannot slip through between the two writes.
async function recordPaymentRiskEvent(db, {
  stripeEventId, stripeEventType, stripeObjectId, eventType, chargeId, paymentIntentId, reason
}) {
  const { data, error } = await db.rpc('record_payment_risk_event_atomic', {
    p_stripe_event_id: stripeEventId,
    p_stripe_event_type: stripeEventType,
    p_stripe_object_id: stripeObjectId,
    p_event_type: eventType,
    p_charge_id: chargeId || null,
    p_payment_intent_id: paymentIntentId || null,
    p_reason: reason || null
  });

  if (error) {
    console.error('[stripe-webhook] atomic risk event record failed:', error.message, 'eventType:', eventType);
    return { ok: false, error: `atomic_risk_event_record_failed: ${error.message}` };
  }

  if (!data || data.ok !== true) {
    return { ok: false, error: 'atomic_risk_event_record_invalid_response' };
  }

  return data;
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
  // A credit-pack purchase's payment_intent_id is already final at this
  // point (no later invoice back-fill happens for it, unlike the
  // subscription branch below), so mark enrichment 'complete' immediately
  // when we have it instead of leaving it at the column's 'pending' default.
  const paymentIntentId = stripeObjectId(session.payment_intent);
  const ledger = await ensurePaymentLedgerPending(db, {
    lookupColumn: 'checkout_session_id',
    lookupValue:  session.id,
    row: {
      user_id:              meta.userId,
      checkout_session_id:  session.id,
      payment_intent_id:    paymentIntentId,
      invoice_id:           session.invoice ? String(session.invoice) : null,
      customer_id:          session.customer ? String(session.customer) : null,
      subscription_id:      session.subscription ? String(session.subscription) : null,
      purchase_type:        isSubscription ? 'subscription' : 'credit_pack',
      amount:               ledgerAmount(session.amount_total),
      currency:             ledgerCurrency(session.currency),
      credits_granted:      0,
      id_enrichment_status: paymentIntentId ? 'complete' : 'pending',
      stripe_event_id:      event && event.id ? event.id : null
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
      // that invoice. Best-effort: any failure here is persisted as
      // needs_review (and logged) so the credit grant below is never blocked
      // by it, but the gap stays visible instead of only living in logs.
      try {
        const invoiceId = session.invoice || sub.latest_invoice || null;
        if (invoiceId && ledger.ledger && ledger.ledger.id) {
          const { paymentIntentId, chargeId } = await resolveInvoicePaymentIds(stripe, String(invoiceId));
          const enrich = await enrichPaymentLedgerIds(db, ledger.ledger.id, { paymentIntentId, chargeId });
          if (!enrich.ok) {
            console.error('[stripe-webhook] initial-subscription ledger id back-fill error:', enrich.error);
            await markLedgerEnrichmentNeedsReview(db, ledger.ledger.id, enrich.error);
          }
        }
      } catch (e) {
        console.error('[stripe-webhook] initial-subscription ledger id back-fill failed:', e && e.message);
        if (ledger.ledger && ledger.ledger.id) {
          await markLedgerEnrichmentNeedsReview(db, ledger.ledger.id, e);
        }
      }
    }

    result = await grantCreditsWithLedger(db, {
      ledgerId:   ledger.ledger.id,
      userId:     meta.userId,
      credits:    meta.credits,
      pool:       'subscription_credits',
      creditType: 'subscription',
      reason:     reasonTag('session', session.id),
      plan:       meta.plan || null
    });
  } else {
    result = await grantCreditsWithLedger(db, {
      ledgerId:   ledger.ledger.id,
      userId:     meta.userId,
      credits:    meta.credits,
      pool:       'purchased_credits',
      creditType: 'purchased',
      reason:     reasonTag('session', session.id)
    });
  }

  return result;
}

async function handleInvoicePaid(db, stripe, invoice, event) {
  // Initial invoice: already handled by checkout.session.completed
  if (invoice.billing_reason === 'subscription_create') {
    return { ok: true, skipped: 'initial-invoice-handled-by-checkout' };
  }

  const lineMeta = invoice.lines?.data?.[0]?.metadata || {};
  const subMeta  = invoice.subscription_details?.metadata || {};
  const billingInterval = subMeta.billing_interval || lineMeta.billing_interval || 'month';

  // Fetch the subscription (and merge its metadata) up front — both the
  // annual-renewal branch below and the userId/plan/credits resolution need
  // it, and the ledger row below is recorded for every renewal invoice
  // regardless of billing interval.
  let sub = null;
  let mergedSubMeta = subMeta;
  if (invoice.subscription) {
    sub = await stripe.subscriptions.retrieve(invoice.subscription);
    mergedSubMeta = { ...((sub && sub.metadata) || {}), ...subMeta };
  }

  const meta = {
    userId:  invoice.metadata?.user_id || mergedSubMeta.user_id || lineMeta.user_id || '',
    plan:    invoice.metadata?.plan    || mergedSubMeta.plan    || lineMeta.plan    || '',
    credits: Math.round(Number(invoice.metadata?.credits || mergedSubMeta.credits || lineMeta.credits || 0))
  };

  // Step 2: record every renewal payment (monthly or annual) in
  // stripe_payment_ledger, resolving payment_intent_id/charge_id up front so
  // the row is useful for dispute/risk lookups even when no credit grant
  // happens on this invoice (annual renewals).
  let paymentIntentId = null;
  let chargeId = null;
  let enrichmentError = null;
  try {
    const resolved = await resolveInvoicePaymentIds(stripe, invoice);
    paymentIntentId = resolved.paymentIntentId;
    chargeId = resolved.chargeId;

    if (!paymentIntentId && !chargeId) {
      enrichmentError = new Error('invoice_payment_ids_unresolved');
    }
  } catch (e) {
    enrichmentError = e;
  }

  const ledger = await ensurePaymentLedgerPending(db, {
    lookupColumn: 'invoice_id',
    lookupValue:  invoice.id,
    row: {
      user_id:             meta.userId || null,
      invoice_id:          invoice.id,
      payment_intent_id:   paymentIntentId,
      charge_id:           chargeId,
      customer_id:         invoice.customer ? String(invoice.customer) : null,
      subscription_id:     invoice.subscription ? String(invoice.subscription) : null,
      purchase_type:       'subscription',
      amount:              ledgerAmount(invoice.amount_paid),
      currency:            ledgerCurrency(invoice.currency),
      credits_granted:     0,
      id_enrichment_status: (paymentIntentId || chargeId) ? 'complete' : 'pending',
      stripe_event_id:     event && event.id ? event.id : null
    }
  });
  if (!ledger.ok) return { ok: false, error: ledger.error };

  if (
    enrichmentError &&
    ledger.ledger &&
    ledger.ledger.id &&
    !ledger.ledger.payment_intent_id &&
    !ledger.ledger.charge_id
  ) {
    console.error(
      '[stripe-webhook] renewal-invoice ledger id resolution failed:',
      enrichmentError && enrichmentError.message
    );
    await markLedgerEnrichmentNeedsReview(db, ledger.ledger.id, enrichmentError);
  }

  if (billingInterval === 'year') {
    // Update subscription period dates; do NOT grant 12 months of credits
    // here — monthly credit grants for annual subs are handled by the Cron
    // job. Just confirm the ledger row so it does not sit 'pending' forever.
    if (sub) {
      await upsertSubscription(db, sub, subMeta);
    }
    const marked = await markPaymentLedgerGranted(db, ledger.ledger.id, meta.userId || null);
    if (!marked.ok) return marked;
    return { ok: true, skipped: marked.skipped || 'annual-renewal-handled-by-cron', ledgerId: ledger.ledger.id };
  }

  // Monthly renewal: grant one month of credits.
  if (!meta.userId || !(meta.credits > 0)) {
    return { ok: true, skipped: 'ledger-recorded-but-credit-metadata-missing', ledgerId: ledger.ledger.id };
  }

  return grantCreditsWithLedger(db, {
    ledgerId:   ledger.ledger.id,
    userId:     meta.userId,
    credits:    meta.credits,
    pool:       'subscription_credits',
    creditType: 'subscription',
    reason:     reasonTag('invoice', invoice.id),
    plan:       meta.plan || null
  });
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
