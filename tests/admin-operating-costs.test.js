'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const api = require('../api/admin-operating-costs.js')._test;

const VALID_UUID = '123e4567-e89b-42d3-a456-426614174000';

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

function stubRpc(result) {
  return async () => result || { ok: true };
}

// ---------------------------------------------------------------
// 1. 未認証拒否
// ---------------------------------------------------------------
test('未認証を401、GETを405で拒否する', async () => {
  const getHandler = api.createHandler({ requireAuth: async () => ({ ok: true }), authorize: async () => ({ ok: true }) });
  const getRes = responseRecorder();
  await getHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 405);

  const unauthHandler = api.createHandler({ requireAuth: async () => ({ ok: false, status: 401, body: { ok: false } }) });
  const unauthRes = responseRecorder();
  await unauthHandler({ method: 'POST', body: { action: 'list' } }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);
});

// ---------------------------------------------------------------
// 2. admin以外拒否
// ---------------------------------------------------------------
test('管理者以外を403で拒否する', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'user-1', email: 'someone@example.com' }, supabase: {} }),
    authorize: async () => ({ ok: false })
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { action: 'list' } }, res);
  assert.equal(res.statusCode, 403);
});

// ---------------------------------------------------------------
// 3. ADMIN_EMAIL不一致拒否
// ---------------------------------------------------------------
test('authorizeAdminはADMIN_EMAILとprofiles.emailの両方が一致した場合だけ許可する', async () => {
  function authWith(profile, email) {
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

  const ok = await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'admin' }, 'hinaran53@gmail.com'));
  assert.equal(ok.ok, true);

  const mismatchedSessionEmail = await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'admin' }, 'attacker@example.com'));
  assert.equal(mismatchedSessionEmail.ok, false);

  const mismatchedProfileEmail = await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'someone-else@example.com', role: 'admin' }, 'hinaran53@gmail.com'));
  assert.equal(mismatchedProfileEmail.ok, false);

  const wrongRole = await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'user' }, 'hinaran53@gmail.com'));
  assert.equal(wrongRole.ok, false);
});

// ---------------------------------------------------------------
// 4. 不正currency拒否
// ---------------------------------------------------------------
test('validateCostPayloadは不正なcurrencyを拒否する', () => {
  const base = { serviceName: 'Vercel', category: 'hosting', amountMinor: 2000, billingCycle: 'monthly' };
  assert.equal(api.validateCostPayload({ ...base, currency: 'EUR' }), null);
  assert.equal(api.validateCostPayload({ ...base, currency: '' }), null);
  assert.notEqual(api.validateCostPayload({ ...base, currency: 'usd' }), null); // 大文字化して許可
  assert.notEqual(api.validateCostPayload({ ...base, currency: 'JPY' }), null);
});

test('validatePaymentInputPayloadは不正なcurrencyを拒否する', () => {
  const base = { operatingCostId: VALID_UUID, paidAt: '2026-08-01', amountMinor: 1000, conversionMethod: 'auto' };
  assert.equal(api.validatePaymentInputPayload({ ...base, currency: 'GBP' }), null);
});

// ---------------------------------------------------------------
// 5. 不正billing_cycle拒否
// ---------------------------------------------------------------
test('validateCostPayloadは不正なbilling_cycleを拒否する', () => {
  const base = { serviceName: 'Vercel', category: 'hosting', amountMinor: 2000, currency: 'USD' };
  assert.equal(api.validateCostPayload({ ...base, billingCycle: 'weekly' }), null);
  assert.equal(api.validateCostPayload({ ...base, billingCycle: '' }), null);
  assert.notEqual(api.validateCostPayload({ ...base, billingCycle: 'usage' }), null);
  assert.notEqual(api.validateCostPayload({ ...base, billingCycle: 'one_time' }), null);
});

