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

test('classifyBalanceTransactionはtype=chargeの場合、sourceのinvoice有無で判定する', () => {
  assert.equal(api.classifyBalanceTransaction({ type: 'charge', source: { invoice: 'in_123' } }), 'subscription');
  assert.equal(api.classifyBalanceTransaction({ type: 'charge', source: { invoice: null } }), 'credit');
  assert.equal(api.classifyBalanceTransaction({ type: 'charge', source: null }), 'unknown');
  assert.equal(api.classifyBalanceTransaction({}), 'unknown');
});

test('classifyBalanceTransactionはtype=refundの場合、元Charge(source.charge)のinvoice有無で判定する', () => {
  // サブスクChargeのrefund → subscription
  assert.equal(
    api.classifyBalanceTransaction({
      type: 'refund',
      source: { object: 'refund', charge: { id: 'ch_sub', invoice: 'in_1' } }
    }),
    'subscription'
  );

  // 追加クレジットChargeのrefund → credit
  assert.equal(
    api.classifyBalanceTransaction({
      type: 'refund',
      source: { object: 'refund', charge: { id: 'ch_credit', invoice: null } }
    }),
    'credit'
  );

  // 元Chargeが展開されておらず文字列IDのみ、または取得できない場合 → unknown
  assert.equal(
    api.classifyBalanceTransaction({
      type: 'refund',
      source: { object: 'refund', charge: 'ch_not_expanded' }
    }),
    'unknown'
  );
  assert.equal(
    api.classifyBalanceTransaction({
      type: 'refund',
      source: { object: 'refund', charge: null }
    }),
    'unknown'
  );
  assert.equal(
    api.classifyBalanceTransaction({ type: 'refund', source: null }),
    'unknown'
  );
});

