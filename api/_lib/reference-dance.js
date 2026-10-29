'use strict';

const REFERENCE_DANCE_BUCKET = 'seedance-reference-video';
const REFERENCE_DANCE_TABLE = 'seedance_reference_video_uploads';
const REFERENCE_DANCE_MODEL = 'bytedance/seedance-2.5';
const REFERENCE_DANCE_MODE = 'reference_to_video';
const REFERENCE_DANCE_RESOLUTION = '720p';
const REFERENCE_DANCE_RATES = Object.freeze({ '480p': 22, '720p': 44 });
const MAX_REFERENCE_DANCE_BYTES = 50 * 1024 * 1024;
const MIN_REFERENCE_DANCE_DURATION_MS = 4000;
const MAX_REFERENCE_DANCE_DURATION_MS = 15000;
const MIN_REFERENCE_DANCE_OUTPUT_SECONDS = 4;
const MAX_REFERENCE_DANCE_OUTPUT_SECONDS = 15;
const REFERENCE_DANCE_RETENTION_MS = 24 * 60 * 60 * 1000;
const REFERENCE_DANCE_SIGNED_URL_TTL_SECONDS = 60 * 60;
const REFERENCE_DANCE_MAX_PER_HOUR = 6;
const REFERENCE_DANCE_MAX_PER_DAY = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const REFERENCE_DANCE_PROMPT_MARKER = '[Pina Studio reference dance requirements]';
const PERMANENT_REFERENCE_DANCE_INSPECTION_ERRORS = new Set([
  'INVALID_REQUEST',
  'VIDEO_SIZE_INVALID',
  'VIDEO_UNREADABLE',
  'VIDEO_STREAM_MISSING',
  'VIDEO_CONTAINER_INVALID',
  'VIDEO_CODEC_UNSUPPORTED',
  'VIDEO_FRAMERATE_INVALID',
  'VIDEO_HDR_UNSUPPORTED',
  'VIDEO_PROFILE_UNSUPPORTED',
  'VIDEO_AUDIO_STRIP_FAILED',
  'VIDEO_DURATION_INVALID',
  'VIDEO_DURATION_MISMATCH',
  'VIDEO_DIMENSIONS_INVALID'
]);

