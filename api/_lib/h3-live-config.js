'use strict';

// Central configuration for the H3 Live slice.
//
// Everything that is FIXED by product decision (15s / 768p / 110 credits /
// eligible plans / cooldown) lives here as a constant so there is exactly one
// place to change it. Everything that is ENVIRONMENT-specific (fal.ai
// endpoint, model ids, credentials) is read from process.env with a safe
// default and validated by requireProviderConfig(); a missing credential
// fails closed rather than sending a broken request.
//
// This module has no side effects and imports nothing from the Seedance,
// billing, or watermark code.

// ---- Fixed product parameters (single source of truth) ----

const DURATION_SECONDS = 15;         // fixed; sent to fal.ai as `duration`
const RESOLUTION_DB = '768p';        // stored in h3_live_jobs.resolution
const RESOLUTION_FAL = '768P';       // fal.ai `resolution` enum value
const CREDIT_COST = 110;             // existing credits consumed per video

const INSTRUCTION_MIN_CHARS = 1;
const INSTRUCTION_MAX_CHARS = 2000;

// H3 Live eligibility. free / standard are NOT eligible. "Creator" and
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
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;   // matches the bucket file_size_limit

// Signed-URL lifetimes. The moderation URL only has to survive one OpenAI fetch;
// the fal URL has to survive an unknown queue delay before fal downloads it.
const IMAGE_MODERATION_SIGNED_URL_TTL_SECONDS = 300;      // 5 min
const IMAGE_FAL_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;    // 24 h

// Abandoned uploads: absolute retention, then opportunistic sweep removes them.
const IMAGE_UPLOAD_RETENTION_MS = 48 * 60 * 60 * 1000;    // 48 h
const IMAGE_CLEANUP_MAX_PER_RUN = 20;

const INPUT_MODES = Object.freeze(['text', 'image']);

// Client poll cadence hints returned to h3-live.html.
const FEED_POLL_MS = 1000;
const STATUS_POLL_MS = 2000;

// Minimum server-side gap between two upstream status polls for one job.
const STATUS_UPSTREAM_MIN_INTERVAL_MS = 2000;

// ---- Provider (fal.ai) configuration ----

const FAL_QUEUE_BASE_URL = String(
  process.env.FAL_QUEUE_BASE_URL || 'https://queue.fal.run'
).replace(/\/+$/, '');

// fal.ai model identifiers. Confirmed by the product owner:
//   text -> minimax/h3-max/text-to-video
//   image -> minimax/h3-max/image-to-video
// Overridable by env in case fal.ai renames them.
const FAL_MODEL_ID_TEXT = String(
  process.env.FAL_H3_MAX_TEXT_MODEL_ID || 'minimax/h3-max/text-to-video'
).trim();
const FAL_MODEL_ID_IMAGE = String(
  process.env.FAL_H3_MAX_IMAGE_MODEL_ID || 'minimax/h3-max/image-to-video'
).trim();

// fal.ai authorization: `Authorization: Key <FAL_KEY>`.
function falApiKey() {
  return String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
}

function openaiApiKey() {
  return String(process.env.OPENAI_API_KEY || '').trim();
}

// Returns { ok:true } only when every credential required to start a real
// generation is present. Callers must fail closed (HTTP 503) when ok is false.
function requireProviderConfig(mode = 'text') {
  const missing = [];
  if (!falApiKey()) missing.push('FAL_KEY');
  if (!FAL_MODEL_ID_TEXT) missing.push('FAL_H3_MAX_TEXT_MODEL_ID');
  if (mode === 'image' && !FAL_MODEL_ID_IMAGE) missing.push('FAL_H3_MAX_IMAGE_MODEL_ID');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(FAL_QUEUE_BASE_URL)) missing.push('FAL_QUEUE_BASE_URL');
  if (missing.length) return { ok: false, missing };
  return { ok: true };
}

// Moderation is a separate hard requirement (fail closed if unavailable).
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

// A fal.ai queue URL (submit / status / response / cancel), e.g.
// https://queue.fal.run/minimax/h3-max/requests/<id>/status
function isTrustedFalQueueUrl(value) {
  const u = parseHttpsUrl(value);
  if (!u) return false;
  const base = parseHttpsUrl(FAL_QUEUE_BASE_URL);
  return Boolean(base) && u.host === base.host;
}

// A fal.ai delivered asset URL, e.g. https://v3b.fal.media/files/b/....mp4
function isTrustedFalOutputUrl(value) {
  const u = parseHttpsUrl(value);
  if (!u) return false;
  return u.host === 'fal.media' || u.host.endsWith('.fal.media');
}

module.exports = {
  DURATION_SECONDS,
  RESOLUTION_DB,
  RESOLUTION_FAL,
  CREDIT_COST,
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
  INPUT_MODES,
  FEED_POLL_MS,
  STATUS_POLL_MS,
  STATUS_UPSTREAM_MIN_INTERVAL_MS,
  FAL_QUEUE_BASE_URL,
  FAL_MODEL_ID_TEXT,
  FAL_MODEL_ID_IMAGE,
  falApiKey,
  openaiApiKey,
  requireProviderConfig,
  requireModerationConfig,
  parseHttpsUrl,
  isTrustedFalQueueUrl,
  isTrustedFalOutputUrl
};
