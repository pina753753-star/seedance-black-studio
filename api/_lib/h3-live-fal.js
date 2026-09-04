'use strict';

// Thin raw-`fetch` adapter for fal.ai's queue API, scoped to the H3 Max model.
//
// EVERY unverified fal.ai detail is isolated in this file:
//   - the request body shape (buildH3MaxInput)
//   - the fixed `duration: 15` value  <-- SINGLE POINT OF CHANGE if fal.ai
//     rejects 15s for minimax/h3-max; edit DURATION_SECONDS usage below only.
//   - the queue submit / status / result URL handling
//   - the response field names for request id and video url
//
// Verified from fal.ai public docs (2026-08-31):
//   submit : POST {base}/{model-id}         Authorization: Key <FAL_KEY>
//            optional ?fal_webhook=<url>
//            -> { request_id, status_url, response_url, cancel_url }
//   status : GET {status_url}  -> { status: "IN_QUEUE"|"IN_PROGRESS"|"COMPLETED" }
//   result : GET {response_url} -> { video: { url, content_type, ... }, ... }
// NOT verified: whether `duration: 15` is accepted, the exact prompt-expansion
// param name, terminal-failure payload shape, output URL lifetime. See the
// design report section E.

const {
  DURATION_SECONDS,
  RESOLUTION_FAL,
  FAL_QUEUE_BASE_URL,
  FAL_MODEL_ID_TEXT,
  FAL_MODEL_ID_IMAGE,
  falApiKey,
  isTrustedFalQueueUrl,
  isTrustedFalOutputUrl
} = require('./h3-live-config.js');

const REQUEST_TIMEOUT_MS = 15000;

// fal.ai aspect ratio for a broadcast-style screen.
const ASPECT_RATIO = '16:9';

function classifyProviderError(httpStatus, rawBody) {
  const body = String(rawBody || '');
  if (httpStatus === 401 || httpStatus === 403 || /unauthor|invalid.*key|forbidden/i.test(body)) {
    return 'auth';
  }
  if (httpStatus === 429 || /rate.?limit|too many requests/i.test(body)) {
    return 'rate_limit';
  }
  if (/content|safety|nsfw|moderat|policy|prohibited/i.test(body)) {
    return 'content_policy';
  }
  if (httpStatus === 422 || httpStatus === 400 || /invalid|validation|unsupported|must be/i.test(body)) {
    return 'invalid_input';
  }
  return 'unknown';
}

async function falFetch(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    return { response, text, data };
  } finally {
    clearTimeout(timer);
  }
}

// Build the fal.ai input payload for a text instruction. The 15s duration is
// referenced here (and in buildH3MaxImageInput) and nowhere else. <-- SINGLE
// POINT OF CHANGE if fal.ai rejects 15s for minimax/h3-max.
function buildH3MaxInput(instruction) {
  return {
    prompt: String(instruction || '').trim(),
    duration: DURATION_SECONDS,
    resolution: RESOLUTION_FAL,
    aspect_ratio: ASPECT_RATIO,
    enable_safety_checker: true,
    prompt_expansion_mode: 'balanced'
  };
}

// Build the fal.ai input payload for an image (first frame) + instruction.
// No aspect_ratio: minimax/h3-max/image-to-video derives the output aspect
// ratio from the supplied image. imageUrl must be an https URL fal can fetch
// (api/h3-live/start.js passes a short-lived Supabase signed URL).
function buildH3MaxImageInput(instruction, imageUrl) {
  return {
    prompt: String(instruction || '').trim(),
    image_url: String(imageUrl || '').trim(),
    duration: DURATION_SECONDS,
    resolution: RESOLUTION_FAL,
    enable_safety_checker: true,
    prompt_expansion_mode: 'balanced'
  };
}

function extractVideoUrl(data) {
  const candidates = [
    data?.video?.url,
    data?.output?.video?.url,
    data?.response?.video?.url,
    Array.isArray(data?.video) ? data.video[0]?.url : null,
    data?.video_url,
    data?.url
  ];
  for (const c of candidates) {
    const url = String(c || '').trim();
    if (url && isTrustedFalOutputUrl(url)) return url;
  }
  return '';
}

// POST an already-built input body to a fal.ai queue model.
//   -> { ok:true, requestId, statusUrl, responseUrl }
//   -> { ok:false, category, httpStatus, detail[, requestId] }
async function submitToFalQueue({ modelId, input }) {
  const apiKey = falApiKey();
  if (!apiKey) return { ok: false, category: 'auth', httpStatus: 0, detail: 'missing FAL_KEY' };
  if (!modelId) return { ok: false, category: 'invalid_input', httpStatus: 0, detail: 'missing fal model id' };

  const submitUrl = `${FAL_QUEUE_BASE_URL}/${modelId}`;
  let result;
  try {
    result = await falFetch(submitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    });
  } catch (error) {
    return {
      ok: false,
      category: error?.name === 'AbortError' ? 'timeout' : 'network_error',
      httpStatus: 0,
      detail: error?.message || String(error)
    };
  }

  const { response, text, data } = result;
  if (!response.ok) {
    return {
      ok: false,
      category: classifyProviderError(response.status, text),
      httpStatus: response.status,
      detail: String(text || '').slice(0, 500)
    };
  }

  const requestId = String(data?.request_id || data?.requestId || '').trim();
  const statusUrl = String(data?.status_url || data?.statusUrl || '').trim();
  const responseUrl = String(data?.response_url || data?.responseUrl || '').trim();

  if (!requestId || !isTrustedFalQueueUrl(statusUrl) || !isTrustedFalQueueUrl(responseUrl)) {
    // fal.ai returned 2xx — the job may well have been accepted and may keep
    // running — but we cannot track it. This is AMBIGUOUS, not a rejection:
    // the caller must NOT auto-refund. It keeps whatever request id we did get
    // for orphan recovery / support.
    return {
      ok: false,
      category: 'accepted_untrackable',
      httpStatus: response.status,
      requestId: requestId || null,
      detail: 'fal.ai returned 2xx but no usable request id / queue URLs'
    };
  }

  return { ok: true, requestId, statusUrl, responseUrl };
}

