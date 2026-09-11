'use strict';

// H3 Max Live text/image moderation with a narrow, violence-only secondary
// review — the same "fictional-action" safety exception already used by
// Seedance (api/_lib/openai-moderation.js + api/_lib/moderation-decision.js +
// api/_lib/fictional-action-classifier.js), reused here as-is (imported, not
// re-implemented). ONLY a moderation result whose flagged categories are
// EXACTLY ['violence'] is ever handed to the secondary classifier. Any other
// flagged category (sexual/minors, violence/graphic, self-harm, multiple
// categories, or a flagged verdict with no identifiable category) blocks
// immediately without ever calling the secondary classifier.
//
// Independent of api/_lib/h3-live-image-moderation.js on purpose: H3 Max
// (h3-live.html) has no second gate and blocks on ANY flagged category, by
// design (see the note at the top of that file). H3 Max Live's own kill
// switch/entitlement/billing are unaffected by this file.
//
// Contract:
//   moderateDirectorPrompt(prompt, options?)
//     -> { ok:true,  allow:true }
//     -> { ok:true,  allow:false, categories:[...], reason }
//     -> { ok:false, reason }                              check unavailable
//
//   moderateDirectorImageInput({ instruction, imageUrl }, options?)
//     -> { ok:true,  allow:true }
//     -> { ok:true,  allow:false, source:'text'|'image', categories:[...], reason }
//     -> { ok:false, reason }                              check unavailable
//
// Callers MUST fail closed: on ok:false return 503 and do not reserve,
// charge, or call fal.ai; on allow:false return 422/409 as appropriate.

const { openaiApiKey } = require('./h3-director-config.js');
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

// Runs one first-pass OpenAI moderation request for a single text or image
// input.
//   -> { ok:true, flagged, categories:[...], categoryAppliedInputTypes:{...},
//        flaggedImageUrls?, reviewImageUrls? }              (image inputType)
//   -> { ok:false, reason }
async function moderateOne(input, inputType, options = {}) {
  const apiKey = options.apiKey || openaiApiKey();
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const requestInput = inputType === 'image'
    ? [{ type: 'image_url', image_url: { url: String(input || '') } }]
    : [{ type: 'text', text: String(input || '') }];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPENAI_MODERATION_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input: requestInput }),
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
      console.error('[h3-director-moderation] HTTP error:', response.status, String(raw).slice(0, 200));
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
      const url = String(input || '').trim();
      normalized.flaggedImageUrls = url ? [url] : [];
      normalized.reviewImageUrls = url ? [url] : [];
    }
    return normalized;
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timeout);
  }
}

// Applies the violence-only gate, then (only for a violence-only flagged
// result) defers to the existing fictional-action secondary review.
//   -> { ok:true,  allow:true }
//   -> { ok:true,  allow:false, categories:[...], reason }
//   -> { ok:false, reason }
async function resolveDirectorModeration(prompt, moderation, options = {}) {
  if (!moderation || moderation.ok !== true) {
    return { ok: false, allow: false, reason: moderation?.reason || 'moderation_unavailable' };
  }

  if (moderation.flagged !== true) {
    return { ok: true, allow: true };
  }

  // Any category other than violence (or more than one flagged category)
  // blocks immediately. The secondary classifier is never consulted here.
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

async function moderateDirectorPrompt(prompt, options = {}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, reason: 'empty_prompt' };

  const moderation = await moderateOne(text, 'text', options);
  if (!moderation.ok) return { ok: false, reason: moderation.reason };

  const decision = await resolveDirectorModeration(prompt, moderation, options);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  if (!decision.allow) {
    return { ok: true, allow: false, categories: decision.categories || moderation.categories, reason: decision.reason };
  }
  return { ok: true, allow: true };
}

async function moderateDirectorImageInput({ instruction, imageUrl } = {}, options = {}) {
  const text = String(instruction || '').trim();
  const url = String(imageUrl || '').trim();
  if (!text) return { ok: false, reason: 'empty_instruction' };
  if (!/^https:\/\//i.test(url)) return { ok: false, reason: 'invalid_image_url' };

  // Text first: if the instruction alone is disallowed, report it as the
  // reason without spending an image moderation call.
  const textModeration = await moderateOne(text, 'text', options);
  if (!textModeration.ok) return { ok: false, reason: `text_${textModeration.reason}` };

  const textDecision = await resolveDirectorModeration(instruction, textModeration, options);
  if (!textDecision.ok) return { ok: false, reason: textDecision.reason };
  if (!textDecision.allow) {
    return {
      ok: true,
      allow: false,
      source: 'text',
      categories: textDecision.categories || textModeration.categories,
      reason: textDecision.reason
    };
  }

  const imageModeration = await moderateOne(url, 'image', options);
  if (!imageModeration.ok) return { ok: false, reason: `image_${imageModeration.reason}` };

  const imageDecision = await resolveDirectorModeration(instruction, imageModeration, options);
  if (!imageDecision.ok) return { ok: false, reason: imageDecision.reason };
  if (!imageDecision.allow) {
    return {
      ok: true,
      allow: false,
      source: 'image',
      categories: imageDecision.categories || imageModeration.categories,
      reason: imageDecision.reason
    };
  }

  return { ok: true, allow: true };
}

module.exports = { moderateDirectorPrompt, moderateDirectorImageInput };
module.exports._test = { isViolenceOnly, flaggedCategories, moderateOne, resolveDirectorModeration };