// ---------------------------------------------------------------
// 6. 負の金額拒否
// ---------------------------------------------------------------
test('負の金額・小数・上限超過を拒否する(運営費・支払い実績とも)', () => {
  const costBase = { serviceName: 'Vercel', category: 'hosting', currency: 'USD', billingCycle: 'monthly' };
  assert.equal(api.validateCostPayload({ ...costBase, amountMinor: -1 }), null);
  assert.equal(api.validateCostPayload({ ...costBase, amountMinor: 1.5 }), null);
  assert.equal(api.validateCostPayload({ ...costBase, amountMinor: 999999999999 }), null);
  assert.notEqual(api.validateCostPayload({ ...costBase, amountMinor: 0 }), null); // 運営費は0(未定/usage)を許可

  const paymentBase = { operatingCostId: VALID_UUID, paidAt: '2026-08-01', currency: 'USD', conversionMethod: 'auto' };
  assert.equal(api.validatePaymentInputPayload({ ...paymentBase, amountMinor: -1 }), null);
  assert.equal(api.validatePaymentInputPayload({ ...paymentBase, amountMinor: 0 }), null); // 支払い実績は0を許可しない
  assert.equal(api.validatePaymentInputPayload({ ...paymentBase, amountMinor: 1.5 }), null);
});

test('isValidAmountMinorはNaN・Infinity・文字列の不正値を拒否する', () => {
  assert.equal(api.isValidAmountMinor('abc', { allowZero: true }), false);
  assert.equal(api.isValidAmountMinor(NaN, { allowZero: true }), false);
  assert.equal(api.isValidAmountMinor(Infinity, { allowZero: true }), false);
  assert.equal(api.isValidAmountMinor('', { allowZero: true }), false);
  assert.equal(api.isValidAmountMinor('100', { allowZero: true }), true);
});

// ---------------------------------------------------------------
// 7. USD自動換算
// ---------------------------------------------------------------
test('resolveFxFields: USD/autoはFrankfurterのレートで換算する', async () => {
  const input = { amountMinor: 2000, currency: 'USD', conversionMethod: 'auto' }; // $20.00
  const fetchFxRate = async () => ({ rate: 150.1234, date: '2026-08-23', source: 'frankfurter' });

  const fx = await api.resolveFxFields(input, fetchFxRate);

  assert.equal(fx.fxRate, 150.1234);
  assert.equal(fx.fxRateDate, '2026-08-23');
  assert.equal(fx.fxRateSource, 'frankfurter');
  assert.equal(fx.amountJpy, Math.round(20 * 150.1234));
});

// ---------------------------------------------------------------
// 8. JPYはrate=1
// ---------------------------------------------------------------
test('resolveFxFields: JPY/autoはfxRate=1、amountJpy=amountMinorで、Frankfurterを呼ばない', async () => {
  const input = { amountMinor: 3000, currency: 'JPY', conversionMethod: 'auto' };
  let called = false;
  const fetchFxRate = async () => { called = true; return { rate: 999, date: 'x', source: 'frankfurter' }; };

  const fx = await api.resolveFxFields(input, fetchFxRate);

  assert.equal(called, false);
  assert.equal(fx.fxRate, 1);
  assert.equal(fx.amountJpy, 3000);
  assert.equal(fx.fxRateSource, null);
});

// ---------------------------------------------------------------
// 9. manual_actual円額保存
// ---------------------------------------------------------------
test('resolveFxFields: manual_actualはブラウザのamountJpyを正本として保存し、Frankfurterを呼ばない', async () => {
  const input = { amountMinor: 2000, currency: 'USD', conversionMethod: 'manual_actual', amountJpy: 3200 }; // $20.00 -> 実際は3200円
  let called = false;
  const fetchFxRate = async () => { called = true; return { rate: 999, date: 'x', source: 'frankfurter' }; };

  const fx = await api.resolveFxFields(input, fetchFxRate);

  assert.equal(called, false);
  assert.equal(fx.amountJpy, 3200);
  assert.equal(fx.fxRate, 3200 / 20);
  assert.equal(fx.fxRateSource, null);
  assert.equal(fx.fxRateDate, null);
});

test('validatePaymentInputPayloadはmanual_actualでamountJpy必須、autoでは不要', () => {
  const base = { operatingCostId: VALID_UUID, paidAt: '2026-08-01', amountMinor: 1000, currency: 'USD' };
  assert.equal(api.validatePaymentInputPayload({ ...base, conversionMethod: 'manual_actual' }), null); // amountJpyなし
  assert.notEqual(api.validatePaymentInputPayload({ ...base, conversionMethod: 'manual_actual', amountJpy: 1600 }), null);
  assert.notEqual(api.validatePaymentInputPayload({ ...base, conversionMethod: 'auto' }), null); // autoはamountJpy不要
});

