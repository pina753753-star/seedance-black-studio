'use strict';

// Central configuration for the H3 Max queued-generation slice.
//
// Everything that is FIXED by product decision (15s / 768p / pricing /
// eligible plans / cooldown) lives here. Everything that is environment-
// specific (fal.ai endpoint, model ids, credentials) is read from process.env
// and validated by requireProviderConfig(); a missing credential fails closed.
//
// This module has no side effects and imports nothing from the Seedance,
// billing, or watermark code.

// ---- Fixed product parameters (single source of truth) ----

const DURATION_SECONDS = 15;         // fixed; sent to fal.ai as `duration`
const RESOLUTION_DB = '768p';        // stored in h3_live_jobs.resolution
const RESOLUTION_FAL = '768P';       // fal.ai `resolution` enum value

// BETA launch pricing.
// 2026-09-15 00:00 JST === 2026-09-14 15:00 UTC.
// The database migration uses the same UTC instant and remains authoritative
// for the amount stored on each job and actually deducted.
const CREDIT_PRICE_SWITCH_AT = '2026-09-14T15:00:00.000Z';
const CREDIT_COST_SALE = 60;
const CREDIT_COST_STANDARD = 130;

function currentCreditCost(at = Date.now()) {
  const time = at instanceof Date
    ? at.getTime()
    : (typeof at === 'number' ? at : Date.parse(String(at || '')));
  // Fail safe to the standard (higher) price if a caller supplies a bad date.
  if (!Number.isFinite(time)) return CREDIT_COST_STANDARD;
  return time < Date.parse(CREDIT_PRICE_SWITCH_AT) ? CREDIT_COST_SALE : CREDIT_COST_STANDARD;
}

// Backwards-compatible snapshot for older call sites. New user-facing code
// should call currentCreditCost() per request so a warm serverless instance
// cannot keep a stale price across the switch instant. The DB is authoritative.
const CREDIT_COST = currentCreditCost();

const INSTRUCTION_MIN_CHARS = 1;
const INSTRUCTION_MAX_CHARS = 2000;

// H3 Max eligibility. free / standard are NOT eligible. "Creator" and
// "quattro" are historical display names for the `team` plan; the canonical
// DB slug is `team`, so no extra slug is needed here.
const ALLOWED_PLANS = Object.freeze(['premium', 'scale', 'team', 'ultimate']);

// H3-only pacing. The one-active-job guard is enforced in SQL regardless.
const COOLDOWN_SECONDS = 10;

// ---- Image input (image -> video) ----

// Private quarantine bucket for image-mode input frames. Independent of
// Seedance's 'reference-image-quarantine'. Created in
// supabase/migrations/20260831090000_create_h3_live_slice.sql. Frames are never
// promoted to a public bucket.
const IMAGE_QUARANTINE_BUCKET = 'h3-live-image-quarantine';

const IMAGE_ALLOWED_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

// Signed-URL lifetimes. The moderation URL only has to survive one OpenAI fetch;
// the fal URL has to survive an unknown queue delay before fal downloads it.
const IMAGE_MODERATION_SIGNED_URL_TTL_SECONDS = 300;
const IMAGE_FAL_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;

// Abandoned uploads: absolute retention, then opportunistic sweep removes them.
const IMAGE_UPLOAD_RETENTION_MS = 48 * 60 * 60 * 1000;
const IMAGE_CLEANUP_MAX_PER_RUN = 20;

// Supabase Storage's createSignedUploadUrl() issues a token with a fixed,
// non-configurable ~2h expiry. Replacing a pending upload therefore defers its
// final deleted_at stamp by this long so a later sweep can catch an object
// resurrected via a retained token.
const IMAGE_SIGNED_UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000;

const INPUT_MODES = Object.freeze(['text', 'image']);

// ---- Multi-image input (reference / storyboard) ----
// Independent of the single-image mode above: h3-max-reference-image-store.js
// / h3_max_reference_uploads / the 'h3-max-reference-image-quarantine' bucket.
const REFERENCE_INPUT_MODES = Object.freeze(['reference', 'storyboard']);
const REFERENCE_MIN_IMAGES = 1;
const REFERENCE_MAX_IMAGES = 9;

// Client poll cadence hints returned to h3-live.html.
const FEED_POLL_MS = 1000;
const STATUS_POLL_MS = 2000;

