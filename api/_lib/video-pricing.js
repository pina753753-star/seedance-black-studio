'use strict';

const { getVideoModel, isGenerationEnabledModel } = require('./video-models');

const MIN_CREDITS = 50;
const MAX_CREDITS = 400;
const PRICING_SAFETY_MULTIPLIER = 1.15;

const PRICING_PROFILES = Object.freeze({
  seedance_standard_v1: Object.freeze({ modelMultiplier: 1.0 }),
  seedance_fast_v1: Object.freeze({ modelMultiplier: 0.8 }),
  seedance_lite_v1: Object.freeze({ modelMultiplier: 0.8 })
});

function roundUpToFive(value) {
  return Math.ceil(Math.max(MIN_CREDITS, Math.min(MAX_CREDITS, value)) / 5) * 5;
}

function calculateVideoCreditCost(input) {
  const body = input || {};
  const mode = String(body.mode || 'reference_to_video').trim();
  const duration = Number(body.duration ?? body.duration_seconds ?? 5);
  const resolution = String(body.resolution || '720p').trim();
  const modelId = String(body.model || 'bytedance/seedance-2.0').trim();

  if (!isGenerationEnabledModel(modelId)) {
    const error = new Error('Unsupported generation model.');
    error.code = 'invalid_model';
    throw error;
  }

  const model = getVideoModel(modelId);
  const profile = PRICING_PROFILES[model.pricingProfile];
  if (!profile) {
    const error = new Error('Pricing profile is not configured.');
    error.code = 'pricing_not_configured';
    throw error;
  }

  if (mode === 'storyboard') {
    return roundUpToFive(Math.max(MIN_CREDITS, duration * 12));
  }

  let credits = 80;
  credits += Math.max(0, duration - 5) * 15;
  if (resolution === '1080p') credits += 100;
  if (resolution === '480p') credits -= 20;
  if (mode === 'text_to_video') credits -= 10;
  credits += 15;

  const modeMultiplier = mode === 'reference_to_video'
    ? PRICING_SAFETY_MULTIPLIER
    : 1;

  return roundUpToFive(credits * profile.modelMultiplier * modeMultiplier);
}

module.exports = {
  MIN_CREDITS,
  MAX_CREDITS,
  PRICING_SAFETY_MULTIPLIER,
  PRICING_PROFILES,
  roundUpToFive,
  calculateVideoCreditCost
};
