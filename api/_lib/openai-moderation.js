'use strict';

const OPENAI_MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';
const DEFAULT_TIMEOUT_MS = 10000;
// OpenAI's moderation endpoint accepts at most 1 image per request, so
// multi-image input is split into one request per image. This caps how many
// of those requests run at once, to reduce burst concurrency and lower the
// risk of rate-limit errors.
const MAX_CONCURRENT_MODERATION_REQUESTS = 3;

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

// Splits text + image URLs into per-request input batches: OpenAI's
// moderation endpoint rejects more than 1 image per call, so each image gets
// its own request. The prompt text (if any) rides along with the first batch
// (or its own batch, if there are no images) so it's still checked exactly once.
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
      body: JSON.stringify({
        model: OPENAI_MODERATION_MODEL,
        input
      }),
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
      return {
        ok: false,
        flagged: false,
        errorCode: 'openai_http_error',
        httpStatus: response.status,
        errorDetail
      };
    }

    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      return { ok: false, flagged: false, errorCode: 'invalid_response' };
    }

    const categories = new Set();
    let flagged = false;
    for (const result of data.results) {
      if (!result || typeof result.flagged !== 'boolean') {
        return { ok: false, flagged: false, errorCode: 'invalid_response' };
      }
      if (result.flagged) flagged = true;
      for (const category of flaggedCategories(result)) categories.add(category);
    }

    return { ok: true, flagged, categories: [...categories], checkedInputCount: input.length };
  } catch (error) {
    return {
      ok: false,
      flagged: false,
      errorCode: error?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Runs the given batches with bounded concurrency, so a 9-image request
// doesn't fire 9 simultaneous OpenAI requests and risk hitting rate limits.
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
  if (!apiKey) {
    return { ok: false, flagged: false, errorCode: 'missing_api_key' };
  }

  const text = String(prompt || '').trim();
  const urls = normalizeImageUrls(imageUrls);
  const batches = buildInputBatches(text, urls);

  if (batches.length === 0) {
    return { ok: false, flagged: false, errorCode: 'empty_input' };
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const concurrency = Number.isFinite(Number(options.maxConcurrentRequests))
    ? Math.max(1, Math.floor(Number(options.maxConcurrentRequests)))
    : MAX_CONCURRENT_MODERATION_REQUESTS;

  const results = await runBatchesWithConcurrencyLimit(batches, apiKey, timeoutMs, concurrency);

  const failed = results.find((result) => !result.ok);
  if (failed) {
    return failed;
  }

  const categories = new Set();
  let flagged = false;
  let checkedInputCount = 0;
  for (const result of results) {
    if (result.flagged) flagged = true;
    for (const category of result.categories || []) categories.add(category);
    checkedInputCount += result.checkedInputCount || 0;
  }

  return { ok: true, flagged, categories: [...categories], checkedInputCount };
}

module.exports = {
  moderateContent,
  normalizeImageUrls
};