function error(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPermanentReferenceDanceInspectionError(code) {
  return PERMANENT_REFERENCE_DANCE_INSPECTION_ERRORS.has(String(code || ''));
}

function stagingPath(userId, assetId) {
  return `staging/${userId}/${assetId}.mp4`;
}

function approvedPath(userId, assetId) {
  return `approved/${userId}/${assetId}.mp4`;
}

function reviewFramePath(userId, assetId, index) {
  return `review/${userId}/${assetId}/frame-${index}.jpg`;
}

function validateOwnedPath(kind, userId, assetId, value) {
  if (!isUuid(userId) || !isUuid(assetId) || typeof value !== 'string') return false;
  if (kind === 'staging') return value === stagingPath(userId, assetId);
  if (kind === 'approved') return value === approvedPath(userId, assetId);
  if (kind === 'review') {
    return /^review\/[0-9a-f-]+\/[0-9a-f-]+\/frame-[1-5]\.jpg$/i.test(value)
      && value.startsWith(`review/${userId}/${assetId}/`);
  }
  return false;
}

async function authorizeReferenceDanceAdmin(auth) {
  const adminEmail = String(process.env.ADMIN_EMAIL || 'hinaran53@gmail.com').trim().toLowerCase();
  const authEmail = String(auth?.user?.email || '').trim().toLowerCase();
  if (!auth?.user?.id || !adminEmail || authEmail !== adminEmail || !auth.supabase) {
    return { ok: false };
  }
  const { data, error: selectError } = await auth.supabase
    .from('profiles')
    .select('id,email,role')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (
    selectError
    || data?.role !== 'admin'
    || String(data.email || '').trim().toLowerCase() !== adminEmail
  ) {
    return { ok: false };
  }
  return { ok: true, admin: data };
}

function providerCostCents(referenceBillableSeconds, resolution = REFERENCE_DANCE_RESOLUTION) {
  if (!Object.hasOwn(REFERENCE_DANCE_RATES, resolution)) throw error('reference_dance_variant_not_allowed');
  if (!Number.isInteger(referenceBillableSeconds)
      || referenceBillableSeconds < 4
      || referenceBillableSeconds > 15) {
    throw error('invalid_reference_video_duration');
  }
  // WaveSpeed Motion Control charges $0.22/s at 480p and $0.44/s at 720p.
  // Billing uses only the reference-video duration. Output duration and aspect
  // ratio follow that video and are not separate provider inputs.
  return REFERENCE_DANCE_RATES[resolution] * referenceBillableSeconds;
}

function referenceDanceCredits(referenceBillableSeconds, resolution = REFERENCE_DANCE_RESOLUTION) {
  const cents = providerCostCents(referenceBillableSeconds, resolution);
  // Existing Turbo 720p: $6.00 provider cost for 30 seconds -> 550 credits.
  // Keep the same provider-cost-to-credit ratio and round upward to 5 credits.
  return Math.ceil(((cents * 11) / 12) / 5) * 5;
}

function validateReadyReferenceDance(row, userId) {
  if (!row || row.user_id !== userId || !isUuid(row.id)) throw error('reference_video_not_found');
  if (row.status !== 'ready') throw error('reference_video_not_ready');
  const expiresMs = Date.parse(String(row.expires_at || ''));
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) throw error('reference_video_expired');
  if (!Number.isFinite(Date.parse(String(row.rights_confirmed_at || '')))) throw error('reference_video_rights_unconfirmed');
  if (!validateOwnedPath('approved', userId, row.id, row.approved_path)) throw error('invalid_reference_video_path');
  if (!Number.isSafeInteger(Number(row.size_bytes)) || Number(row.size_bytes) < 1 || Number(row.size_bytes) > MAX_REFERENCE_DANCE_BYTES) {
    throw error('invalid_reference_video_size');
  }
  const durationMs = Number(row.duration_ms);
  const billable = Number(row.billable_seconds);
  if (!Number.isSafeInteger(durationMs)
      || durationMs < MIN_REFERENCE_DANCE_DURATION_MS
      || durationMs > MAX_REFERENCE_DANCE_DURATION_MS
      || !Number.isInteger(billable)
      || billable !== Math.max(4, Math.ceil(durationMs / 1000))) {
    throw error('invalid_reference_video_duration');
  }
  const width = Number(row.width);
  const height = Number(row.height);
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw error('invalid_reference_video_dimensions');
  }
  let divisor = width;
  let remainder = height;
  while (remainder) {
    [divisor, remainder] = [remainder, divisor % remainder];
  }
  if (row.video_codec !== 'h264' || !SHA256_RE.test(String(row.sha256 || ''))) {
    throw error('invalid_reference_video_probe');
  }
  return Object.freeze({
    assetId: row.id,
    approvedPath: row.approved_path,
    durationMs,
    billableSeconds: billable,
    width,
    height,
    aspectRatio: `${width / divisor}:${height / divisor}`,
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256)
  });
}

function validateReferenceDanceVariant({ model, mode, resolution }) {
  if (model !== REFERENCE_DANCE_MODEL
      || mode !== REFERENCE_DANCE_MODE
      || !Object.hasOwn(REFERENCE_DANCE_RATES, resolution)) {
    throw error('reference_dance_variant_not_allowed');
  }
  return true;
}

function buildReferenceDanceProviderPrompt(prompt) {
  const original = String(prompt || '').trim();
  if (!original || original.includes(REFERENCE_DANCE_PROMPT_MARKER)) return original;
  return `${original}\n\n${REFERENCE_DANCE_PROMPT_MARKER}
Use @Image 1 as the primary identity, face, hairstyle, body, and clothing reference.
Use @Video 1 only as the motion, dance timing, body rhythm, blocking, and camera-motion reference.
Keep the @Image 1 character consistent throughout. Perform the motion at the natural tempo of @Video 1; do not convert it to slow motion.
Preserve normal anatomy, stable hands and feet, continuous movement, and the requested framing. Do not copy the source video's person's identity or audio.`;
}

// ---- Kling v3.0 Pro Motion Control dance (admin BETA) ----
// A separate method from the Seedance 2.5 Motion Control dance above and from the
// disabled Kling candidate in video-models.js. It never trims or converts a video
// and never falls back to another method.
const KLING_DANCE_METHOD = 'kling_v3_motion_control';
const KLING_DANCE_PROVIDER_MODEL = 'kwaivgi/kling-v3.0-pro/motion-control';
// WaveSpeed bills a 3 s minimum, but PinaStudio accepts 4-10 s only: the existing
// inspector already rejects anything under 4 s, and that rule is kept as-is.
const KLING_DANCE_MIN_SECONDS = 4;
const KLING_DANCE_MAX_SECONDS = 10;
const KLING_DANCE_CHARACTER_ORIENTATION = 'image';

