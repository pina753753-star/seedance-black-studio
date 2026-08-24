'use strict';

// USD→JPYの為替レート取得。Frankfurter(https://api.frankfurter.dev/)を
// サーバー側からのみ呼び出す。APIキーは不要。
//
// 重要: 取得に失敗した場合、呼び出し元は絶対に推定レートへフォールバック
// してはいけない。この関数は失敗時に必ず例外を投げるので、呼び出し元は
// それをそのまま伝播させ、処理を停止すること。

const FRANKFURTER_ENDPOINT = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY';
const DEFAULT_TIMEOUT_MS = 8000;

async function fetchUsdToJpyRate(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(FRANKFURTER_ENDPOINT, { signal: controller.signal });

    if (!response.ok) {
      throw new Error('FX_RATE_HTTP_ERROR');
    }

    const data = await response.json();
    const rate = Number(data?.rates?.JPY);
    const date = String(data?.date || '').trim();

    if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
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
  FRANKFURTER_ENDPOINT,
  fetchUsdToJpyRate
};
