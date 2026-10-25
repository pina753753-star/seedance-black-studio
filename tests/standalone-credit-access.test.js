'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAID_PLANS, MODEL_PLANS, activeSubscription, effectiveBalance,
  readSubscriptionAccess, getCreditAccess, taskRequiresWatermark
} = require('../api/_lib/credit-access');

const NOW = Date.parse('2026-10-25T12:00:00Z');
const FUTURE = '2026-11-25T12:00:00Z';
const PAST = '2026-09-25T12:00:00Z';
const OWNER = 'owner';
function fixture({ plan = 'free', accountStatus = 'active', balance = {}, grants = [{ id: 'grant-1', user_id: OWNER, purchase_type: 'credit_pack', grant_status: 'granted' }], risks = [], errors = {}, throws = [] } = {}) {
  const queries = [];
  const rows = {
    profiles: [{ id: OWNER, plan, account_status: accountStatus }],
    credit_balances: [{ user_id: OWNER, free_credits: 0, subscription_credits: 0, purchased_credits: 1000, subscription_expires_at: null, purchased_expires_at: FUTURE, ...balance }],
    stripe_payment_ledger: grants,
    payment_risk_events: risks
  };
  const db = { from(table) {
    if (!Object.hasOwn(rows, table)) throw new Error(`Unexpected table ${table}`);
    const query = { table, filters: [], fields: '', limit: null };
    queries.push(query);
    const chain = {
      select(fields) { query.fields = fields; return chain; },
      eq(field, value) { query.filters.push(row => row[field] === value); return chain; },
      in(field, values) { query.filters.push(row => values.includes(row[field])); return chain; },
      limit(value) { query.limit = value; return chain; },
      async maybeSingle() {
        if (throws.includes(table)) throw new Error('mock query failed');
        if (errors[table]) return { data: null, error: new Error('mock query failed') };
        const matches = rows[table].filter(row => query.filters.every(filter => filter(row)));
        const limited = query.limit === null ? matches : matches.slice(0, query.limit);
        if (limited.length > 1) throw new Error('mock maybeSingle cardinality');
        return { data: limited[0] || null, error: null };
      }
    };
    return chain;
  }};
  return { db, queries, rows, access: (options = {}) => getCreditAccess(db, OWNER, { now: NOW, ...options }) };
}