// Kling-only credits per second (owner decision: 19 cr/s, i.e. 5 s = 95, 10 s = 190).
// Never derived from Seedance pricing and never read from the request. If it is
// ever null/invalid, the server refuses to start (kling_dance_price_undecided)
// and the access endpoint reports no rate, so the UI disables sending.
// Tests override it via config.
const config = { creditsPerSecond: 19 };

function getKlingDanceCreditsPerSecond() {
  const rate = config.creditsPerSecond;
  return Number.isSafeInteger(rate) && rate > 0 ? rate : null;
}

function isKlingDanceRequested(body) {
  return Boolean(body && String(body.dance_method || '').trim());
}

// Throws on an unknown method so a typo can never silently select another path.
function parseKlingDanceMethod(body) {
  const raw = String((body && body.dance_method) || '').trim();
  if (!raw) return '';
  if (raw !== KLING_DANCE_METHOD) throw error('invalid_dance_method');
  return KLING_DANCE_METHOD;
}

// Measured length of the server-inspected video decides acceptance (no rounding
// is applied before the range check): < 4000 ms or > 10000 ms is refused.
// Billed seconds are the existing inspector value, ceil(durationMs / 1000), e.g.
// 4000 ms -> 4, 4001 ms -> 5, 9500 ms -> 10, 10000 ms -> 10, 10001 ms -> refused.
function validateKlingDanceDuration({ durationMs, billableSeconds }) {
  if (!Number.isFinite(durationMs)
      || durationMs < KLING_DANCE_MIN_SECONDS * 1000
      || durationMs > KLING_DANCE_MAX_SECONDS * 1000
      || billableSeconds !== Math.ceil(durationMs / 1000)) {
    throw error('kling_dance_duration_unsupported');
  }
  return billableSeconds;
}

// seconds: whole billable seconds of the inspected reference video.
function validateKlingDanceSeconds(seconds) {
  if (!Number.isInteger(seconds) || seconds < KLING_DANCE_MIN_SECONDS || seconds > KLING_DANCE_MAX_SECONDS) {
    throw error('kling_dance_duration_unsupported');
  }
  return seconds;
}

function klingDanceCredits(seconds, creditsPerSecond = getKlingDanceCreditsPerSecond()) {
  validateKlingDanceSeconds(seconds);
  if (!Number.isSafeInteger(creditsPerSecond) || creditsPerSecond < 1) throw error('kling_dance_price_undecided');
  return seconds * creditsPerSecond;
}

// Server owns orientation and sound. Nothing from the browser body is spread in.
function buildKlingDancePayload({ prompt, imageUrl, videoUrl }) {
  return {
    image: String(imageUrl || '').trim(),
    video: String(videoUrl || '').trim(),
    prompt: String(prompt || '').trim(),
    character_orientation: KLING_DANCE_CHARACTER_ORIENTATION,
    keep_original_sound: false
  };
}

const klingDance = Object.freeze({
  KLING_DANCE_METHOD,
  KLING_DANCE_PROVIDER_MODEL,
  KLING_DANCE_MIN_SECONDS,
  KLING_DANCE_MAX_SECONDS,
  config,
  getKlingDanceCreditsPerSecond,
  isKlingDanceRequested,
  parseKlingDanceMethod,
  validateKlingDanceSeconds,
  validateKlingDanceDuration,
  klingDanceCredits,
  buildKlingDancePayload
});

module.exports = {
  klingDance,
  REFERENCE_DANCE_BUCKET,
  REFERENCE_DANCE_TABLE,
  REFERENCE_DANCE_MODEL,
  REFERENCE_DANCE_MODE,
  REFERENCE_DANCE_RESOLUTION,
  MAX_REFERENCE_DANCE_BYTES,
  MIN_REFERENCE_DANCE_DURATION_MS,
  MAX_REFERENCE_DANCE_DURATION_MS,
  MIN_REFERENCE_DANCE_OUTPUT_SECONDS,
  MAX_REFERENCE_DANCE_OUTPUT_SECONDS,
  REFERENCE_DANCE_RETENTION_MS,
  REFERENCE_DANCE_SIGNED_URL_TTL_SECONDS,
  REFERENCE_DANCE_MAX_PER_HOUR,
  REFERENCE_DANCE_MAX_PER_DAY,
  UUID_RE,
  isUuid,
  isPermanentReferenceDanceInspectionError,
  stagingPath,
  approvedPath,
  reviewFramePath,
  validateOwnedPath,
  authorizeReferenceDanceAdmin,
  providerCostCents,
  referenceDanceCredits,
  validateReadyReferenceDance,
  validateReferenceDanceVariant,
  buildReferenceDanceProviderPrompt,
  REFERENCE_DANCE_PROMPT_MARKER
};

