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
  FAL_MODEL_ID_REFERENCE,
  falApiKey,
  isTrustedFalQueueUrl,
  isTrustedFalOutputUrl
} = require('./h3-live-config.js');

const REQUEST_TIMEOUT_MS = 15000;
const ANCHORED_SEGMENT_DURATION_SECONDS = 5;
const PROMPT_EXPANSION_DISABLED = 'disabled';
const PROMPT_EXPANSION_BALANCED = 'balanced';

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

const H3_MOTION_MARKER = '[Pina Studio H3 motion requirements]';
const EXPLICIT_SLOW_MOTION_RE = /ゆっくり|ゆるやか|スロー(?:モーション)?|slowly|slow[\s-]?motion/i;
const SLOW_MOTION_NEGATION_RE = /(?:ゆっくり|ゆるやか|スロー(?:モーション)?)(?:に|は|を)?(?:しない|しません|ではない|ではなく|禁止|不要|なし)|(?:no|without|avoid|do not use)\s+slow[\s-]?motion/i;
const FAST_ACTION_RE = /高速|素早|速く|急加速|全速|疾走|激しく|連続|戦|攻撃|斬|薙刀|敵|走|回避|ジャンプ|fast|rapid|quick|high[\s-]?speed|action|fight|attack|slash|run|dodge|jump/i;

function requestsSlowMotion(prompt) {
  return EXPLICIT_SLOW_MOTION_RE.test(prompt) && !SLOW_MOTION_NEGATION_RE.test(prompt);
}

const H3_FAST_MOTION_GUIDANCE = `${H3_MOTION_MARKER}
FAST REAL-TIME ACTION. Start moving in the first frame. Use immediate acceleration, clear body displacement, rapid consecutive actions, and immediate follow-through. Keep the full action readable without pose holds, lingering close-ups, floaty movement, or slow motion. Do not add unrequested music.`;

const H3_REALTIME_MOTION_GUIDANCE = `${H3_MOTION_MARKER}
REAL-TIME MOTION. Start the requested action immediately and keep it continuous at natural speed. Do not replace the action with pose holds, lingering close-ups, floaty movement, or slow motion. Do not add unrequested music.`;

const H3_EXPLICIT_SLOW_GUIDANCE = `${H3_MOTION_MARKER}
Follow the user's requested timing exactly. Keep slow motion only within the explicitly requested moment, then return immediately to the requested normal or fast speed. Do not add unrequested music.`;

function buildH3MaxMotionPrompt(instruction) {
  const originalPrompt = String(instruction || '').trim();

  if (!originalPrompt || originalPrompt.includes(H3_MOTION_MARKER)) {
    return originalPrompt;
  }

  const guidance = requestsSlowMotion(originalPrompt)
    ? H3_EXPLICIT_SLOW_GUIDANCE
    : FAST_ACTION_RE.test(originalPrompt)
      ? H3_FAST_MOTION_GUIDANCE
      : H3_REALTIME_MOTION_GUIDANCE;

  return `${originalPrompt}\n\n${guidance}`;
}

function textPromptExpansionMode(instruction) {
  return FAST_ACTION_RE.test(String(instruction || ''))
    ? PROMPT_EXPANSION_DISABLED
    : PROMPT_EXPANSION_BALANCED;
}

// Build the fal.ai input payload for a text instruction. The 15s duration is
// referenced here (and in buildH3MaxImageInput) and nowhere else. <-- SINGLE
// POINT OF CHANGE if fal.ai rejects 15s for minimax/h3-max.
function buildH3MaxInput(instruction) {
  return {
    prompt: buildH3MaxMotionPrompt(instruction),
    duration: DURATION_SECONDS,
    resolution: RESOLUTION_FAL,
    aspect_ratio: ASPECT_RATIO,
    enable_safety_checker: true,
    prompt_expansion_mode: textPromptExpansionMode(instruction)
  };
}

const H3_IMAGE_FIDELITY_MARKER = '[Pina Studio H3 image fidelity requirements]';

const H3_IMAGE_FIDELITY_GUIDANCE = `${H3_IMAGE_FIDELITY_MARKER}
The supplied image is the exact first frame. Begin from that frame without replacing or redesigning its main subject. Keep the same recognizable face, hair, eyes, outfit, accessories, body proportions, and colors throughout the video. Infer unseen details conservatively. Never morph, age, or change the subject unless the user explicitly requests it.`;

