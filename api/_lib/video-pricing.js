'use strict';

const { getVideoModel, isGenerationEnabledModel } = require('./video-models');
const { referenceDanceCredits } = require('./reference-dance.js');

const MIN_CREDITS = 50;
const MAX_CREDITS = 400;
const PRICING_SAFETY_MULTIPLIER = 1.15;
const SEEDANCE_25_PRICING_BY_MODEL = Object.freeze({
  'bytedance/seedance-2.5': Object.freeze({
    maxCredits: 600,
    creditsPerSecond: Object.freeze({ '720p': 550 / 30, '1080p': 20 })
  }),
  'bytedance/seedance-2.5-standard': Object.freeze({
    maxCredits: 990,
    creditsPerSecond: Object.freeze({ '480p': 495 / 30, '720p': 990 / 30 })
  })
});

const PRICING_PROFILES = Object.freeze({
  seedance_standard_v1: Object.freeze({ modelMultiplier: 1.0, storyboardMultiplier: 1.0, maxCredits: MAX_CREDITS }),
  seedance_fast_v1: Object.freeze({ modelMultiplier: 0.8, storyboardMultiplier: 1.0, maxCredits: MAX_CREDITS }),
  seedance_lite_v1: Object.freeze({ modelMultiplier: 0.8, storyboardMultiplier: 1.0, maxCredits: MAX_CREDITS }),
  // Dedicated duration/resolution pricing is applied below for Seedance 2.5.
  seedance_2_5_v1: Object.freeze({ modelMultiplier: 1.0, storyboardMultiplier: 1.0, maxCredits: 990 })
});

function roundUpToFive(value, maxCredits = MAX_CREDITS) {
  return Math.ceil(Math.max(MIN_CREDITS, Math.min(maxCredits, value)) / 5) * 5;
}

// Approved 2.0 1080p floor: 24fps / 1024 tokens, $7.7/M tokens,
// FX180 + OpenRouter5.5%, API reserve20% + JPY20, Stripe3.6%,
// tax-exclusive proceeds and legacy annual10%-off Ultimate unit value.
// Budget assumptions, not a guarantee of actual profit. Other models unchanged.
function seedance20Minimum(model,resolution,duration,aspectRatio='9:16'){
  if(model!=='bytedance/seedance-2.0'||resolution!=='1080p')return 0;
  const pixels={'1:1':1080*1080,'4:3':1440*1080,'3:4':1080*1440,'16:9':1920*1080,'9:16':1080*1920}[aspectRatio]||1080*1920;
  const providerUsd=pixels*24*duration/1024*0.0000077;
  const netYenPerCredit=(15800/5100)*0.9*(1/1.1-0.036);
  return Math.ceil((providerUsd*180*1.055*1.2+20)/netYenPerCredit/5)*5;
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

  const seedance25Pricing = SEEDANCE_25_PRICING_BY_MODEL[modelId];
  if (seedance25Pricing) {
    // This field is supplied only after api/_lib/seedance-start.js has loaded
    // and validated a ready, service-role-only registry row. Callers must not
    // pass the browser request body through as this trusted value.
    if (body.referenceDanceBillableSeconds !== undefined && body.referenceDanceBillableSeconds !== null) {
      if (modelId !== 'bytedance/seedance-2.5' || mode !== 'reference_to_video' || !['480p', '720p'].includes(resolution)) {
        const error = new Error('Reference dance is not allowed for this variant.');
        error.code = 'reference_dance_variant_not_allowed';
        throw error;
      }
      return referenceDanceCredits(Number(body.referenceDanceBillableSeconds), resolution);
    }
    const creditsPerSecond = seedance25Pricing.creditsPerSecond[resolution]
      || seedance25Pricing.creditsPerSecond['720p'];
    return roundUpToFive(duration * creditsPerSecond, seedance25Pricing.maxCredits);
  }

  const minimum = seedance20Minimum(modelId, resolution, duration, body.aspectRatio || body.aspect_ratio || '9:16');
  if (mode === 'storyboard') {
    return Math.max(minimum, roundUpToFive(
      Math.max(MIN_CREDITS, duration * 12) * profile.storyboardMultiplier,
      profile.maxCredits
    ));
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

  return Math.max(minimum, roundUpToFive(
    credits * profile.modelMultiplier * modeMultiplier,
    profile.maxCredits
  ));
}

module.exports = {
  MIN_CREDITS,
  MAX_CREDITS,
  PRICING_SAFETY_MULTIPLIER,
  PRICING_PROFILES,
  roundUpToFive,
  calculateVideoCreditCost
};