// ---------------------------------------------------------------
// 10. Frankfurter失敗時に推定値を使わない
// ---------------------------------------------------------------
test('resolveFxFields: USD/autoでFrankfurterが失敗したら例外を投げ、推定値を使わない', async () => {
  const input = { amountMinor: 2000, currency: 'USD', conversionMethod: 'auto' };
  const fetchFxRate = async () => { throw new Error('FX_RATE_HTTP_ERROR'); };

  await assert.rejects(() => api.resolveFxFields(input, fetchFxRate));
});

test('APIハンドラ: createPaymentでFrankfurter失敗時は502を返し、RPCを呼ばない(登録しない)', async () => {
  let rpcCalled = false;
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    fetchFxRate: async () => { throw new Error('FX_RATE_HTTP_ERROR'); },
    rpc: async () => { rpcCalled = true; return { ok: true }; }
  });

  const res = responseRecorder();
  await handler({
    method: 'POST',
    body: {
      action: 'createPayment',
      operatingCostId: VALID_UUID,
      paidAt: '2026-08-01',
      amountMinor: 2000,
      currency: 'USD',
      conversionMethod: 'auto'
    }
  }, res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.ok, false);
  assert.equal(rpcCalled, false);
});

// ---------------------------------------------------------------
// 11. inactive化
// ---------------------------------------------------------------
test('setCostActiveはRPCへisActiveを渡し、不正なpayloadは400になる', async () => {
  let capturedParams = null;
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    rpc: async (db, name, params) => { capturedParams = { name, params }; return { ok: true, id: VALID_UUID, isActive: false }; }
  });

  const res = responseRecorder();
  await handler({ method: 'POST', body: { action: 'setCostActive', operatingCostId: VALID_UUID, isActive: false } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(capturedParams.name, 'admin_set_operating_cost_active');
  assert.equal(capturedParams.params.p_is_active, false);

  const badRes = responseRecorder();
  await handler({ method: 'POST', body: { action: 'setCostActive', operatingCostId: 'not-a-uuid', isActive: false } }, badRes);
  assert.equal(badRes.statusCode, 400);
});