const H3_REFERENCE_FIDELITY_MARKER = '[Pina Studio H3 reference fidelity requirements]';
const H3_REFERENCE_FIDELITY_GUIDANCE = `${H3_REFERENCE_FIDELITY_MARKER}
Treat each Image N as an identity and design reference, not only a style reference. Keep every referenced subject recognizable, with the same face, hair, eyes, outfit, accessories, body proportions, and colors throughout the video. Do not merge distinct referenced subjects or redesign them unless the user explicitly requests it.`;
const H3_ANCHORED_CONTINUITY_MARKER = '[Pina Studio H3 anchored continuity requirements]';
const H3_ANCHORED_CONTINUITY_GUIDANCE = `${H3_ANCHORED_CONTINUITY_MARKER}
Image 1 is the sole authority for the character's identity, face, hair, outfit, accessories, proportions, and colors. When Video 1 is supplied, use it only for motion, pose, camera, scene, and temporal continuity. Never inherit a changed face, hair, outfit, accessories, proportions, or colors from Video 1.`;

function buildH3MaxImagePrompt(instruction) {
  const originalPrompt = String(instruction || '').trim();

  if (!originalPrompt) {
    return originalPrompt;
  }

  const motionPrompt = buildH3MaxMotionPrompt(originalPrompt);

  if (motionPrompt.includes(H3_IMAGE_FIDELITY_MARKER)) {
    return motionPrompt;
  }

  return `${motionPrompt}\n\n${H3_IMAGE_FIDELITY_GUIDANCE}`;
}

function buildH3MaxReferencePrompt(instruction) {
  const motionPrompt = buildH3MaxMotionPrompt(instruction);
  if (!motionPrompt || motionPrompt.includes(H3_REFERENCE_FIDELITY_MARKER)) return motionPrompt;
  return `${motionPrompt}\n\n${H3_REFERENCE_FIDELITY_GUIDANCE}`;
}

// Build the fal.ai input payload for an exact first frame + instruction.
// minimax/h3-max/image-to-video derives the canvas from image_url, so this
// payload intentionally does not send the reference endpoint's aspect_ratio.
function buildH3MaxImageInput(instruction, imageUrl) {
  return {
    prompt: buildH3MaxImagePrompt(instruction),
    image_url: String(imageUrl || '').trim(),
    duration: DURATION_SECONDS,
    resolution: RESOLUTION_FAL,
    enable_safety_checker: true,
    prompt_expansion_mode: PROMPT_EXPANSION_DISABLED
  };
}

// Build the fal.ai input payload for "reference" mode: 1-9 reference images,
// order not semantically meaningful beyond the "Image N" labels a user might
// reference in their own prompt text. <-- SINGLE POINT OF CHANGE if fal.ai's
// reference-to-video field names differ from this draft; verify against
// fal.ai docs before real use.
function buildH3MaxReferenceInput(instruction, imageUrls) {
  return {
    prompt: buildH3MaxReferencePrompt(instruction),
    reference_image_urls: (Array.isArray(imageUrls) ? imageUrls : []).map((u) => String(u || '').trim()),
    duration: DURATION_SECONDS,
    resolution: RESOLUTION_FAL,
    aspect_ratio: ASPECT_RATIO,
    enable_safety_checker: true,
    prompt_expansion_mode: PROMPT_EXPANSION_DISABLED
  };
}

// Build one short identity-anchored segment for the replacement Live path.
// The original character image is sent again for EVERY segment. From segment
// 2 onward, the immediately preceding 5-second output is also supplied as a
// motion/scene continuity reference. The previous video never replaces the
// original identity image.
//
// Verified against fal.ai's minimax/h3-max/reference-to-video schema on
// 2026-09-15: reference_image_urls and reference_video_urls are supported;
// reference video clips may be 2-15 seconds and their combined duration may
// not exceed 15 seconds. A single preceding 5-second clip stays inside that
// limit.
function buildH3AnchoredSegmentInput(instruction, identityImageUrl, previousVideoUrl = '', seed = null) {
  const previous = String(previousVideoUrl || '').trim();
  const hasSeed = seed !== null && seed !== undefined && String(seed).trim() !== '';
  const numericSeed = Number(seed);
  const prompt = buildH3MaxReferencePrompt(instruction);
  const input = {
    prompt: `${prompt}\n\n${H3_ANCHORED_CONTINUITY_GUIDANCE}`,
    reference_image_urls: [String(identityImageUrl || '').trim()],
    duration: ANCHORED_SEGMENT_DURATION_SECONDS,
    resolution: RESOLUTION_FAL,
    aspect_ratio: ASPECT_RATIO,
    enable_safety_checker: true,
    prompt_expansion_mode: PROMPT_EXPANSION_DISABLED
  };
  if (previous) input.reference_video_urls = [previous];
  if (hasSeed && Number.isSafeInteger(numericSeed) && numericSeed >= 0) input.seed = numericSeed;
  return input;
}

