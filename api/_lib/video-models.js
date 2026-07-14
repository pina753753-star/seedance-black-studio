'use strict';

// Central capability registry for video generation models.
//
// Safety rules:
// - Only entries with enabledForGeneration=true may be accepted by production code.
// - candidate models remain disabled until their live OpenRouter metadata, pricing,
//   request shape, and a no-credit request preview have been reviewed.
// - null means unverified and MUST NOT be interpreted as supported.

const MODEL_STATUS = Object.freeze({
  ACTIVE: 'active',
  CANDIDATE: 'candidate',
  NOT_FOUND_IN_OFFICIAL_SNAPSHOT: 'not_found_in_official_snapshot'
});

const VIDEO_MODELS = Object.freeze({
  'bytedance/seedance-2.0': Object.freeze({
    id: 'bytedance/seedance-2.0',
    displayName: 'Seedance 2.0',
    provider: 'openrouter',
    status: MODEL_STATUS.ACTIVE,
    enabledForGeneration: true,
    metadataConfidence: 'production_verified',
    durations: Object.freeze({ min: 1, max: 15, integerOnly: true }),
    resolutions: Object.freeze(['480p', '720p', '1080p']),
    aspectRatios: Object.freeze(['9:16', '16:9', '1:1', '4:3', '3:4']),
    modes: Object.freeze(['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard']),
    generateAudio: Object.freeze({ supported: true, currentDefault: true }),
    pricingProfile: 'seedance_standard_v1',
    notes: Object.freeze([])
  }),

  'bytedance/seedance-2.0-fast': Object.freeze({
    id: 'bytedance/seedance-2.0-fast',
    displayName: 'Seedance 2.0 Fast',
    provider: 'openrouter',
    status: MODEL_STATUS.ACTIVE,
    enabledForGeneration: true,
    metadataConfidence: 'production_verified',
    durations: Object.freeze({ min: 1, max: 15, integerOnly: true }),
    resolutions: Object.freeze(['480p', '720p', '1080p']),
    aspectRatios: Object.freeze(['9:16', '16:9', '1:1', '4:3', '3:4']),
    modes: Object.freeze(['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard']),
    generateAudio: Object.freeze({ supported: true, currentDefault: true }),
    pricingProfile: 'seedance_fast_v1',
    unsupportedCombinations: Object.freeze([
      Object.freeze({ mode: 'reference_to_video', resolution: '1080p' })
    ]),
    notes: Object.freeze(['Reference-to-video at 1080p is blocked by the existing production flow.'])
  }),

  'bytedance/seedance-2.0-lite': Object.freeze({
    id: 'bytedance/seedance-2.0-lite',
    displayName: 'Seedance 2.0 Lite',
    provider: 'openrouter',
    status: MODEL_STATUS.ACTIVE,
    enabledForGeneration: true,
    metadataConfidence: 'production_verified',
    durations: Object.freeze({ min: 1, max: 15, integerOnly: true }),
    resolutions: Object.freeze(['480p', '720p', '1080p']),
    aspectRatios: Object.freeze(['9:16', '16:9', '1:1', '4:3', '3:4']),
    modes: Object.freeze(['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard']),
    generateAudio: Object.freeze({ supported: true, currentDefault: true }),
    pricingProfile: 'seedance_lite_v1',
    unsupportedCombinations: Object.freeze([
      Object.freeze({ mode: 'reference_to_video', resolution: '1080p' })
    ]),
    notes: Object.freeze(['Reference-to-video at 1080p is blocked by the existing production flow.'])
  }),

  'kwaivgi/kling-v3.0-pro': Object.freeze({
    id: 'kwaivgi/kling-v3.0-pro',
    displayName: 'Kling v3.0 Pro',
    provider: 'openrouter',
    status: MODEL_STATUS.CANDIDATE,
    enabledForGeneration: false,
    metadataConfidence: 'official_cookbook_model_list_only',
    durations: null,
    resolutions: null,
    aspectRatios: null,
    modes: null,
    generateAudio: null,
    pricingProfile: null,
    notes: Object.freeze([
      'Model ID is present in the official OpenRouter cookbook model-list output.',
      'Live GET /api/v1/videos/models metadata still requires an authorized read-only request.',
      'All null capability fields are unverified and must not be used for validation or UI.'
    ])
  }),

  'openai/sora-2-pro': Object.freeze({
    id: 'openai/sora-2-pro',
    displayName: 'Sora 2 Pro',
    provider: 'openrouter',
    status: MODEL_STATUS.CANDIDATE,
    enabledForGeneration: false,
    metadataConfidence: 'official_cookbook_model_list_only',
    durations: null,
    resolutions: null,
    aspectRatios: null,
    modes: null,
    generateAudio: null,
    pricingProfile: null,
    notes: Object.freeze([
      'Model ID is present in the official OpenRouter cookbook model-list output.',
      'Live GET /api/v1/videos/models metadata still requires an authorized read-only request.',
      'All null capability fields are unverified and must not be used for validation or UI.'
    ])
  }),

  'x-ai/grok-imagine-video': Object.freeze({
    id: 'x-ai/grok-imagine-video',
    displayName: 'Grok Imagine Video',
    provider: 'openrouter',
    status: MODEL_STATUS.NOT_FOUND_IN_OFFICIAL_SNAPSHOT,
    enabledForGeneration: false,
    metadataConfidence: 'not_verified',
    durations: null,
    resolutions: null,
    aspectRatios: null,
    modes: null,
    generateAudio: null,
    pricingProfile: null,
    notes: Object.freeze([
      'This is a placeholder candidate ID only; it is not a confirmed OpenRouter slug.',
      'Grok Imagine Video was absent from the official cookbook model-list output reviewed on 2026-07-14.',
      'Do not expose, validate, quote, or submit this entry until a live API response confirms its slug.'
    ])
  })
});

const ACTIVE_MODEL_IDS = Object.freeze(
  Object.values(VIDEO_MODELS)
    .filter((model) => model.enabledForGeneration === true)
    .map((model) => model.id)
);

function getVideoModel(modelId) {
  return VIDEO_MODELS[String(modelId || '').trim()] || null;
}

function isGenerationEnabledModel(modelId) {
  const model = getVideoModel(modelId);
  return Boolean(model && model.enabledForGeneration === true);
}

module.exports = {
  MODEL_STATUS,
  VIDEO_MODELS,
  ACTIVE_MODEL_IDS,
  getVideoModel,
  isGenerationEnabledModel
};
