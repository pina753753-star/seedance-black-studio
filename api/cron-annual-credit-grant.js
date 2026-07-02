'use strict';
/**
 * GET /api/cron-annual-credit-grant
 *
 * Grants monthly credits to annual subscribers whose next_credit_grant_at has arrived.
 *
 * Authentication:
 *   Authorization: Bearer <CRON_SECRET>
 *   Vercel sets this header automatically on cron-triggered requests.
 *   All requests are rejected if CRON_SECRET is not configured.
 *
 * Safety:
 *   - Only runs in production (VERCEL_ENV === 'production') to avoid
 *     granting real credits from Preview or local environments.
 *   - Atomic DB grant via RPC grant_annual_subscription_credits.
 *   - Max MAX_PER_RUN subscriptions per execution to limit timeout risk.
 *   - Processes in chronological order of next_credit_grant_at.
 *   - Duplicate-safe: the RPC returns 'duplicate' if already granted.
 *   - Catch-up: each subscription is processed once per run; the loop is
 *     bounded by MAX_PER_RUN regardless of how many months were missed.
 *     Re-run on the next Cron tick for additional catch-up.
 *   - Never auto-fails, auto-refunds, or calls generation APIs.
 *
 * Returns: { ok, granted, duplicate, skipped, errors, subscriptions_checked }
 * Does NOT return user emails or client secrets.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL      = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const CRON_SECRET       = process.env.CRON_SECRET || '';

const MAX_PER_RUN = 20;
const GRANT_LOOKAHEAD_MINUTES = 5; // grant if within 5 min of due time

// Status values that are safe to grant credits for
const GRANTABLE_STATUSES = new Set(['active', 'trialing']);
// past_due: do NOT grant to avoid rewarding failed payers
// canceled, incomplete_expired, unpaid: do not grant

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function authenticate(req) {
  if (!CRON_SECRET) return false;
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (!auth.toLowerCase().startsWith('bearer ')) return false;
  return auth.slice(7).trim() === CRON_SECRET;
}

/**
 * Compute the next_credit_grant_at for a subscription after a successful grant.
 *
 * We advance by exactly one calendar month from the billing_cycle_anchor day,
 * using the same anchor-based approach Stripe uses (avoids drift from 30-day adds).
 *
 * For months shorter than the anchor day (e.g. anchor=31, next month=Feb),
 * we clamp to the last day of that month (UTC).
 *
 * @param {Date} anchorDate  - billing_cycle_anchor as Date
 * @param {Date} currentGrant - the next_credit_grant_at that just fired
 * @returns {Date}
 */
function nextGrantDate(anchorDate, currentGrant) {
  const anchorDay = anchorDate.getUTCDate();
  // Advance currentGrant by one calendar month
  const next = new Date(currentGrant);
  next.setUTCMonth(next.getUTCMonth() + 1);
  // Clamp to last day of month if anchorDay overshoots
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(anchorDay, lastDay));
  return next;
}

/**
 * Grant_period = YYYY-MM-01 (first day of the UTC calendar month of the grant).
 * Used as the unique key in annual_credit_grant_log.
 */
function grantPeriodForDate(d) {
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10); // 'YYYY-MM-DD'
}

async function processSubscriptions(db) {
  const results = { granted: 0, duplicate: 0, skipped: 0, errors: 0, subscriptions_checked: 0 };

  const cutoff = new Date(Date.now() + GRANT_LOOKAHEAD_MINUTES * 60 * 1000).toISOString();

  // Fetch due annual subscriptions (ordered by next_credit_grant_at ASC)
  const { data: subs, error } = await db
    .from('user_subscriptions')
    .select('stripe_subscription_id,user_id,monthly_credits,billing_interval,status,cancel_at_period_end,current_period_end,billing_cycle_anchor,next_credit_grant_at')
    .eq('billing_interval', 'year')
    .lte('next_credit_grant_at', cutoff)
    .order('next_credit_grant_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (error) {
    console.error('[cron-annual] DB query failed:', error.message);
    results.errors++;
    return results;
  }

  results.subscriptions_checked = (subs || []).length;

  for (const sub of (subs || [])) {
    // Safety checks
    if (!GRANTABLE_STATUSES.has(sub.status)) {
      results.skipped++;
      continue;
    }
    // Respect cancel_at_period_end: stop after period ends
    if (sub.cancel_at_period_end && sub.current_period_end) {
      if (new Date() >= new Date(sub.current_period_end)) {
        results.skipped++;
        continue;
      }
    }
    if (!(sub.monthly_credits > 0)) {
      results.skipped++;
      continue;
    }

    const grantPeriod = grantPeriodForDate(sub.next_credit_grant_at);

    // Compute next grant date based on billing_cycle_anchor
    const anchor = sub.billing_cycle_anchor ? new Date(sub.billing_cycle_anchor) : new Date(sub.next_credit_grant_at);
    const nextGrant = nextGrantDate(anchor, new Date(sub.next_credit_grant_at));
    // Clamp: don't advance past current_period_end
    let nextGrantAt = nextGrant.toISOString();
    if (sub.current_period_end && nextGrant >= new Date(sub.current_period_end)) {
      nextGrantAt = sub.current_period_end;
    }

    try {
      const { data: rpcResult, error: rpcErr } = await db.rpc('grant_annual_subscription_credits', {
        p_subscription_id: sub.stripe_subscription_id,
        p_grant_period:    grantPeriod,
        p_next_grant_at:   nextGrantAt
      });

      if (rpcErr) {
        console.error('[cron-annual] RPC error for', sub.stripe_subscription_id, ':', rpcErr.message);
        results.errors++;
      } else if (rpcResult === 'granted') {
        results.granted++;
      } else if (rpcResult === 'duplicate') {
        results.duplicate++;
      } else {
        // 'invalid' or unexpected
        results.skipped++;
      }
    } catch (e) {
      console.error('[cron-annual] unexpected error:', e.message);
      results.errors++;
    }
  }

  return results;
}

module.exports = async function handler(req, res) {
  if (!authenticate(req)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Only run against production DB to avoid granting from Preview/local
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(200).json({ ok: true, skipped: 'non-production', env: process.env.VERCEL_ENV });
  }

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  try {
    const results = await processSubscriptions(db);
    return res.status(200).json({ ok: true, ...results });
  } catch (e) {
    console.error('[cron-annual] handler error:', e.message);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
};
