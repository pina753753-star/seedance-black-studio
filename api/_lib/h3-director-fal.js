'use strict';

const {
  FAL_WMA_BASE_URL,
  FAL_DIRECTOR_APP_ID,
  falApiKey,
  SESSION_CREATE_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS
} = require('./h3-director-config.js');

async function falRequest(path, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${FAL_WMA_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${falApiKey()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) {}
    return { ok: response.ok, status: response.status, data, raw: raw.slice(0, 500) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      ambiguous: true,
      error: error?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function createDirectorSession({ sdp, type }) {
  const result = await falRequest('/session', {
    app_id: FAL_DIRECTOR_APP_ID,
    sdp,
    type
  }, SESSION_CREATE_TIMEOUT_MS);

  if (!result.ok) {
    const ambiguousStatus = result.status === 0 || result.status >= 500 || [408, 409, 425, 429].includes(result.status);
    return { ...result, ambiguous: Boolean(result.ambiguous || ambiguousStatus) };
  }
  if (!result.data?.session_id || !result.data?.sdp || result.data?.type !== 'answer') {
    return { ok: false, status: result.status, ambiguous: true, error: 'invalid_provider_response' };
  }
  return {
    ok: true,
    sessionId: String(result.data.session_id),
    sdp: String(result.data.sdp),
    type: 'answer'
  };
}

async function heartbeatDirectorSession(sessionId) {
  const result = await falRequest('/session/heartbeat', { session_id: sessionId }, HEARTBEAT_TIMEOUT_MS);
  if (!result.ok) return result;
  return { ok: true, alive: result.data?.alive !== false };
}

module.exports = { createDirectorSession, heartbeatDirectorSession };
