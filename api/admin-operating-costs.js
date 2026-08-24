'use strict';

// 管理者専用「運営費」API(経営状況 Phase 2)。
// Stripe売上集計(api/admin-finance.js)とは完全に独立しており、
// api/stripe-checkout.js / api/stripe-webhook.js には一切関与しない。
// Stripe手数料はここへ登録しない(Phase 1のnetは既にStripe手数料控除後
// のため、ここへ入れると二重控除になる)。

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || 'hinaran53@gmail.com'
).trim().toLowerCase();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CURRENCIES = ['USD', 'JPY'];
const BILLING_CYCLES = ['monthly', 'yearly', 'usage', 'one_time'];
const CONVERSION_METHODS = ['auto', 'manual_actual'];

// 桁あふれ・入力ミス防止のための上限(USD centsまたはJPY円で1,000万円相当)。
const MAX_AMOUNT_MINOR = 100000000;

async function defaultRequireAuth(req) {
  const {
    requireConfirmedAuth
  } = require('./_lib/confirmed-auth.js');

  return requireConfirmedAuth(req);
}

async function authorizeAdmin(auth) {
  const email = String(
    auth?.user?.email || ''
  ).trim().toLowerCase();

  if (
    !auth?.user?.id ||
    !ADMIN_EMAIL ||
    email !== ADMIN_EMAIL
  ) {
    return { ok: false };
  }

  const { data, error } = await auth.supabase
    .from('profiles')
    .select('id,email,role')
    .eq('id', auth.user.id)
    .maybeSingle();

  if (
    error ||
    data?.role !== 'admin' ||
    String(data.email || '').trim().toLowerCase() !== ADMIN_EMAIL
  ) {
    return { ok: false };
  }

  return { ok: true, admin: data };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCurrency(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeBillingCycle(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeConversionMethod(value) {
  return String(value || '').trim().toLowerCase();
}

// 整数(bigint境界内)で、0以上・上限以下かを検査する。
// 文字列/数値どちらで届いても、小数・NaN・Infinityは拒否する。
function isValidAmountMinor(value, { allowZero }) {
  if (typeof value === 'string' && value.trim() === '') return false;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return false;
  if (n < 0) return false;
  if (!allowZero && n <= 0) return false;
  if (n > MAX_AMOUNT_MINOR) return false;
  return true;
}

function validateCostPayload(body) {
  const serviceName = String(body?.serviceName || '').trim();
  const category = String(body?.category || '').trim();
  const amountMinor = body?.amountMinor;
  const currency = normalizeCurrency(body?.currency);
  const billingCycle = normalizeBillingCycle(body?.billingCycle);
  const amountIsEstimate = Boolean(body?.amountIsEstimate);
  const nextBillingDateRaw = body?.nextBillingDate;
  const notes = String(body?.notes || '');

  if (serviceName.length < 1 || serviceName.length > 120) return null;
  if (category.length < 1 || category.length > 60) return null;
  if (!isValidAmountMinor(amountMinor, { allowZero: true })) return null;
  if (!CURRENCIES.includes(currency)) return null;
  if (!BILLING_CYCLES.includes(billingCycle)) return null;
  if (notes.length > 2000) return null;

  let nextBillingDate = null;
  if (nextBillingDateRaw !== null && nextBillingDateRaw !== undefined && nextBillingDateRaw !== '') {
    const raw = String(nextBillingDateRaw).trim();
    if (!DATE_RE.test(raw)) return null;
    nextBillingDate = raw;
  }

  return {
    serviceName,
    category,
    amountMinor: Number(amountMinor),
    currency,
    billingCycle,
    amountIsEstimate,
    nextBillingDate,
    notes
  };
}

function validateSetCostActivePayload(body) {
  const operatingCostId = String(body?.operatingCostId || '').trim();

  if (!UUID_RE.test(operatingCostId)) return null;
  if (typeof body?.isActive !== 'boolean') return null;

  return { operatingCostId, isActive: body.isActive };
}

function validateListPaymentsPayload(body) {
  const operatingCostIdRaw = body?.operatingCostId;
  let operatingCostId = null;

  if (operatingCostIdRaw !== null && operatingCostIdRaw !== undefined && operatingCostIdRaw !== '') {
    const raw = String(operatingCostIdRaw).trim();
    if (!UUID_RE.test(raw)) return null;
    operatingCostId = raw;
  }

  let limit = 200;
  if (body?.limit !== undefined && body?.limit !== null) {
    const n = Number(body.limit);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 1000) return null;
    limit = n;
  }

  return { operatingCostId, limit };
}

// 支払い実績の入力を検査する。amountJpy/fxRateは、自動換算(auto)の場合は
// サーバー側で計算するため、ここではmanual_actualの入力だけを検査する。
function validatePaymentInputPayload(body) {
  const operatingCostId = String(body?.operatingCostId || '').trim();
  const paidAt = String(body?.paidAt || '').trim();
  const amountMinor = body?.amountMinor;
  const currency = normalizeCurrency(body?.currency);
  const conversionMethod = normalizeConversionMethod(body?.conversionMethod);
  const reference = body?.reference === null || body?.reference === undefined ? '' : String(body.reference).trim();
  const notes = String(body?.notes || '');

  if (!UUID_RE.test(operatingCostId)) return null;
  if (!DATE_RE.test(paidAt)) return null;
  if (!isValidAmountMinor(amountMinor, { allowZero: false })) return null;
  if (!CURRENCIES.includes(currency)) return null;
  if (!CONVERSION_METHODS.includes(conversionMethod)) return null;
  if (reference.length > 200) return null;
  if (notes.length > 2000) return null;

  const result = {
    operatingCostId,
    paidAt,
    amountMinor: Number(amountMinor),
    currency,
    conversionMethod,
    reference: reference || null,
    notes
  };

  if (conversionMethod === 'manual_actual') {
    const amountJpy = body?.amountJpy;
    if (!isValidAmountMinor(amountJpy, { allowZero: false })) return null;
    result.amountJpy = Number(amountJpy);
  }

  return result;
}

function validatePaymentUpdatePayload(body) {
  const paymentId = String(body?.paymentId || '').trim();
  if (!UUID_RE.test(paymentId)) return null;

  const base = validatePaymentInputPayload(body);
  if (!base) return null;

  return { paymentId, ...base };
}

function validateVoidPaymentPayload(body) {
  const paymentId = String(body?.paymentId || '').trim();
  const voidReason = String(body?.voidReason || '').trim();

  if (!UUID_RE.test(paymentId)) return null;
  if (voidReason.length < 2 || voidReason.length > 200) return null;

  return { paymentId, voidReason };
}

// conversionMethod='auto'の場合、JPYはレート固定(1)、USDはFrankfurterから
// 実際に取得したレートのみを使う。取得に失敗した場合は例外を投げて停止し、
// 推定レートへは絶対にフォールバックしない。
// conversionMethod='manual_actual'の場合、ブラウザから送られたamountJpyを
// 正本として保存し、fxRateはそこから逆算した参考値として保持する
// (ブラウザ側の自動計算レートは正本として信用しない)。
async function resolveFxFields(input, fetchFxRate) {
  const { amountMinor, currency, conversionMethod } = input;

  if (conversionMethod === 'manual_actual') {
    const amountJpy = input.amountJpy;
    const baseUnits = currency === 'USD' ? amountMinor / 100 : amountMinor;
    const fxRate = amountJpy / baseUnits;

    return {
      amountJpy,
      fxRate,
      fxRateDate: null,
      fxRateSource: null
    };
  }

  // conversionMethod === 'auto'
  if (currency === 'JPY') {
    return {
      amountJpy: amountMinor,
      fxRate: 1,
      fxRateDate: null,
      fxRateSource: null
    };
  }

  const { rate, date, source } = await fetchFxRate();
  const amountJpy = Math.round((amountMinor / 100) * rate);

  return {
    amountJpy,
    fxRate: rate,
    fxRateDate: date,
    fxRateSource: source
  };
}

async function rpc(db, name, params) {
  const { data, error } = await db.rpc(name, params);

  if (error || !data?.ok) {
    throw new Error('OPERATING_COST_RPC_FAILED');
  }

  return data;
}

function createHandler(dependencies = {}) {
  const requireAuth =
    dependencies.requireAuth || defaultRequireAuth;

  const authorize =
    dependencies.authorize || authorizeAdmin;

  const invoke =
    dependencies.rpc || rpc;

  const fetchFxRate =
    dependencies.fetchFxRate ||
    function defaultFetchFxRate() {
      const { fetchUsdToJpyRate } = require('./_lib/fx-rate.js');
      return fetchUsdToJpyRate();
    };

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Allow', 'POST');

    if (req.method !== 'POST') {
      return res.status(405).json({
        ok: false,
        error: 'METHOD_NOT_ALLOWED',
        message: 'この操作は利用できません。'
      });
    }

    const auth = await requireAuth(req);

    if (!auth.ok) {
      return res.status(auth.status).json(auth.body);
    }

    try {
      const authorization = await authorize(auth);

      if (!authorization.ok) {
        return res.status(403).json({
          ok: false,
          error: 'ADMIN_REQUIRED',
          message: '管理者権限を確認できませんでした。'
        });
      }

      const adminUserId = authorization.admin.id;
      const body = isPlainObject(req.body) ? req.body : {};
      const action = String(body.action || '');

      if (action === 'list') {
        const result = await invoke(
          auth.supabase,
          'admin_list_operating_costs',
          { p_admin_user_id: adminUserId }
        );

        return res.status(200).json(result);
      }

      if (action === 'createCost') {
        const payload = validateCostPayload(body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_COST_PAYLOAD',
            message: '運営費の入力内容を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_create_operating_cost',
          {
            p_admin_user_id: adminUserId,
            p_service_name: payload.serviceName,
            p_category: payload.category,
            p_amount_minor: payload.amountMinor,
            p_currency: payload.currency,
            p_billing_cycle: payload.billingCycle,
            p_amount_is_estimate: payload.amountIsEstimate,
            p_next_billing_date: payload.nextBillingDate,
            p_notes: payload.notes
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'updateCost') {
        const operatingCostId = String(body?.operatingCostId || '').trim();
        const payload = validateCostPayload(body);

        if (!UUID_RE.test(operatingCostId) || !payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_COST_PAYLOAD',
            message: '運営費の入力内容を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_update_operating_cost',
          {
            p_admin_user_id: adminUserId,
            p_operating_cost_id: operatingCostId,
            p_service_name: payload.serviceName,
            p_category: payload.category,
            p_amount_minor: payload.amountMinor,
            p_currency: payload.currency,
            p_billing_cycle: payload.billingCycle,
            p_amount_is_estimate: payload.amountIsEstimate,
            p_next_billing_date: payload.nextBillingDate,
            p_notes: payload.notes
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'setCostActive') {
        const payload = validateSetCostActivePayload(body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_ACTIVE_PAYLOAD',
            message: '変更内容を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_set_operating_cost_active',
          {
            p_admin_user_id: adminUserId,
            p_operating_cost_id: payload.operatingCostId,
            p_is_active: payload.isActive
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'listPayments') {
        const payload = validateListPaymentsPayload(body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_LIST_PAYMENTS_PAYLOAD',
            message: '取得条件を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_list_operating_cost_payments',
          {
            p_admin_user_id: adminUserId,
            p_operating_cost_id: payload.operatingCostId,
            p_limit: payload.limit
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'createPayment') {
        const payload = validatePaymentInputPayload(body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_PAYMENT_PAYLOAD',
            message: '支払い実績の入力内容を確認してください。'
          });
        }

        let fx;
        try {
          fx = await resolveFxFields(payload, fetchFxRate);
        } catch (_) {
          return res.status(502).json({
            ok: false,
            error: 'FX_RATE_UNAVAILABLE',
            message: '為替レートを取得できなかったため、登録を停止しました。時間をおいて再度お試しください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_create_operating_cost_payment',
          {
            p_admin_user_id: adminUserId,
            p_operating_cost_id: payload.operatingCostId,
            p_paid_at: payload.paidAt,
            p_amount_minor: payload.amountMinor,
            p_currency: payload.currency,
            p_amount_jpy: fx.amountJpy,
            p_fx_rate: fx.fxRate,
            p_fx_rate_date: fx.fxRateDate,
            p_fx_rate_source: fx.fxRateSource,
            p_conversion_method: payload.conversionMethod,
            p_reference: payload.reference,
            p_notes: payload.notes
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'updatePayment') {
        const payload = validatePaymentUpdatePayload(body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_PAYMENT_PAYLOAD',
            message: '支払い実績の入力内容を確認してください。'
          });
        }

        let fx;
        try {
          fx = await resolveFxFields(payload, fetchFxRate);
        } catch (_) {
          return res.status(502).json({
            ok: false,
            error: 'FX_RATE_UNAVAILABLE',
            message: '為替レートを取得できなかったため、更新を停止しました。時間をおいて再度お試しください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_update_operating_cost_payment',
          {
            p_admin_user_id: adminUserId,
            p_payment_id: payload.paymentId,
            p_paid_at: payload.paidAt,
            p_amount_minor: payload.amountMinor,
            p_currency: payload.currency,
            p_amount_jpy: fx.amountJpy,
            p_fx_rate: fx.fxRate,
            p_fx_rate_date: fx.fxRateDate,
            p_fx_rate_source: fx.fxRateSource,
            p_conversion_method: payload.conversionMethod,
            p_reference: payload.reference,
            p_notes: payload.notes
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'voidPayment') {
        const payload = validateVoidPaymentPayload(body);

        if (!payload) {
          return res.status(400).json({
            ok: false,
            error: 'INVALID_VOID_PAYLOAD',
            message: '取消理由を確認してください。'
          });
        }

        const result = await invoke(
          auth.supabase,
          'admin_void_operating_cost_payment',
          {
            p_admin_user_id: adminUserId,
            p_payment_id: payload.paymentId,
            p_void_reason: payload.voidReason
          }
        );

        return res.status(200).json(result);
      }

      if (action === 'getFxRate') {
        try {
          const { rate, date, source } = await fetchFxRate();
          return res.status(200).json({ ok: true, rate, date, source });
        } catch (_) {
          return res.status(502).json({
            ok: false,
            error: 'FX_RATE_UNAVAILABLE',
            message: '為替レートを取得できませんでした。時間をおいて再度お試しください。'
          });
        }
      }

      return res.status(400).json({
        ok: false,
        error: 'INVALID_ACTION',
        message: '操作内容を確認してください。'
      });
    } catch (_) {
      return res.status(500).json({
        ok: false,
        error: 'ADMIN_OPERATING_COST_OPERATION_FAILED',
        message: '運営費の処理結果を確認できませんでした。'
      });
    }
  };
}

const handler = createHandler();

module.exports = handler;
module.exports._test = {
  authorizeAdmin,
  createHandler,
  isValidAmountMinor,
  resolveFxFields,
  rpc,
  validateCostPayload,
  validateListPaymentsPayload,
  validatePaymentInputPayload,
  validatePaymentUpdatePayload,
  validateSetCostActivePayload,
  validateVoidPaymentPayload
};
