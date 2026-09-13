'use strict';

// Standalone fail-closed moderation for H3 Live image-mode input (an uploaded
// first frame + the chat instruction).
//
// Independent of api/_lib/openai-moderation.js and
// api/_lib/reference-image-moderation-decision.js on purpose:
//   - openai-moderation.js carries Seedance-only contract (multi-image,
//     fictional-action review data, violence image indexes).
//   - reference-image-moderation-decision.js only blocks `sexual/minors`
//     because Seedance re-checks at generation time.
//
// Same upstream as api/_lib/h3-live-moderation.js: OpenAI omni-moderation-latest.
// Text and image are sent as SEPARATE requests so the caller can tell which one
// was the block reason.
//
// Uses the same narrow, violence-only secondary review as H3 Max Live
// (api/_lib/h3-director-moderation.js) via
// api/_lib/moderation-decision.js's resolveModerationDecision(): a moderation
// result whose flagged categories are EXACTLY ['violence'] is handed to the
// existing fictional-action secondary classifier. Any other flagged category
// (sexual/minors, violence/graphic, self-harm, multiple categories, or a
// flagged verdict with no identifiable category) blocks immediately without
// ever calling the secondary classifier.
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
const { resolveModerationDecision } = require('./moderation-decision.js');

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

function isViolenceOnly(categories) {
  const normalized = [...new Set(
    (Array.isArray(categories) ? categories : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )].sort();

  return normalized.length === 1 && normalized[0] === 'violence';
}

// Runs one moderation request for a single input item (text or image).
//   -> { ok:true, flagged:boolean, categories:[...], categoryAppliedInputTypes:{...},
//        flaggedImageUrls?, reviewImageUrls? }              (image inputType)
//   -> { ok:false, reason }
async function moderateOne(input, inputType, apiKey, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPENAI_MODERATION_ENDPOINT, {
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

    const categoryAppliedInputTypes = {};
    for (const category of categories) categoryAppliedInputTypes[category] = [inputType];

    const normalized = { ok: true, flagged, categories: [...categories], categoryAppliedInputTypes };
    if (inputType === 'image') {
      const url = Array.isArray(input) && input[0]?.image_url?.url ? String(input[0].image_url.url).trim() : '';
      normalized.flaggedImageUrls = url ? [url] : [];
      normalized.reviewImageUrls = url ? [url] : [];
    }
    return normalized;
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Applies the violence-only gate, then (only for a violence-only flagged
// result) defers to the existing fictional-action secondary review.
//   -> { ok:true,  allow:true }
//   -> { ok:true,  allow:false, categories:[...], reason }
//   -> { ok:false, reason }
async function resolveH3LiveImageModeration(prompt, moderation, options = {}) {
  if (!moderation || moderation.ok !== true) {
    return { ok: false, allow: false, reason: moderation?.reason || 'moderation_unavailable' };
  }

  if (moderation.flagged !== true) {
    return { ok: true, allow: true };
  }

  if (!isViolenceOnly(moderation.categories)) {
    return { ok: true, allow: false, categories: moderation.categories, reason: 'content_not_allowed' };
  }

  const resolveDecision = options.resolveDecision || resolveModerationDecision;
  const decision = await resolveDecision(prompt, moderation, options);
  if (!decision || decision.ok !== true) {
    return { ok: false, allow: false, reason: decision?.reason || 'secondary_classifier_unavailable' };
  }
  if (decision.allow !== true) {
    return { ok: true, allow: false, categories: moderation.categories, reason: decision.reason || 'content_not_allowed' };
  }
  return { ok: true, allow: true };
}

async function moderateH3LiveImageInput({ instruction, imageUrl } = {}, options = {}) {
  const apiKey = options.apiKey || openaiApiKey();
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };

  const text = String(instruction || '').trim();
  const url = String(imageUrl || '').trim();
  if (!text) return { ok: false, reason: 'empty_instruction' };
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'invalid_image_url' };

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;

  // Text first: if the instruction alone is disallowed, report it as the reason
  // without spending an image call.
  const textResult = await moderateOne([{ type: 'text', text }], 'text', apiKey, timeoutMs, fetchImpl);
  if (!textResult.ok) return { ok: false, reason: `text_${textResult.reason}` };

  const textDecision = await resolveH3LiveImageModeration(instruction, textResult, options);
  if (!textDecision.ok) return { ok: false, reason: textDecision.reason };
  if (!textDecision.allow) {
    return {
      ok: true,
      allow: false,
      source: 'text',
      categories: textDecision.categories || textResult.categories
    };
  }

  const imageResult = await moderateOne(
    [{ type: 'image_url', image_url: { url } }],
    'image',
    apiKey,
    timeoutMs,
    fetchImpl
  );
  if (!imageResult.ok) return { ok: false, reason: `image_${imageResult.reason}` };

  const imageDecision = await resolveH3LiveImageModeration(instruction, imageResult, options);
  if (!imageDecision.ok) return { ok: false, reason: imageDecision.reason };
  if (!imageDecision.allow) {
    return {
      ok: true,
      allow: false,
      source: 'image',
      categories: imageDecision.categories || imageResult.categories
    };
  }

  return { ok: true, allow: true };
}

// Image-only moderation (no instruction/text check at all). Added for H3 Max
// "reference" / "storyboard" (1-9 images): those modes moderate each image
// individually via this function, then moderate the shared instruction text
// ONCE via moderateH3LiveInstruction() (api/_lib/h3-live-moderation.js) after
// every image has passed — instead of repeating a text check per image the
// way moderateH3LiveImageInput() above does for the single-image mode.
// moderateH3LiveImageInput() itself is unchanged; this is a pure addition
// that reuses the same moderateOne() request helper.
//
// `instruction` is used ONLY as secondary-classifier context (when this
// image's moderation result is violence-only) — it never triggers an
// additional per-image text OpenAI Moderation call. The shared text
// moderation pass after all images pass is unaffected.
//
// Contract:
//   moderateH3LiveImageOnly({ imageUrl, instruction })
//     -> { ok:true,  allow:true }
//     -> { ok:true,  allow:false, source:'image', categories:[...] }
//     -> { ok:false, reason }                       check unavailable
async function moderateH3LiveImageOnly({ imageUrl, instruction } = {}, options = {}) {
  const apiKey = options.apiKey || openaiApiKey();
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };

  const url = String(imageUrl || '').trim();
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'invalid_image_url' };

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;

  const imageResult = await moderateOne(
    [{ type: 'image_url', image_url: { url } }],
    'image',
    apiKey,
    timeoutMs,
    fetchImpl
  );
  if (!imageResult.ok) return { ok: false, reason: `image_${imageResult.reason}` };

  const imageDecision = await resolveH3LiveImageModeration(instruction, imageResult, options);
  if (!imageDecision.ok) return { ok: false, reason: imageDecision.reason };
  if (!imageDecision.allow) {
    return {
      ok: true,
      allow: false,
      source: 'image',
      categories: imageDecision.categories || imageResult.categories
    };
  }

  return { ok: true, allow: true };
}

module.exports = { moderateH3LiveImageInput, moderateH3LiveImageOnly };
module.exports._test = { isViolenceOnly, flaggedCategories, moderateOne, resolveH3LiveImageModeration };
