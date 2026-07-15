'use strict';

const OPENAI_MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';
const DEFAULT_TIMEOUT_MS = 10000;

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

async function moderateContent(prompt, imageUrls, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return { ok: false, flagged: false, errorCode: 'missing_api_key' };
  }

  const text = String(prompt || '').trim();
  const urls = normalizeImageUrls(imageUrls);
  const input = [];
  if (text) input.push({ type: 'text', text });
  for (const url of urls) {
    input.push({ type: 'image_url', image_url: { url } });
  }

  if (input.length === 0) {
    return { ok: false, flagged: false, errorCode: 'empty_input' };
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
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
      return { ok: false, flagged: false, errorCode: 'openai_http_error', httpStatus: response.status };
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

    return {
      ok: true,
      flagged,
      categories: [...categories],
      checkedInputCount: input.length
    };
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

module.exports = {
  moderateContent,
  normalizeImageUrls
};