test('free grants alone cannot unlock restricted models even with a stale settled purchase row', async () => {
  const f = fixture({ balance: { free_credits: 500, purchased_credits: 0 } });
  const a = await f.access();
  assert.equal(a.ok, true); assert.equal(a.allowed, false); assert.equal(a.hasPurchasedAccess, false);
  assert.equal(a.balance, 500); assert.equal(a.watermarkRequired, true);
  assert.equal(f.queries.some(q => q.table === 'stripe_payment_ledger'), false);
});
test('settled purchase unlocks normal model allowlist without changing plan or expiry', async () => {
  const f = fixture(); const before = structuredClone(f.rows);
  for (const paidPlans of [MODEL_PLANS]) {
    const a = await f.access({ paidPlans });
    assert.equal(a.allowed, true); assert.equal(a.hasPurchasedAccess, true);
    assert.equal(a.hasActiveSubscription, false); assert.equal(a.watermarkRequired, true);
    assert.equal(a.plan, 'free'); assert.equal(a.subscriptionExpiresAt, null);
    assert.equal('balanceRow' in a, false);
  }
  assert.deepEqual(f.rows, before);
});
test('expired subscription plus purchased balance keeps model access with watermark', async () => {
  const f = fixture({ plan: 'premium', balance: { subscription_expires_at: PAST, subscription_credits: 800, free_credits: 20 } });
  const a = await f.access();
  assert.equal(a.allowed, true); assert.equal(a.hasActiveSubscription, false);
  assert.equal(a.hasPurchasedAccess, true); assert.equal(a.watermarkRequired, true);
  assert.equal(a.balance, 1020);
});
test('active Premium plus extra credits keeps subscription access without watermark', async () => {
  const f = fixture({ plan: 'premium', balance: { subscription_expires_at: FUTURE, subscription_credits: 800, free_credits: 20 } });
  const a = await f.access();
  assert.equal(a.allowed, true); assert.equal(a.hasActiveSubscription, true);
  assert.equal(a.watermarkRequired, false); assert.equal(a.balance, 1820);
  assert.equal(f.queries.some(q => q.table === 'stripe_payment_ledger'), false);
});
test('Standard plus purchase unlocks 2.5 but retains active subscription watermark exemption', async () => {
  const f = fixture({ plan: 'standard', balance: { subscription_expires_at: FUTURE } });
  const a = await f.access();
  assert.equal(a.allowed, true); assert.equal(a.hasPurchasedAccess, true);
  assert.equal(a.hasActiveSubscription, true); assert.equal(a.watermarkRequired, false);
  assert.equal(a.plan, 'standard');
});
test('Standard without purchase does not gain restricted model subscription benefits', async () => {
  const f = fixture({ plan: 'standard', balance: { subscription_expires_at: FUTURE, purchased_credits: 0, subscription_credits: 800 } });
  assert.equal((await f.access()).allowed, false);

});
for (const expiry of [PAST, null, '', 'not-a-date', new Date(NOW).toISOString()]) {
  test(`purchase expiry ${String(expiry)} cannot unlock models or count expired purchase credits`, async () => {
    const f = fixture({ balance: { purchased_expires_at: expiry, free_credits: 10 } });
    const a = await f.access();
    assert.equal(a.allowed, false); assert.equal(a.hasPurchasedAccess, false);
    assert.equal(a.watermarkRequired, true); assert.equal(a.balance, 10);
  });
}
for (const grant_status of ['held', 'reversed']) {
  test(`${grant_status} ledger blocks new purchase-based access despite another granted payment`, async () => {
    const f = fixture({ grants: [
      { id: 'old-good', user_id: OWNER, purchase_type: 'credit_pack', grant_status: 'granted' },
      { id: 'new-risk', user_id: OWNER, purchase_type: 'credit_pack', grant_status }
    ] });
    const a = await f.access();
    assert.equal(a.allowed, false); assert.equal(a.hasPurchasedAccess, false);
    assert.equal(a.error, 'payment_risk_hold'); assert.equal(a.balance, 1000);
    assert.equal(f.rows.credit_balances[0].purchased_credits, 1000);
  });
}
for (const status of ['open', 'reviewing']) {
  test(`${status} risk blocks new purchase-based access without balance confiscation`, async () => {
    const f = fixture({ risks: [{ id: 'risk', user_id: OWNER, status }] });
    const a = await f.access();
    assert.equal(a.allowed, false); assert.equal(a.error, 'payment_risk_hold');
    assert.equal(a.balance, 1000);
  });
}
test('pending/unsettled, subscription-only and other-owner grants do not prove a purchase', async () => {
  for (const grant of [
    { id: 'pending', user_id: OWNER, purchase_type: 'credit_pack', grant_status: 'pending' },
    { id: 'subscription', user_id: OWNER, purchase_type: 'subscription', grant_status: 'granted' },
    { id: 'other', user_id: 'someone-else', purchase_type: 'credit_pack', grant_status: 'granted' }
  ]) {
    const a = await fixture({ grants: [grant] }).access();
    assert.equal(a.allowed, false); assert.equal(a.hasPurchasedAccess, false);
  }
});
test('another user risk/held payment does not block the owner', async () => {
  const f = fixture({ grants: [
    { id: 'good', user_id: OWNER, purchase_type: 'credit_pack', grant_status: 'granted' },
    { id: 'other-held', user_id: 'someone-else', purchase_type: 'credit_pack', grant_status: 'held' }
  ], risks: [{ id: 'other-risk', user_id: 'someone-else', status: 'open' }] });
  assert.equal((await f.access()).allowed, true);
});
test('profile/balance query errors, exceptions and absent owner rows fail closed', async () => {
  for (const table of ['profiles', 'credit_balances']) {
    for (const mode of ['error', 'throw', 'missing']) {
      const f = fixture({ errors: mode === 'error' ? { [table]: true } : {}, throws: mode === 'throw' ? [table] : [] });
      if (mode === 'missing') f.rows[table] = [];
      const a = await f.access();
      assert.equal(a.ok, false); assert.equal(a.allowed, false);
      assert.equal(a.watermarkRequired, true); assert.equal(a.error, 'plan_lookup_failed');
    }
  }
});
test('purchase/risk lookup errors and exceptions fail closed without altering balances', async () => {
  for (const table of ['stripe_payment_ledger', 'payment_risk_events']) {
    for (const throws of [false, true]) {
      const f = fixture({ errors: throws ? {} : { [table]: true }, throws: throws ? [table] : [] });
      const a = await f.access();
      assert.equal(a.ok, false); assert.equal(a.allowed, false); assert.equal(a.hasPurchasedAccess, false);
      assert.equal(a.error, 'purchase_access_lookup_failed');
      assert.equal(f.rows.credit_balances[0].purchased_credits, 1000);
    }
  }
});
test('account restriction rejects new access, including an active subscriber', async () => {
  for (const plan of ['free', 'premium']) {
    const f = fixture({ plan, accountStatus: 'restricted', balance: { subscription_expires_at: FUTURE } });
    const a = await f.access();
    assert.equal(a.allowed, false); assert.equal(a.error, 'account_restricted');
    assert.equal(a.accountStatus, 'restricted');
  }
});
test('zero remaining purchase balance disables new access but does not change earned task policy', async () => {
  const f = fixture({ balance: { purchased_credits: 0 } });
  const a = await f.access();
  assert.equal(a.allowed, false); assert.equal(a.balance, 0);
  const paidTask = { settings: { watermark_required: false } };
  const purchasedTask = { settings: { watermark_required: true } };
  assert.equal(taskRequiresWatermark(paidTask, a), false);
  assert.equal(taskRequiresWatermark(purchasedTask, a), true);
  assert.deepEqual(paidTask, { settings: { watermark_required: false } });
  // Existing artifact policy is preserved by this helper. Retrieval ownership
  // and actual URL delivery are tested separately at the serving endpoints.
});
test('legacy output policy uses fresh subscription check and fails safe on lookup failure', async () => {
  const active = await readSubscriptionAccess(fixture({ plan: 'premium', balance: { subscription_expires_at: FUTURE } }).db, OWNER, NOW);
  const expired = await readSubscriptionAccess(fixture({ plan: 'premium', balance: { subscription_expires_at: PAST } }).db, OWNER, NOW);
  assert.equal(taskRequiresWatermark({}, active), false);
  assert.equal(taskRequiresWatermark({}, expired), true);
  assert.equal(taskRequiresWatermark({}, { ok: false }), true);
  assert.equal(taskRequiresWatermark({}, undefined), true);
});
test('subscription boundary and effective pools exclude expired balances and negative credit values', () => {
  assert.equal(activeSubscription(' PREMIUM ', FUTURE, NOW), true);
  assert.equal(activeSubscription('premium', new Date(NOW).toISOString(), NOW), false);
  assert.equal(activeSubscription('free', FUTURE, NOW), false);
  assert.equal(effectiveBalance({free_credits: -5, subscription_credits: 800, subscription_expires_at: PAST, purchased_credits: 100, purchased_expires_at: FUTURE}, NOW), 100);
});

test('purchased balance never unlocks subscription-only audio/storyboard entitlement', async () => {
  const { getSeedance25SubscriptionEntitlement } = require('../api/_lib/video-plan-entitlements');
  for (const plan of ['free','standard','premium']) {
    const f = fixture({plan,balance:{subscription_expires_at:plan==='standard'?'2099-01-01':PAST}});
    assert.equal((await getSeedance25SubscriptionEntitlement(f.db,OWNER)).allowed,false);
  }
  const f=fixture({plan:'premium',balance:{subscription_expires_at:'2099-01-01'}});
  assert.equal((await getSeedance25SubscriptionEntitlement(f.db,OWNER)).allowed,true);
});