// "storyboard" mode reuses the exact same reference-to-video model and input
// shape, but the image ORDER is meant as a time-ordered hint. A short,
// fixed, system-side sentence is appended (never inserted mid-prompt, never
// replacing any of the user's own wording) so the model has SOME signal that
// order = time, without rewriting the user's intent. Kept deliberately short
// — this is a hint, not a scene-by-scene rewrite, and the product copy
// (h3-max-beta.html) already tells the user not to expect a guaranteed
// cut-by-cut result.
const STORYBOARD_ORDER_HINT =
  ' (添付画像はImage 1から順に時間的な流れの参考として使用してください。)';

function buildH3MaxStoryboardInput(instruction, imageUrls) {
  const base = buildH3MaxReferenceInput(instruction, imageUrls);
  return {
    ...base,
    prompt: `${base.prompt}${STORYBOARD_ORDER_HINT}`
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

function extractProviderDiagnostics(data) {
  const expandedPrompt = typeof data?.expanded_prompt === 'string'
    ? data.expanded_prompt.slice(0, 50000)
    : null;
  const rawSeed = Number(data?.seed);
  const seed = Number.isSafeInteger(rawSeed) ? rawSeed : null;
  const rawTimings = data?.timings;
  const timings = rawTimings && typeof rawTimings === 'object' && !Array.isArray(rawTimings)
    ? Object.fromEntries(
        Object.entries(rawTimings)
          .filter(([key, value]) => key.length <= 100 && Number.isFinite(Number(value)))
          .slice(0, 50)
          .map(([key, value]) => [key, Number(value)])
      )
    : null;
  return {
    expandedPrompt,
    seed,
    timings: timings && Object.keys(timings).length ? timings : null
  };
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
  const input = buildH3MaxInput(instruction);
  const result = await submitToFalQueue({
    modelId: FAL_MODEL_ID_TEXT,
    input
  });
  return { ...result, submittedPrompt: input.prompt };
}

// Submit an exact first frame + instruction -> video generation.
async function submitImageJob({ instruction, imageUrl }) {
  const url = String(imageUrl || '').trim();
  if (!/^https:\/\//i.test(url)) {
    return { ok: false, category: 'invalid_input', httpStatus: 0, detail: 'missing or non-https image_url' };
  }
  const input = buildH3MaxImageInput(instruction, url);
  const result = await submitToFalQueue({
    modelId: FAL_MODEL_ID_IMAGE,
    input
  });
  return { ...result, submittedPrompt: input.prompt };
}

// Submit a "reference" or "storyboard" (1-9 images) + instruction -> video
// generation. mode selects which system-side hint (if any) is appended;
// imageUrls must all be https URLs fal can fetch (short-lived Supabase
// signed URLs, same pattern as submitImageJob).
async function submitReferenceJob({ instruction, imageUrls, mode }) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : []).map((u) => String(u || '').trim());
  if (urls.length < 1 || urls.length > 9) {
    return { ok: false, category: 'invalid_input', httpStatus: 0, detail: 'reference image count must be 1-9' };
  }
  if (urls.some((u) => !/^https:\/\//i.test(u))) {
    return { ok: false, category: 'invalid_input', httpStatus: 0, detail: 'missing or non-https reference image url' };
  }
  const input = mode === 'storyboard'
    ? buildH3MaxStoryboardInput(instruction, urls)
    : buildH3MaxReferenceInput(instruction, urls);
  const result = await submitToFalQueue({
    modelId: FAL_MODEL_ID_REFERENCE,
    input
  });
  return { ...result, submittedPrompt: input.prompt };
}

async function submitAnchoredSegmentJob({ instruction, identityImageUrl, previousVideoUrl = '', seed = null }) {
  const identityUrl = String(identityImageUrl || '').trim();
  const previousUrl = String(previousVideoUrl || '').trim();
  if (!/^https:\/\//i.test(identityUrl)) {
    return { ok: false, category: 'invalid_input', httpStatus: 0, detail: 'missing or non-https identity image url' };
  }
  if (previousUrl && !isTrustedFalOutputUrl(previousUrl)) {
    return { ok: false, category: 'invalid_input', httpStatus: 0, detail: 'untrusted previous segment video url' };
  }
  const input = buildH3AnchoredSegmentInput(instruction, identityUrl, previousUrl, seed);
  const result = await submitToFalQueue({
    modelId: FAL_MODEL_ID_REFERENCE,
    input
  });
  return { ...result, submittedPrompt: input.prompt };
}

// HTTP statuses that mean "this job/request is genuinely gone or invalid" (as
// opposed to a transient error or queue/result data still propagating). A bare
// 404 is treated as transient — fal.ai can 404 briefly right after a job is
// accepted or right after it flips to COMPLETED.
const TERMINAL_HTTP_STATUSES = [400, 410, 422];

// A poll returning one of these means OUR request was rejected (bad/revoked
// FAL_KEY), not that the job itself failed — the job may still be running on
// fal's side. Unlike TERMINAL_HTTP_STATUSES this is NOT treated as a job
// failure here (that would risk refunding a job that later completes): it is
// still reported as ok:false/transient so the caller keeps polling, exactly
// like any other transient error. What it DOES do is log clearly so an
// operator sees "check FAL_KEY", not "the network is flaky", and it is the
// reason a job can be genuinely stuck forever if this persists: see
// api/h3-live/reconcile.js's "trackable but stalled" bucket, which is the
// bounded, operator-visible backstop for exactly this case (a job whose
// provider_poll_url exists but whose polls never make progress).
const AUTH_LIKE_HTTP_STATUSES = [401, 403];

function isAuthLikeFailure(httpStatus) {
  return AUTH_LIKE_HTTP_STATUSES.includes(Number(httpStatus));
}

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
    if (isAuthLikeFailure(sRes.status)) {
      console.error(
        '[h3-live-fal] status poll rejected with an auth-like HTTP status — this will not' +
        ' resolve by retrying; check FAL_KEY. httpStatus:', sRes.status
      );
    }
    // 404 / 5xx / auth-like / everything else -> transient; caller keeps polling.
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
    if (isAuthLikeFailure(rRes.status)) {
      console.error(
        '[h3-live-fal] result fetch rejected with an auth-like HTTP status — this will not' +
        ' resolve by retrying; check FAL_KEY. httpStatus:', rRes.status
      );
    }
    // 404 / 5xx / auth-like right after COMPLETED -> result data still propagating; keep polling.
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

  return {
    ok: true,
    state: 'completed',
    outputUrl,
    providerDiagnostics: extractProviderDiagnostics(rData)
  };
}

