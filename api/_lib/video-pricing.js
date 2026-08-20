'use strict';

const { getVideoModel, isGenerationEnabledModel } = require('./video-models');

const MIN_CREDITS = 50;
const MAX_CREDITS = 400;
const PRICING_SAFETY_MULTIPLIER = 1.15;
const SEEDANCE_25_MAX_CREDITS = 550;
const SEEDANCE_25_CREDITS_PER_SECOND = Object.freeze({
  '480p': 245 / 30,
  '720p': 550 / 30
});

const PRICING_PROFILES = Object.freeze({
  seedance_standard_v1: Object.freeze({ modelMultiplier: 1.0, storyboardMultiplier: 1.0, maxCredits: MAX_CREDITS }),
  seedance_fast_v1: Object.freeze({ modelMultiplier: 0.8, storyboardMultiplier: 1.0, maxCredits: MAX_CREDITS }),
  seedance_lite_v1: Object.freeze({ modelMultiplier: 0.8, storyboardMultiplier: 1.0, maxCredits: MAX_CREDITS }),
  // Dedicated duration/resolution pricing is applied below for Seedance 2.5.
  seedance_2_5_v1: Object.freeze({ modelMultiplier: 1.0, storyboardMultiplier: 1.0, maxCredits: SEEDANCE_25_MAX_CREDITS })
});

function roundUpToFive(value, maxCredits = MAX_CREDITS) {
  return Math.ceil(Math.max(MIN_CREDITS, Math.min(maxCredits, value)) / 5) * 5;
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

  if (modelId === 'bytedance/seedance-2.5') {
    const creditsPerSecond = SEEDANCE_25_CREDITS_PER_SECOND[resolution]
      || SEEDANCE_25_CREDITS_PER_SECOND['720p'];
    return roundUpToFive(duration * creditsPerSecond, profile.maxCredits);
  }

  if (mode === 'storyboard') {
    return roundUpToFive(
      Math.max(MIN_CREDITS, duration * 12) * profile.storyboardMultiplier,
      profile.maxCredits
    );
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

  return roundUpToFive(
    credits * profile.modelMultiplier * modeMultiplier,
    profile.maxCredits
  );
}

module.exports = {
  MIN_CREDITS,
  MAX_CREDITS,
  PRICING_SAFETY_MULTIPLIER,
  PRICING_PROFILES,
  roundUpToFive,
  calculateVideoCreditCost
};
