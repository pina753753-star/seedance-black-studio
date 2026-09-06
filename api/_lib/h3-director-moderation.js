'use strict';

const { openaiApiKey } = require('./h3-director-config.js');

async function moderateDirectorPrompt(prompt) {
  const apiKey = openaiApiKey();
  if (!apiKey) return { ok: false, reason: 'missing_api_key' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: String(prompt || '') }),
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, reason: 'moderation_http_error' };
    const data = await response.json();
    if (!Array.isArray(data?.results) || typeof data.results[0]?.flagged !== 'boolean') {
      return { ok: false, reason: 'invalid_moderation_response' };
    }
    return { ok: true, allow: data.results[0].flagged !== true };
  } catch (error) {
    return { ok: false, reason: error?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { moderateDirectorPrompt };