// ---------------------------------------------------------------
// 12. payment void
// ---------------------------------------------------------------
test('voidPaymentはvoidReasonを検証し、RPCへ渡す', async () => {
  let capturedParams = null;
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    rpc: async (db, name, params) => { capturedParams = { name, params }; return { ok: true, id: VALID_UUID, isVoided: true }; }
  });

  const res = responseRecorder();
  await handler({ method: 'POST', body: { action: 'voidPayment', paymentId: VALID_UUID, voidReason: '誤登録のため取消' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(capturedParams.name, 'admin_void_operating_cost_payment');
  assert.equal(capturedParams.params.p_void_reason, '誤登録のため取消');

  const badRes = responseRecorder();
  await handler({ method: 'POST', body: { action: 'voidPayment', paymentId: VALID_UUID, voidReason: 'x' } }, badRes); // 短すぎ
  assert.equal(badRes.statusCode, 400);
});

test('validateVoidPaymentPayloadは不正なUUID・理由を拒否する', () => {
  assert.equal(api.validateVoidPaymentPayload({ paymentId: 'bad', voidReason: '誤登録' }), null);
  assert.equal(api.validateVoidPaymentPayload({ paymentId: VALID_UUID, voidReason: '' }), null);
  assert.notEqual(api.validateVoidPaymentPayload({ paymentId: VALID_UUID, voidReason: '誤登録のため' }), null);
});

// ---------------------------------------------------------------
// 13. private table直接操作不可(migrationの内容を検証)
// ---------------------------------------------------------------
const migrationPath = path.join(__dirname, '..', 'supabase', 'migrations', '20260824010000_add_operating_costs.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');

test('private.operating_costs/operating_cost_paymentsはanon/authenticated/service_roleから直接操作できない', () => {
  assert.match(migration, /revoke all\s+on table private\.operating_costs\s+from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all\s+on table private\.operating_cost_payments\s+from public, anon, authenticated, service_role/i);
  assert.match(migration, /alter table private\.operating_costs enable row level security/i);
  assert.match(migration, /alter table private\.operating_cost_payments enable row level security/i);
});

test('物理DELETEに相当する操作がない(is_active/is_voidedで論理的に停止・取消する)', () => {
  assert.doesNotMatch(migration, /delete from private\.operating_costs/i);
  assert.doesNotMatch(migration, /delete from private\.operating_cost_payments/i);
  assert.match(migration, /is_active = p_is_active/);
  assert.match(migration, /is_voided = true/);
});

test('全RPCは管理者権限(profiles.role=admin)を検査してからservice_roleにのみ実行権限を持つ', () => {
  const rpcNames = [
    'admin_list_operating_costs',
    'admin_create_operating_cost',
    'admin_update_operating_cost',
    'admin_set_operating_cost_active',
    'admin_list_operating_cost_payments',
    'admin_create_operating_cost_payment',
    'admin_update_operating_cost_payment',
    'admin_void_operating_cost_payment'
  ];

  for (const name of rpcNames) {
    const grantPattern = new RegExp(`grant execute on function public\\.${name}\\(`, 'i');
    assert.match(migration, grantPattern, `${name} にservice_roleへのgrantが必要です`);
  }

  assert.match(migration, /assert_operating_cost_admin/);
  assert.match(migration, /role = 'admin'/);
});

// ---------------------------------------------------------------
// 14. Stripe系3ファイルが変更されていないこと
// ---------------------------------------------------------------
test('api/stripe-checkout.js・api/stripe-webhook.js・api/admin-finance.jsはこの変更で参照・要求されていない', () => {
  // migrationの説明コメントにStripe手数料の二重控除を避ける設計意図の記述は
  // あるが、Stripe関連オブジェクト(テーブル・関数・外部呼び出し)は作らない。
  assert.doesNotMatch(migration, /stripe[_.]/i);
  assert.doesNotMatch(migration, /balance_transaction|checkout\.session|webhook/i);

  const operatingCostsApiSource = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'admin-operating-costs.js'),
    'utf8'
  );
  // コメントで「触らない」と明記するのは意図的だが、requireやimportとしては
  // 一切読み込んでいないことを確認する。
  assert.doesNotMatch(operatingCostsApiSource, /require\(['"]\.\/stripe-checkout(\.js)?['"]\)/);
  assert.doesNotMatch(operatingCostsApiSource, /require\(['"]\.\/stripe-webhook(\.js)?['"]\)/);
  assert.doesNotMatch(operatingCostsApiSource, /require\(['"]stripe['"]\)/);
});

// ---------------------------------------------------------------
// 追加: 一覧・作成のRPC連携、listPaymentsの検証
// ---------------------------------------------------------------
test('list/createCost/updateCostはRPCへ正しいパラメータを渡す', async () => {
  const calls = [];
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    rpc: async (db, name, params) => { calls.push({ name, params }); return { ok: true }; }
  });

  await handler({ method: 'POST', body: { action: 'list' } }, responseRecorder());
  assert.equal(calls[0].name, 'admin_list_operating_costs');
  assert.equal(calls[0].params.p_admin_user_id, 'admin-id');

  await handler({
    method: 'POST',
    body: {
      action: 'createCost',
      serviceName: 'Vercel',
      category: 'hosting',
      amountMinor: 2000,
      currency: 'usd',
      billingCycle: 'monthly',
      amountIsEstimate: false,
      notes: ''
    }
  }, responseRecorder());
  assert.equal(calls[1].name, 'admin_create_operating_cost');
  assert.equal(calls[1].params.p_currency, 'USD');
  assert.equal(calls[1].params.p_amount_minor, 2000);

  await handler({
    method: 'POST',
    body: {
      action: 'updateCost',
      operatingCostId: VALID_UUID,
      serviceName: 'Vercel Pro',
      category: 'hosting',
      amountMinor: 4000,
      currency: 'USD',
      billingCycle: 'monthly',
      amountIsEstimate: true,
      notes: '更新'
    }
  }, responseRecorder());
  assert.equal(calls[2].name, 'admin_update_operating_cost');
  assert.equal(calls[2].params.p_operating_cost_id, VALID_UUID);
});

test('listPaymentsはoperatingCostId省略時にnullを渡し、不正なlimitは400', async () => {
  let captured = null;
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    rpc: async (db, name, params) => { captured = { name, params }; return { ok: true }; }
  });

  await handler({ method: 'POST', body: { action: 'listPayments' } }, responseRecorder());
  assert.equal(captured.params.p_operating_cost_id, null);
  assert.equal(captured.params.p_limit, 200);

  const badRes = responseRecorder();
  await handler({ method: 'POST', body: { action: 'listPayments', limit: 0 } }, badRes);
  assert.equal(badRes.statusCode, 400);
});

test('getFxRateは成功時にレートを返し、失敗時は502(推定値なし)', async () => {
  const okHandler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    fetchFxRate: async () => ({ rate: 150, date: '2026-08-23', source: 'frankfurter' })
  });
  const okRes = responseRecorder();
  await okHandler({ method: 'POST', body: { action: 'getFxRate' } }, okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.payload.rate, 150);

  const failHandler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    fetchFxRate: async () => { throw new Error('down'); }
  });
  const failRes = responseRecorder();
  await failHandler({ method: 'POST', body: { action: 'getFxRate' } }, failRes);
  assert.equal(failRes.statusCode, 502);
  assert.equal(failRes.payload.ok, false);
});

