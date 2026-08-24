'use strict';

// USD→JPYの為替レート取得。Frankfurter(https://api.frankfurter.dev/)を
// サーバー側からのみ呼び出す。APIキーは不要。
//
// 重要: 取得に失敗した場合、呼び出し元は絶対に推定レートへフォールバック
// してはいけない。この関数は失敗時に必ず例外を投げるので、呼び出し元は
// それをそのまま伝播させ、処理を停止すること。
//
// 支払い実績は「登録日」ではなく「支払日(paidAt)」時点のレートを使う。
// Frankfurterのhistorical rateエンドポイント(/v1/{date})を叩き、実際に
// 返ってきたレートの日付(祝休日等でpaidAtとズレる場合がある)を
// fx_rate_dateとして保存する。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_TIMEOUT_MS = 8000;

function frankfurterEndpoint(dateIso) {
  return `https://api.frankfurter.dev/v1/${dateIso}?base=USD&symbols=JPY`;
}

// 後方互換のため、latestレートのエンドポイントも公開しておく
// (現状は本番コードから直接は使用しない)。
const FRANKFURTER_LATEST_ENDPOINT = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY';

// dateIso省略時は最新レートを取得する。支払い実績登録では、必ず
// paidAt(支払日)を渡すこと。
async function fetchUsdToJpyRate(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const dateIso = options.date ? String(options.date).trim() : null;

  if (dateIso !== null && !DATE_RE.test(dateIso)) {
    throw new Error('FX_RATE_INVALID_DATE');
  }

  const endpoint = dateIso ? frankfurterEndpoint(dateIso) : FRANKFURTER_LATEST_ENDPOINT;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(endpoint, { signal: controller.signal });

    if (!response.ok) {
      throw new Error('FX_RATE_HTTP_ERROR');
    }

    const data = await response.json();
    const rate = Number(data?.rates?.JPY);
    const date = String(data?.date || '').trim();

    if (!Number.isFinite(rate) || rate <= 0 || !DATE_RE.test(date)) {
      throw new Error('FX_RATE_INVALID_RESPONSE');
    }

    return { rate, date, source: 'frankfurter' };
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('FX_RATE_TIMEOUT');
    }
    throw err instanceof Error ? err : new Error('FX_RATE_FETCH_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  FRANKFURTER_LATEST_ENDPOINT,
  frankfurterEndpoint,
  fetchUsdToJpyRate
};