module.exports = {
  submitTextJob,
  submitImageJob,
  submitReferenceJob,
  submitAnchoredSegmentJob,
  getJobStatus,
  // exported for tests
  _internals: {
    buildH3MaxInput,
    buildH3MaxImageInput,
    buildH3MaxReferenceInput,
    buildH3MaxStoryboardInput,
    buildH3AnchoredSegmentInput,
    textPromptExpansionMode,
    classifyProviderError,
    extractVideoUrl,
    extractProviderDiagnostics,
    isAuthLikeFailure
  }
};

module.exports._test = {
  ...(module.exports._test || {}),
  buildH3MaxImagePrompt,
  buildH3MaxReferencePrompt,
  buildH3MaxImageInput,
  H3_IMAGE_FIDELITY_MARKER,
  H3_IMAGE_FIDELITY_GUIDANCE,
  H3_REFERENCE_FIDELITY_MARKER,
  H3_REFERENCE_FIDELITY_GUIDANCE,
  H3_ANCHORED_CONTINUITY_MARKER,
  H3_ANCHORED_CONTINUITY_GUIDANCE,
  buildH3MaxMotionPrompt,
  H3_MOTION_MARKER,
  H3_FAST_MOTION_GUIDANCE,
  H3_REALTIME_MOTION_GUIDANCE,
  H3_EXPLICIT_SLOW_GUIDANCE,
  EXPLICIT_SLOW_MOTION_RE,
  SLOW_MOTION_NEGATION_RE,
  requestsSlowMotion,
  FAST_ACTION_RE,
  ANCHORED_SEGMENT_DURATION_SECONDS,
  PROMPT_EXPANSION_DISABLED,
  PROMPT_EXPANSION_BALANCED
};
