'use strict';

// H3 Max Director is a separate WebRTC product from the existing queued
// H3 Live feature. Keep its product and provider settings isolated so a
// Director rollout cannot change Seedance or api/h3-live/* behavior.

const DURATION_SECONDS = 60;
const RESOLUTION = '768p';
const DEFAULT_ASPECT_RATIO = '16:9';
const ALLOWED_ASPECT_RATIOS = Object.freeze(['16:9', '9:16']);
const CREDIT_COST = 440;
const PROMPT_MAX_CHARS = 2000;
const HEARTBEAT_INTERVAL_MS = 5000;
const SESSION_CREATE_TIMEOUT_MS = 45000;
const HEARTBEAT_TIMEOUT_MS = 4000;
const RECORDING_BUCKET = 'h3-director-recordings';
const RECORDING_MAX_BYTES = 150 * 1024 * 1024;
const RECORDING_MIME_TYPES = Object.freeze(['video/webm', 'video/mp4']);

const ALLOWED_PLANS = Object.freeze(['premium', 'scale', 'team', 'ultimate']);

const FAL_WMA_BASE_URL = String(process.env.FAL_WMA_BASE_URL || 'https://wma.fal.run')
  .replace(/\/+$/, '');
const FAL_DIRECTOR_APP_ID = String(
  process.env.FAL_H3_MAX_DIRECTOR_APP_ID || 'minimax/h3-max/director'
).trim();

function falApiKey() {
  return String(process.env.FAL_KEY || process.env.FAL_API_KEY || '').trim();
}

function openaiApiKey() {
  return String(process.env.OPENAI_API_KEY || '').trim();
}

function requireDirectorConfig() {
  const missing = [];
  if (!falApiKey()) missing.push('FAL_KEY');
  if (!FAL_DIRECTOR_APP_ID) missing.push('FAL_H3_MAX_DIRECTOR_APP_ID');
  try {
    const url = new URL(FAL_WMA_BASE_URL);
    if (url.protocol !== 'https:') missing.push('FAL_WMA_BASE_URL');
  } catch (_) {
    missing.push('FAL_WMA_BASE_URL');
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}

module.exports = {
  DURATION_SECONDS,
  RESOLUTION,
  DEFAULT_ASPECT_RATIO,
  ALLOWED_ASPECT_RATIOS,
  CREDIT_COST,
  PROMPT_MAX_CHARS,
  HEARTBEAT_INTERVAL_MS,
  SESSION_CREATE_TIMEOUT_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECORDING_BUCKET,
  RECORDING_MAX_BYTES,
  RECORDING_MIME_TYPES,
  ALLOWED_PLANS,
  FAL_WMA_BASE_URL,
  FAL_DIRECTOR_APP_ID,
  falApiKey,
  openaiApiKey,
  requireDirectorConfig
};