// Submit a text -> video generation to fal.ai's queue.
async function submitTextJob({ instruction }) {
  return submitToFalQueue({
    modelId: FAL_MODEL_ID_TEXT,
    input: buildH3MaxInput(instruction)
  });
}

// Submit an image (first frame) + instruction -> video generation.
async function submitImageJob({ instruction, imageUrl }) {
  const url = String(imageUrl || '').trim();
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, category: 'invalid_input', httpStatus: 0, detail: 'missing or non-https image_url' };
  }
  return submitToFalQueue({
    modelId: FAL_MODEL_ID_IMAGE,
    input: buildH3MaxImageInput(instruction, url)
  });
}

// HTTP statuses that mean "this job/request is genuinely gone or invalid" (as
// opposed to a transient error or queue/result data still propagating). A bare
// 404 is treated as transient — fal.ai can 404 briefly right after a job is
// accepted or right after it flips to COMPLETED.
const TERMINAL_HTTP_STATUSES = [400, 410, 422];

// Poll one job.
//   -> { ok:true, state:'processing' }
//   -> { ok:true, state:'completed', outputUrl }
//   -> { ok:true, state:'failed', errorCode, errorMessage }
//   -> { ok:false, detail }   (transient — caller keeps the job active)
async function getJobStatus({ statusUrl, responseUrl }) {
  const apiKey = falApiKey();
  if (!apiKey) return { ok: false, detail: 'missing FAL_KEY' };
  if (!isTrustedFalQueueUrl(statusUrl) || !isTrustedFalQueueUrl(responseUrl)) {
    return { ok: false, detail: 'untrusted queue URL' };
  }

  const headers = { Authorization: `Key ${apiKey}` };

  let statusResult;
  try {
    statusResult = await falFetch(statusUrl, { method: 'GET', headers });
  } catch (error) {
    return { ok: false, detail: error?.message || String(error) };
  }

  const { response: sRes, text: sText, data: sData } = statusResult;

  // A definite terminal failure reported by the status endpoint.
  const rawStatus = String(sData?.status || '').toUpperCase();
  if (sRes.ok && (rawStatus === 'FAILED' || rawStatus === 'ERROR' || rawStatus === 'CANCELLED')) {
    return {
      ok: true,
      state: 'failed',
      errorCode: 'provider_failed',
      errorMessage: String(sData?.error || sData?.detail || rawStatus).slice(0, 500)
    };
  }

  if (!sRes.ok) {
    if (TERMINAL_HTTP_STATUSES.includes(sRes.status)) {
      return {
        ok: true,
        state: 'failed',
        errorCode: `status_http_${sRes.status}`,
        errorMessage: String(sText || '').slice(0, 500)
      };
    }
    // 404 / 5xx / everything else -> transient; caller keeps polling.
    return { ok: false, detail: `status HTTP ${sRes.status}` };
  }

  if (rawStatus !== 'COMPLETED') {
    // IN_QUEUE / IN_PROGRESS / anything else non-terminal.
    return { ok: true, state: 'processing', providerStatus: rawStatus || null };
  }

  // COMPLETED -> fetch the result payload for the video URL.
  let resultResult;
  try {
    resultResult = await falFetch(responseUrl, { method: 'GET', headers });
  } catch (error) {
    return { ok: false, detail: error?.message || String(error) };
  }

  const { response: rRes, text: rText, data: rData } = resultResult;
  if (!rRes.ok) {
    if (TERMINAL_HTTP_STATUSES.includes(rRes.status)) {
      return {
        ok: true,
        state: 'failed',
        errorCode: `result_http_${rRes.status}`,
        errorMessage: String(rText || '').slice(0, 500)
      };
    }
    // 404 / 5xx right after COMPLETED -> result data still propagating; keep polling.
    return { ok: false, detail: `result HTTP ${rRes.status}` };
  }

  const outputUrl = extractVideoUrl(rData);
  if (!outputUrl) {
    // COMPLETED + 200 but no usable URL yet. Do NOT fail/refund a job the
    // provider said it finished — treat as transient so a later poll can pick
    // up the URL. (A permanently broken completion will keep showing
    // "processing"; that is safer than refunding a delivered generation.)
    return { ok: false, detail: 'completed but no video URL yet' };
  }

  return { ok: true, state: 'completed', outputUrl };
}

module.exports = {
  submitTextJob,
  submitImageJob,
  getJobStatus,
  // exported for tests
  _internals: { buildH3MaxInput, buildH3MaxImageInput, classifyProviderError, extractVideoUrl }
};