test('resolveChargeForClassificationはtype=chargeのsourceをそのままChargeとして扱う', () => {
  const charge = { id: 'ch_1', invoice: 'in_1' };
  assert.equal(api.resolveChargeForClassification({ type: 'charge', source: charge }), charge);
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

test('aggregateFinanceはcharge/refundを合算し、内訳を分類する(refundは元Chargeのinvoiceで判定)', async () => {
  const stripe = {
    balanceTransactions: {
      list: async (params) => {
        if (params.type === 'charge') {
          return {
            data: [
              { id: 'txn_sub', type: 'charge', amount: 1000, fee: 40, net: 960, currency: 'jpy', source: { id: 'ch_sub', invoice: 'in_1' } },
              { id: 'txn_credit', type: 'charge', amount: 500, fee: 20, net: 480, currency: 'jpy', source: { id: 'ch_credit', invoice: null } },
              { id: 'txn_unknown', type: 'charge', amount: 300, fee: 10, net: 290, currency: 'jpy', source: null }
            ],
            has_more: false
          };
        }
        if (params.type === 'refund') {
          // このrefundはサブスクChargeへの返金(source.charge.invoiceあり)。
          return {
            data: [
              {
                id: 'txn_refund_sub',
                type: 'refund',
                amount: -500,
                fee: -20,
                net: -480,
                currency: 'jpy',
                source: { object: 'refund', charge: { id: 'ch_sub', invoice: 'in_1' } }
              }
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
  assert.equal(result.breakdown.subscription, 1000 - 500);
  assert.equal(result.breakdown.credit, 500);
  assert.equal(result.breakdown.unknown, 300);
  assert.equal(result.transactionCount, 4);
  assert.equal(result.currency, 'jpy');
});

test('aggregateFinance: サブスクChargeのrefundはsubscriptionから減算される', async () => {
  const stripe = {
    balanceTransactions: {
      list: async (params) => {
        if (params.type === 'charge') {
          return {
            data: [
              { id: 'txn_sub', type: 'charge', amount: 2000, fee: 80, net: 1920, currency: 'jpy', source: { id: 'ch_sub', invoice: 'in_1' } }
            ],
            has_more: false
          };
        }
        if (params.type === 'refund') {
          return {
            data: [
              {
                id: 'txn_refund_sub',
                type: 'refund',
                amount: -2000,
                fee: -80,
                net: -1920,
                currency: 'jpy',
                source: { object: 'refund', charge: { id: 'ch_sub', invoice: 'in_1' } }
              }
            ],
            has_more: false
          };
        }
        return { data: [], has_more: false };
      }
    }
  };

  const result = await api.aggregateFinance(stripe, { gte: 1, lt: 2 });
  assert.equal(result.breakdown.subscription, 0);
  assert.equal(result.breakdown.credit, 0);
  assert.equal(result.breakdown.unknown, 0);
});

test('aggregateFinance: 追加クレジットChargeのrefundはcreditから減算される', async () => {
  const stripe = {
    balanceTransactions: {
      list: async (params) => {
        if (params.type === 'charge') {
          return {
            data: [
              { id: 'txn_credit', type: 'charge', amount: 1500, fee: 60, net: 1440, currency: 'jpy', source: { id: 'ch_credit', invoice: null } }
            ],
            has_more: false
          };
        }
        if (params.type === 'refund') {
          return {
            data: [
              {
                id: 'txn_refund_credit',
                type: 'refund',
                amount: -1500,
                fee: -60,
                net: -1440,
                currency: 'jpy',
                source: { object: 'refund', charge: { id: 'ch_credit', invoice: null } }
              }
            ],
            has_more: false
          };
        }
        return { data: [], has_more: false };
      }
    }
  };

  const result = await api.aggregateFinance(stripe, { gte: 1, lt: 2 });
  assert.equal(result.breakdown.subscription, 0);
  assert.equal(result.breakdown.credit, 0);
  assert.equal(result.breakdown.unknown, 0);
});

test('aggregateFinance: 元Chargeを確認できないrefundはunknownに分類される', async () => {
  const stripe = {
    balanceTransactions: {
      list: async (params) => {
        if (params.type === 'charge') {
          return { data: [], has_more: false };
        }
        if (params.type === 'refund') {
          return {
            data: [
              {
                id: 'txn_refund_unexpanded',
                type: 'refund',
                amount: -700,
                fee: -25,
                net: -675,
                currency: 'jpy',
                // Refund.chargeが文字列IDのまま(未展開)のケース
                source: { object: 'refund', charge: 'ch_not_expanded' }
              }
            ],
            has_more: false
          };
        }
        return { data: [], has_more: false };
      }
    }
  };

  const result = await api.aggregateFinance(stripe, { gte: 1, lt: 2 });
  assert.equal(result.breakdown.unknown, -700);
  assert.equal(result.breakdown.subscription, 0);
  assert.equal(result.breakdown.credit, 0);
});

test('listAllBalanceTransactionsは上限到達かつhas_more継続中なら例外を投げ、不完全な集計を返さない', async () => {
  let callCount = 0;
  const stripe = {
    balanceTransactions: {
      list: async () => {
        callCount += 1;
        // 常にhas_more:trueを返し続ける(上限に達しても後続ページが存在する状態を再現)。
        const data = Array.from({ length: 100 }, (_, i) => ({ id: `txn_${callCount}_${i}` }));
        return { data, has_more: true };
      }
    }
  };

  await assert.rejects(
    () => api.listAllBalanceTransactions(stripe, { type: 'charge' }),
    (err) => err.message === 'FINANCE_PAGE_LIMIT_EXCEEDED'
  );

  // 上限(20000件 = 200ページ分)を超えたところで停止していること。
  assert.equal(callCount, api.BALANCE_TRANSACTIONS_MAX_RESULTS / 100);
});

test('aggregateFinanceも上限超過時は集計結果を返さずエラーになる', async () => {
  const stripe = {
    balanceTransactions: {
      list: async () => ({
        data: Array.from({ length: 100 }, (_, i) => ({ id: `txn_${i}` })),
        has_more: true
      })
    }
  };

  await assert.rejects(
    () => api.aggregateFinance(stripe, { gte: 1, lt: 2 }),
    (err) => err.message === 'FINANCE_PAGE_LIMIT_EXCEEDED'
  );
});

test('APIハンドラは上限超過時、集計結果ではなく500エラーを返す(Secret Keyは含まれない)', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    createStripeClient: () => ({ fake: true }),
    aggregate: async () => {
      throw new Error('FINANCE_PAGE_LIMIT_EXCEEDED');
    }
  });

  const res = responseRecorder();
  await handler({ method: 'POST', body: { period: 'thisMonth' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error, 'FINANCE_RANGE_TOO_LARGE');
  assert.equal(JSON.stringify(res.payload).includes('sk_'), false);
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
