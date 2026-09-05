'use strict';

// Standalone fail-closed moderation for H3 Live image-mode input (an uploaded
// first frame + the chat instruction).
//
// Independent of api/_lib/openai-moderation.js and
// api/_lib/reference-image-moderation-decision.js on purpose:
//   - openai-moderation.js carries Seedance-only contract (multi-image,
//     fictional-action review data, violence image indexes).
//   - reference-image-moderation-decision.js only blocks `sexual/minors`
//     because Seedance re-checks at generation time. H3 Live has NO such
//     second gate and its output carries no watermark, so H3 blocks on ANY
//     flagged category instead.
//
// Same upstream as api/_lib/h3-live-moderation.js: OpenAI omni-moderation-latest.
// Text and image are sent as SEPARATE requests so the caller can tell which one
// was the block reason.
//
// Contract:
//   moderateH3LiveImageInput({ instruction, imageUrl })
//     -> { ok:true,  allow:true }
//     -> { ok:true,  allow:false, source:'text'|'image', categories:[...] }
//     -> { ok:false, reason }                       check unavailable
//
// Callers MUST fail closed: on ok:false return 503 and do not reserve, charge,
// or call fal.ai; on allow:false return 422.

const { openaiApiKey } = require('./h3-live-config.js');

const OPENAI_MODERATION_ENDPOINT = 'https://api.openai.com/v1/moderations';
const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';
const DEFAULT_TIMEOUT_MS = 10000;

function flaggedCategories(result) {
  const categories = result?.categories;
  if (!categories || typeof categories !== 'object') return [];
  return Object.entries(categories)
    .filter(([, flagged]) => flagged === true)
    .map(([category]) => category);
}

// Runs one moderation request for a single input item.
//   -> { ok:true, flagged:boolean, categories:[...] }
//   -> { ok:false, reason }
async function moderateOne(input, apiKey, timeoutMs) {
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
      return { ok: false, reason: 'invalid_json' };
    }

    if (!response.ok) {
      console.error('[h3-live-image-moderation] HTTP error:', response.status, String(raw).slice(0, 200));
      return { ok: false, reason: 'openai_http_error' };
    }

    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      return { ok: false, reason: 'invalid_response' };
    }

    const categories = new Set();
    let flagged = false;
    for (const result of data.results) {
      if (!result || typeof result.flagged !== 'boolean') {
        return { ok: false, reason: 'invalid_response' };
      }
      if (result.flagged) flagged = true;
      for (const category of flaggedCategories(result)) categories.add(category);
    }

    // A `flagged` verdict with no identifiable category is treated as
    // unavailable rather than silently allowed.
    if (flagged && categories.size === 0) {
      return { ok: false, reason: 'flagged_without_category' };
    }

    return { ok: true, flagged, categories: [...categories] };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function moderateH3LiveImageInput({ instruction, imageUrl } = {}, options = {}) {
  const apiKey = openaiApiKey();
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };

  const text = String(instruction || '').trim();
  const url = String(imageUrl || '').trim();
  if (!text) return { ok: false, reason: 'empty_instruction' };
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'invalid_image_url' };

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;

  // Text first: if the instruction alone is disallowed, report it as the reason
  // without spending an image call.
  const textResult = await moderateOne([{ type: 'text', text }], apiKey, timeoutMs);
  if (!textResult.ok) return { ok: false, reason: `text_${textResult.reason}` };
  if (textResult.flagged) {
    return { ok: true, allow: false, source: 'text', categories: textResult.categories };
  }

  const imageResult = await moderateOne(
    [{ type: 'image_url', image_url: { url } }],
    apiKey,
    timeoutMs
  );
  if (!imageResult.ok) return { ok: false, reason: `image_${imageResult.reason}` };
  if (imageResult.flagged) {
    return { ok: true, allow: false, source: 'image', categories: imageResult.categories };
  }

  return { ok: true, allow: true };
}

module.exports = { moderateH3LiveImageInput };