// Minimum server-side gap between two upstream status polls for one job.
const STATUS_UPSTREAM_MIN_INTERVAL_MS = 2000;

// ---- Provider (fal.ai) configuration ----

const FAL_QUEUE_BASE_URL = String(
  process.env.FAL_QUEUE_BASE_URL || 'https://queue.fal.run'
).replace(/\/+$/, '');

const FAL_MODEL_ID_TEXT = String(
  process.env.FAL_H3_MAX_TEXT_MODEL_ID || 'minimax/h3-max/text-to-video'
).trim();
const FAL_MODEL_ID_IMAGE = String(
  process.env.FAL_H3_MAX_IMAGE_MODEL_ID || 'minimax/h3-max/image-to-video'
).trim();
const FAL_MODEL_ID_REFERENCE = String(
  process.env.FAL_H3_MAX_REFERENCE_MODEL_ID || 'minimax/h3-max/reference-to-video'
).trim();

function falApiKey() {
  return String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
}

function openaiApiKey() {
  return String(process.env.OPENAI_API_KEY || '').trim();
}

function requireProviderConfig(mode = 'text') {
  const missing = [];
  if (!falApiKey()) missing.push('FAL_KEY');
  if (!FAL_MODEL_ID_TEXT) missing.push('FAL_H3_MAX_TEXT_MODEL_ID');
  if (mode === 'image' && !FAL_MODEL_ID_IMAGE) missing.push('FAL_H3_MAX_IMAGE_MODEL_ID');
  if ((mode === 'reference' || mode === 'storyboard') && !FAL_MODEL_ID_REFERENCE) {
    missing.push('FAL_H3_MAX_REFERENCE_MODEL_ID');
  }
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(FAL_QUEUE_BASE_URL)) missing.push('FAL_QUEUE_BASE_URL');
  if (missing.length) return { ok: false, missing };
  return { ok: true };
}

function requireModerationConfig() {
  return openaiApiKey() ? { ok: true } : { ok: false, missing: ['OPENAI_API_KEY'] };
}

// ---- URL trust checks (never poll or play a URL we did not expect) ----

function parseHttpsUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'https:' ? u : null;
  } catch (_) {
    return null;
  }
}

function isTrustedFalQueueUrl(value) {
  const u = parseHttpsUrl(value);
  if (!u) return false;
  const base = parseHttpsUrl(FAL_QUEUE_BASE_URL);
  return Boolean(base) && u.host === base.host;
}

function isTrustedFalOutputUrl(value) {
  const u = parseHttpsUrl(value);
  if (!u) return false;
  return u.host === 'fal.media' || u.host.endsWith('.fal.media');
}

module.exports = {
  DURATION_SECONDS,
  RESOLUTION_DB,
  RESOLUTION_FAL,
  CREDIT_PRICE_SWITCH_AT,
  CREDIT_COST_SALE,
  CREDIT_COST_STANDARD,
  CREDIT_COST,
  currentCreditCost,
  INSTRUCTION_MIN_CHARS,
  INSTRUCTION_MAX_CHARS,
  ALLOWED_PLANS,
  COOLDOWN_SECONDS,
  IMAGE_QUARANTINE_BUCKET,
  IMAGE_ALLOWED_MIME,
  IMAGE_MAX_BYTES,
  IMAGE_MODERATION_SIGNED_URL_TTL_SECONDS,
  IMAGE_FAL_SIGNED_URL_TTL_SECONDS,
  IMAGE_UPLOAD_RETENTION_MS,
  IMAGE_CLEANUP_MAX_PER_RUN,
  IMAGE_SIGNED_UPLOAD_URL_TTL_MS,
  INPUT_MODES,
  REFERENCE_INPUT_MODES,
  REFERENCE_MIN_IMAGES,
  REFERENCE_MAX_IMAGES,
  FEED_POLL_MS,
  STATUS_POLL_MS,
  STATUS_UPSTREAM_MIN_INTERVAL_MS,
  FAL_QUEUE_BASE_URL,
  FAL_MODEL_ID_TEXT,
  FAL_MODEL_ID_IMAGE,
  FAL_MODEL_ID_REFERENCE,
  falApiKey,
  openaiApiKey,
  requireProviderConfig,
  requireModerationConfig,
  parseHttpsUrl,
  isTrustedFalQueueUrl,
  isTrustedFalOutputUrl
};