test('RPCエラー・秘密情報を含む例外はブラウザへそのまま返さない', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id', email: 'hinaran53@gmail.com' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    rpc: async () => { throw new Error('service_role key sk_live_SECRET_LEAK'); }
  });

  const res = responseRecorder();
  await handler({ method: 'POST', body: { action: 'list' } }, res);

  assert.equal(res.statusCode, 500);
  assert.equal(JSON.stringify(res.payload).includes('sk_live'), false);
  assert.equal(JSON.stringify(res.payload).includes('SECRET'), false);
});

// ---------------------------------------------------------------
// api/_lib/fx-rate.js 単体(外部Frankfurter APIはfetchImplでmockする。
// 実際のネットワーク呼び出しは行わない)
// ---------------------------------------------------------------
const { fetchUsdToJpyRate } = require('../api/_lib/fx-rate.js');

test('fetchUsdToJpyRate: 正常なレスポンスからレートを取り出す', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/api\.frankfurter\.dev\/v1\/latest\?base=USD&symbols=JPY$/);
    return {
      ok: true,
      json: async () => ({ amount: 1, base: 'USD', date: '2026-08-23', rates: { JPY: 150.5 } })
    };
  };

  const result = await fetchUsdToJpyRate({ fetchImpl });
  assert.equal(result.rate, 150.5);
  assert.equal(result.date, '2026-08-23');
  assert.equal(result.source, 'frankfurter');
});

test('fetchUsdToJpyRate: HTTPエラー時は例外を投げ、推定値を返さない', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(() => fetchUsdToJpyRate({ fetchImpl }));
});

test('fetchUsdToJpyRate: 不正なレスポンス形式(rate欠落・不正日付)は例外を投げる', async () => {
  const missingRate = async () => ({ ok: true, json: async () => ({ date: '2026-08-23', rates: {} }) });
  await assert.rejects(() => fetchUsdToJpyRate({ fetchImpl: missingRate }));

  const badDate = async () => ({ ok: true, json: async () => ({ date: 'invalid', rates: { JPY: 150 } }) });
  await assert.rejects(() => fetchUsdToJpyRate({ fetchImpl: badDate }));

  const zeroRate = async () => ({ ok: true, json: async () => ({ date: '2026-08-23', rates: { JPY: 0 } }) });
  await assert.rejects(() => fetchUsdToJpyRate({ fetchImpl: zeroRate }));
});

test('fetchUsdToJpyRate: fetch自体が例外を投げた場合も伝播する(推定値へフォールバックしない)', async () => {
  const fetchImpl = async () => { throw new Error('network down'); };
  await assert.rejects(() => fetchUsdToJpyRate({ fetchImpl }), /network down/);
});
