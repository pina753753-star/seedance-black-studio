'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../api/admin-finance.js')._test;

function responseRecorder() {
  return {
    headers: {},
    statusCode: 0,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
}

test('未認証を401、GETを405で拒否する', async () => {
  const getHandler = api.createHandler({ requireAuth: async () => ({ ok: true }), authorize: async () => ({ ok: true }) });
  const getRes = responseRecorder();
  await getHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 405);

  const unauthHandler = api.createHandler({ requireAuth: async () => ({ ok: false, status: 401, body: { ok: false } }) });
  const unauthRes = responseRecorder();
  await unauthHandler({ method: 'POST', body: { period: 'thisMonth' } }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);
});

test('管理者以外を403で拒否する', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin' }, supabase: {} }),
    authorize: async () => ({ ok: false })
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { period: 'thisMonth' } }, res);
  assert.equal(res.statusCode, 403);
});

test('管理者メールとprofiles.role=adminの両方を確認する', async () => {
  function authWith(profile, email = 'hinaran53@gmail.com') {
    return {
      user: { id: 'admin-id', email },
      supabase: {
        from(table) {
          assert.equal(table, 'profiles');
          return {
            select() {
              return {
                eq(column, value) {
                  assert.equal(column, 'id');
                  assert.equal(value, 'admin-id');
                  return { maybeSingle: async () => ({ data: profile, error: null }) };
                }
              };
            }
          };
        }
      }
    };
  }

  const ok = await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'admin' }));
  assert.equal(ok.ok, true);

  const wrongRole = await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'user' }));
  assert.equal(wrongRole.ok, false);

  const wrongEmail = await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'admin' }, 'someone-else@example.com'));
  assert.equal(wrongEmail.ok, false);
});

test('不正なperiodは400を返す', () => {
  assert.equal(api.validatePeriodPayload({}), null);
  assert.equal(api.validatePeriodPayload({ period: 'yesterday' }), null);
  assert.deepEqual(api.validatePeriodPayload({ period: 'thisMonth' }), { period: 'thisMonth' });
});

test('periodRangeSecondsはJST基準で今月/先月/今年の範囲を返す', () => {
  // 2026-08-23 12:00 UTC = 2026-08-23 21:00 JST
  const now = new Date('2026-08-23T12:00:00Z');

  const thisMonth = api.periodRangeSeconds('thisMonth', now);
  assert.equal(new Date(thisMonth.gte * 1000).toISOString(), '2026-07-31T15:00:00.000Z'); // 2026-08-01 00:00 JST
  assert.equal(new Date(thisMonth.lt * 1000).toISOString(), '2026-08-31T15:00:00.000Z'); // 2026-09-01 00:00 JST

  const lastMonth = api.periodRangeSeconds('lastMonth', now);
  assert.equal(new Date(lastMonth.gte * 1000).toISOString(), '2026-06-30T15:00:00.000Z'); // 2026-07-01 00:00 JST
  assert.equal(new Date(lastMonth.lt * 1000).toISOString(), '2026-07-31T15:00:00.000Z'); // 2026-08-01 00:00 JST

  const thisYear = api.periodRangeSeconds('thisYear', now);
  assert.equal(new Date(thisYear.gte * 1000).toISOString(), '2025-12-31T15:00:00.000Z'); // 2026-01-01 00:00 JST
  assert.equal(new Date(thisYear.lt * 1000).toISOString(), '2026-12-31T15:00:00.000Z'); // 2027-01-01 00:00 JST
});

test('classifyBalanceTransactionはinvoiceの有無でサブスク/クレジットを判定する', () => {
  assert.equal(api.classifyBalanceTransaction({ source: { invoice: 'in_123' } }), 'subscription');
  assert.equal(api.classifyBalanceTransaction({ source: { invoice: null } }), 'credit');
  assert.equal(api.classifyBalanceTransaction({ source: null }), 'unknown');
  assert.equal(api.classifyBalanceTransaction({}), 'unknown');
});

test('listAllBalanceTransactionsはhas_moreをページングして全件取得する', async () => {
  const calls = [];
  const stripe = {
    balanceTransactions: {
      list: async (params) => {
        calls.push(params);
        if (!params.starting_after) {
          return { data: [{ id: 'txn_1' }, { id: 'txn_2' }], has_more: true };
        }
        return { data: [{ id: 'txn_3' }], has_more: false };
      }
    }
  };

  const results = await api.listAllBalanceTransactions(stripe, { type: 'charge' });
  assert.equal(results.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].starting_after, 'txn_2');
});

test('aggregateFinanceはcharge/refundを合算し、内訳を分類する', async () => {
  const stripe = {
    balanceTransactions: {
      list: async (params) => {
        if (params.type === 'charge') {
          return {
            data: [
              { id: 'txn_sub', amount: 1000, fee: 40, net: 960, currency: 'jpy', source: { invoice: 'in_1' } },
              { id: 'txn_credit', amount: 500, fee: 20, net: 480, currency: 'jpy', source: { invoice: null } },
              { id: 'txn_unknown', amount: 300, fee: 10, net: 290, currency: 'jpy', source: null }
            ],
            has_more: false
          };
        }
        if (params.type === 'refund') {
          return {
            data: [
              { id: 'txn_refund', amount: -500, fee: -20, net: -480, currency: 'jpy', source: { invoice: null } }
            ],
            has_more: false
          };
        }
        return { data: [], has_more: false };
      }
    }
  };

  const result = await api.aggregateFinance(stripe, { gte: 1, lt: 2 });

  assert.equal(result.grossAmount, 1000 + 500 + 300 - 500);
  assert.equal(result.fee, 40 + 20 + 10 - 20);
  assert.equal(result.net, 960 + 480 + 290 - 480);
  assert.equal(result.breakdown.subscription, 1000);
  assert.equal(result.breakdown.credit, 500 - 500);
  assert.equal(result.breakdown.unknown, 300);
  assert.equal(result.transactionCount, 4);
  assert.equal(result.currency, 'jpy');
});

test('正常系: 管理者がthisMonthを指定すると集計結果を返す', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    createStripeClient: () => ({ fake: true }),
    aggregate: async (stripe, range) => {
      assert.ok(stripe.fake);
      assert.ok(typeof range.gte === 'number');
      assert.ok(typeof range.lt === 'number');
      return {
        currency: 'jpy',
        grossAmount: 1234,
        fee: 56,
        net: 1178,
        breakdown: { subscription: 1000, credit: 234, unknown: 0 },
        transactionCount: 2
      };
    },
    now: () => new Date('2026-08-23T12:00:00Z')
  });

  const res = responseRecorder();
  await handler({ method: 'POST', body: { period: 'thisMonth' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.period, 'thisMonth');
  assert.equal(res.payload.grossAmount, 1234);
  assert.equal(res.payload.breakdown.subscription, 1000);
});

test('Stripe未設定時は500を返し、Secret Keyはレスポンスに含まれない', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    createStripeClient: () => null
  });

  const res = responseRecorder();
  await handler({ method: 'POST', body: { period: 'thisMonth' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.ok, false);
  assert.equal(JSON.stringify(res.payload).includes('sk_'), false);
});

test('不正なperiodをPOSTすると400を返す', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } })
  });

  const res = responseRecorder();
  await handler({ method: 'POST', body: { period: 'invalid' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.ok, false);
});
