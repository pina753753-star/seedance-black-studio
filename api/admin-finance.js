'use strict';

// 管理者専用「経営状況」API。
// Stripeの Balance Transactions を中心に、今月/先月/今年の売上・Stripe手数料・
// 純売上・売上内訳(サブスク/追加クレジット)を集計して返す。
// Stripe Secret Keyはこの関数の外(ブラウザ)へは絶対に返さない。
//
// 注意: このファイルは stripe-checkout.js / stripe-webhook.js とは独立しており、
// 決済処理・クレジット付与ロジックには一切関与しない(読み取り専用の集計API)。

const ADMIN_EMAIL = String(
  process.env.ADMIN_EMAIL || 'hinaran53@gmail.com'
).trim().toLowerCase();

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const PERIODS = ['thisMonth', 'lastMonth', 'thisYear'];

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

// JST(UTC+9)のカレンダー基準で、指定期間の [開始, 終了) をUNIX秒で返す。
// 終了は「次の期間の開始」であり、範囲に含まれない(排他的)。
function periodRangeSeconds(period, now = new Date()) {
  const jstNow = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jstNow.getUTCFullYear();
  const month = jstNow.getUTCMonth(); // 0-11

  function jstStartToUnixSeconds(y, m, d) {
    // 「JSTでy年m月d日 0:00」に対応するUTC時刻をUNIX秒で返す。
    const utcMs = Date.UTC(y, m, d, 0, 0, 0) - JST_OFFSET_MS;
    return Math.floor(utcMs / 1000);
  }

  if (period === 'thisMonth') {
    return {
      gte: jstStartToUnixSeconds(year, month, 1),
      lt: jstStartToUnixSeconds(year, month + 1, 1)
    };
  }

  if (period === 'lastMonth') {
    return {
      gte: jstStartToUnixSeconds(year, month - 1, 1),
      lt: jstStartToUnixSeconds(year, month, 1)
    };
  }

  if (period === 'thisYear') {
    return {
      gte: jstStartToUnixSeconds(year, 0, 1),
      lt: jstStartToUnixSeconds(year + 1, 0, 1)
    };
  }

  return null;
}

function validatePeriodPayload(body) {
  const period = String(body?.period || '').trim();

  if (!PERIODS.includes(period)) return null;

  return { period };
}

// 1件のbalance transactionから、売上内訳の分類キーを判定する。
// expand済みのsource(charge)にinvoiceが紐づいていればサブスクリプション、
// 無ければ追加クレジット(都度課金)とみなす。
// charge展開に失敗している/取得できない場合は「unknown」に分類する。
function classifyBalanceTransaction(txn) {
  const source = txn?.source;

  if (!source || typeof source !== 'object') {
    return 'unknown';
  }

  return source.invoice ? 'subscription' : 'credit';
}

async function listAllBalanceTransactions(stripe, params) {
  const results = [];
  let startingAfter;

  // Stripeの1ページ最大件数(100件)ずつ、全件をページングして取得する。
  for (;;) {
    const page = await stripe.balanceTransactions.list({
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });

    const data = Array.isArray(page?.data) ? page.data : [];
    results.push(...data);

    if (!page?.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;

    // 想定外の無限ループを避けるための安全弁。
    if (results.length > 20000) break;
  }

  return results;
}

async function aggregateFinance(stripe, range) {
  const txns = await listAllBalanceTransactions(stripe, {
    created: { gte: range.gte, lt: range.lt },
    type: 'charge',
    expand: ['data.source']
  });

  const refunds = await listAllBalanceTransactions(stripe, {
    created: { gte: range.gte, lt: range.lt },
    type: 'refund',
    expand: ['data.source']
  });

  const all = [...txns, ...refunds];

  let grossAmount = 0;
  let fee = 0;
  let net = 0;
  const breakdown = { subscription: 0, credit: 0, unknown: 0 };

  for (const txn of all) {
    const amount = Number(txn?.amount || 0);
    const txnFee = Number(txn?.fee || 0);
    const txnNet = Number(txn?.net || 0);

    grossAmount += amount;
    fee += txnFee;
    net += txnNet;

    const category = classifyBalanceTransaction(txn);
    breakdown[category] = (breakdown[category] || 0) + amount;
  }

  return {
    currency: all[0]?.currency || 'jpy',
    grossAmount,
    fee,
    net,
    breakdown,
    transactionCount: all.length
  };
}

function createHandler(dependencies = {}) {
  const requireAuth =
    dependencies.requireAuth || defaultRequireAuth;

  const authorize =
    dependencies.authorize || authorizeAdmin;

  const createStripeClient =
    dependencies.createStripeClient ||
    function defaultCreateStripeClient() {
      const secretKey = process.env.STRIPE_SECRET_KEY;
      if (!secretKey) return null;

      const Stripe = require('stripe');
      return new Stripe(secretKey);
    };

  const aggregate =
    dependencies.aggregate || aggregateFinance;

  const now =
    dependencies.now || (() => new Date());

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

      const payload = validatePeriodPayload(req.body);

      if (!payload) {
        return res.status(400).json({
          ok: false,
          error: 'INVALID_PERIOD',
          message: '表示期間を確認してください。'
        });
      }

      const range = periodRangeSeconds(payload.period, now());

      const stripe = createStripeClient();

      if (!stripe) {
        return res.status(500).json({
          ok: false,
          error: 'STRIPE_CONFIGURATION_ERROR',
          message: 'Stripeの設定を確認できませんでした。'
        });
      }

      const result = await aggregate(stripe, range);

      return res.status(200).json({
        ok: true,
        period: payload.period,
        range,
        ...result
      });
    } catch (_) {
      return res.status(500).json({
        ok: false,
        error: 'ADMIN_FINANCE_OPERATION_FAILED',
        message: '経営状況の集計結果を確認できませんでした。'
      });
    }
  };
}

const handler = createHandler();

module.exports = handler;
module.exports._test = {
  aggregateFinance,
  authorizeAdmin,
  classifyBalanceTransaction,
  createHandler,
  listAllBalanceTransactions,
  periodRangeSeconds,
  validatePeriodPayload
};
