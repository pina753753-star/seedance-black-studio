'use strict';

const REFERENCE_DANCE_BUCKET = 'seedance-reference-video';
const REFERENCE_DANCE_TABLE = 'seedance_reference_video_uploads';
const REFERENCE_DANCE_MODEL = 'bytedance/seedance-2.5';
const REFERENCE_DANCE_MODE = 'reference_to_video';
const REFERENCE_DANCE_RESOLUTION = '720p';
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

function providerCostCents(referenceBillableSeconds) {
  if (!Number.isInteger(referenceBillableSeconds)
      || referenceBillableSeconds < 4
      || referenceBillableSeconds > 15) {
    throw error('invalid_reference_video_duration');
  }
  // WaveSpeed Seedance 2.5 Motion Control 720p is billed only by the
  // reference-video duration at $0.44 per second. Output duration and aspect
  // ratio follow that video and are not separate provider inputs.
  return 44 * referenceBillableSeconds;
}

function referenceDanceCredits(referenceBillableSeconds) {
  const cents = providerCostCents(referenceBillableSeconds);
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
  if (row.video_codec !== 'h264' || !SHA256_RE.test(String(row.sha256 || ''))) {
    throw error('invalid_reference_video_probe');
  }
  return Object.freeze({
    assetId: row.id,
    approvedPath: row.approved_path,
    durationMs,
    billableSeconds: billable,
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256)
  });
}

function validateReferenceDanceVariant({ model, mode, resolution }) {
  if (model !== REFERENCE_DANCE_MODEL
      || mode !== REFERENCE_DANCE_MODE
      || resolution !== REFERENCE_DANCE_RESOLUTION) {
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

module.exports = {
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
