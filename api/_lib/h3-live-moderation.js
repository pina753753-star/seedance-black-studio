'use strict';

// Standalone fail-closed text moderation for H3 Live chat instructions.
//
// Independent of api/_lib/openai-moderation.js (which is part of the Seedance
// flow) so a future change there cannot silently alter H3 Live behaviour.
// Same upstream: OpenAI omni-moderation-latest, text input only.
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

async function moderateH3LiveInstruction(instruction, options = {}) {
  const apiKey = openaiApiKey();
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };

  const text = String(instruction || '').trim();
  if (!text) return { ok: false, reason: 'empty_input' };

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
        input: [{ type: 'text', text }]
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

    if (flagged) {
      return { ok: true, allow: false, categories: [...categories] };
    }
    return { ok: true, allow: true };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { moderateH3LiveInstruction };
