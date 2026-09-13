'use strict';

// Standalone fail-closed text moderation for H3 Live chat instructions.
//
// Independent of api/_lib/openai-moderation.js (which is part of the Seedance
// flow) so a future change there cannot silently alter H3 Live behaviour.
// Same upstream: OpenAI omni-moderation-latest, text input only.
//
// Uses the same narrow, violence-only secondary review as H3 Max Live
// (api/_lib/h3-director-moderation.js): a moderation result whose flagged
// categories are EXACTLY ['violence'] is handed to the existing
// fictional-action secondary classifier via
// api/_lib/moderation-decision.js's resolveModerationDecision(). Any other
// flagged category (sexual/minors, violence/graphic, self-harm, multiple
// categories, or a flagged verdict with no identifiable category) blocks
// immediately without ever calling the secondary classifier.
//
// Contract:
//   moderateH3LiveInstruction(text)
//     -> { ok:true,  allow:true }                      instruction is clean
//     -> { ok:true,  allow:false, categories:[...] }   instruction is blocked
//     -> { ok:false, reason }                          check unavailable
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

// Runs the first-pass OpenAI moderation request for the instruction text.
//   -> { ok:true, flagged, categories:[...], categoryAppliedInputTypes:{...} }
//   -> { ok:false, reason }
async function moderateOne(text, options = {}) {
  const apiKey = options.apiKey || openaiApiKey();
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OPENAI_MODERATION_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODERATION_MODEL,
        input: [{ type: 'text', text: String(text || '') }]
      }),
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
      console.error('[h3-live-moderation] HTTP error:', response.status, String(raw).slice(0, 200));
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
    for (const category of categories) categoryAppliedInputTypes[category] = ['text'];

    return { ok: true, flagged, categories: [...categories], categoryAppliedInputTypes };
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
async function resolveH3LiveModeration(prompt, moderation, options = {}) {
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

async function moderateH3LiveInstruction(instruction, options = {}) {
  const text = String(instruction || '').trim();
  if (!text) return { ok: false, reason: 'empty_input' };

  const moderation = await moderateOne(text, options);
  if (!moderation.ok) return { ok: false, reason: moderation.reason };

  const decision = await resolveH3LiveModeration(instruction, moderation, options);
  if (!decision.ok) return { ok: false, reason: decision.reason };
  if (!decision.allow) {
    return { ok: true, allow: false, categories: decision.categories || moderation.categories, reason: decision.reason };
  }
  return { ok: true, allow: true };
}

module.exports = { moderateH3LiveInstruction };
module.exports._test = { isViolenceOnly, flaggedCategories, moderateOne, resolveH3LiveModeration };
