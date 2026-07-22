'use strict';

const OPENAI_MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_CONCURRENT_MODERATION_REQUESTS = 3;

// Ordinary fictional/action violence is not enough by itself to block a video
// request. Higher-risk categories still fail closed. OpenRouter/Seedance keeps
// its own provider-side safety checks as a second layer.
const ALLOWLISTED_SOLE_CATEGORIES = new Set(['violence']);

function normalizeImageUrls(imageUrls) {
  return [...new Set((Array.isArray(imageUrls) ? imageUrls : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https:\/\//i.test(url)))];
}

function flaggedCategories(result) {
  const categories = result?.categories;
  if (!categories || typeof categories !== 'object') return [];
  return Object.entries(categories)
    .filter(([, flagged]) => flagged === true)
    .map(([category]) => category);
}

function categoryScores(result) {
  const scores = result?.category_scores;
  if (!scores || typeof scores !== 'object') return {};
  return Object.fromEntries(Object.entries(scores)
    .filter(([, score]) => Number.isFinite(Number(score)))
    .map(([category, score]) => [category, Number(score)]));
}

function evaluateModerationPolicy(categories) {
  const unique = [...new Set(Array.isArray(categories) ? categories : [])];
  if (unique.length === 0) {
    return { blocked: false, allowedCategories: [], blockedCategories: [] };
  }

  const blockedCategories = unique.filter((category) => !ALLOWLISTED_SOLE_CATEGORIES.has(category));
  if (blockedCategories.length > 0) {
    return { blocked: true, allowedCategories: [], blockedCategories };
  }

  return { blocked: false, allowedCategories: unique, blockedCategories: [] };
}

function safeErrorDetail(response, data) {
  const error = data?.error && typeof data.error === 'object' ? data.error : {};
  return {
    httpStatus: response.status,
    type: typeof error.type === 'string' ? error.type : null,
    code: typeof error.code === 'string' ? error.code : null,
    message: typeof error.message === 'string' ? error.message.slice(0, 100) : null,
    requestId: response.headers.get('x-request-id') || response.headers.get('request-id') || null
  };
}

function buildInputBatches(text, urls) {
  if (urls.length === 0) {
    return text ? [[{ type: 'text', text }]] : [];
  }
  return urls.map((url, index) => {
    const items = [];
    if (index === 0 && text) items.push({ type: 'text', text });
    items.push({ type: 'image_url', image_url: { url } });
    return items;
  });
}

async function runSingleModerationRequest(input, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(OPENAI_MODERATION_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input }),
      signal: controller.signal
    });

    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      return { ok: false, flagged: false, errorCode: 'invalid_json', httpStatus: response.status };
    }

    if (!response.ok) {
      const errorDetail = safeErrorDetail(response, data);
      console.error('[openai-moderation] HTTP error:', errorDetail);
      return { ok: false, flagged: false, errorCode: 'openai_http_error', httpStatus: response.status, errorDetail };
    }

    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      return { ok: false, flagged: false, errorCode: 'invalid_response' };
    }

    const categories = new Set();
    const scores = {};
    for (const result of data.results) {
      if (!result || typeof result.flagged !== 'boolean') {
        return { ok: false, flagged: false, errorCode: 'invalid_response' };
      }
      for (const category of flaggedCategories(result)) categories.add(category);
      for (const [category, score] of Object.entries(categoryScores(result))) {
        scores[category] = Math.max(scores[category] || 0, score);
      }
    }

    const policy = evaluateModerationPolicy([...categories]);
    return {
      ok: true,
      flagged: policy.blocked,
      categories: [...categories],
      blockedCategories: policy.blockedCategories,
      allowedCategories: policy.allowedCategories,
      categoryScores: scores,
      checkedInputCount: input.length
    };
  } catch (error) {
    return { ok: false, flagged: false, errorCode: error?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timeout);
  }
}

async function runBatchesWithConcurrencyLimit(batches, apiKey, timeoutMs, limit) {
  const results = new Array(batches.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < batches.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await runSingleModerationRequest(batches[currentIndex], apiKey, timeoutMs);
    }
  }

  const workerCount = Math.min(limit, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function moderateContent(prompt, imageUrls, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return { ok: false, flagged: false, errorCode: 'missing_api_key' };

  const text = String(prompt || '').trim();
  const urls = normalizeImageUrls(imageUrls);
  const batches = buildInputBatches(text, urls);
  if (batches.length === 0) return { ok: false, flagged: false, errorCode: 'empty_input' };

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const concurrency = Number.isFinite(Number(options.maxConcurrentRequests))
    ? Math.max(1, Math.floor(Number(options.maxConcurrentRequests)))
    : MAX_CONCURRENT_MODERATION_REQUESTS;

  const results = await runBatchesWithConcurrencyLimit(batches, apiKey, timeoutMs, concurrency);
  const failed = results.find((result) => !result.ok);
  if (failed) return failed;

  const categories = new Set();
  const blockedCategories = new Set();
  const allowedCategories = new Set();
  const scores = {};
  let blocked = false;
  let checkedInputCount = 0;

  for (const result of results) {
    if (result.flagged) blocked = true;
    for (const category of result.categories || []) categories.add(category);
    for (const category of result.blockedCategories || []) blockedCategories.add(category);
    for (const category of result.allowedCategories || []) allowedCategories.add(category);
    for (const [category, score] of Object.entries(result.categoryScores || {})) {
      scores[category] = Math.max(scores[category] || 0, score);
    }
    checkedInputCount += result.checkedInputCount || 0;
  }

  return {
    ok: true,
    flagged: blocked,
    categories: [...categories],
    blockedCategories: [...blockedCategories],
    allowedCategories: [...allowedCategories],
    categoryScores: scores,
    checkedInputCount
  };
}

module.exports = {
  moderateContent,
  normalizeImageUrls,
  evaluateModerationPolicy
};
