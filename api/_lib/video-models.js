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
    canonicalSlug: 'kwaivgi/kling-v3.0-pro-20260429',
    displayName: 'Kling v3.0 Pro',
    provider: 'openrouter',
    status: MODEL_STATUS.CANDIDATE,
    enabledForGeneration: false,
    metadataConfidence: 'live_openrouter_video_models_api',
    durations: Object.freeze({ type: 'integer_range', min: 3, max: 15, integerOnly: true }),
    resolutions: Object.freeze(['720p']),
    aspectRatios: Object.freeze(['16:9', '9:16', '1:1']),
    sizes: Object.freeze(['1280x720', '720x1280', '720x720']),
    modes: Object.freeze(['text_to_video', 'image_to_video']),
    frameImages: Object.freeze(['first_frame', 'last_frame']),
    inputReferences: null,
    generateAudio: Object.freeze({ supported: true, currentDefault: null }),
    seed: Object.freeze({ supported: false }),
    allowedPassthroughParameters: Object.freeze(['negative_prompt', 'cfg_scale']),
    pricingSkus: Object.freeze({
      durationSeconds: '0.112',
      durationSecondsWithAudio: '0.168',
      textToVideoDurationSeconds480p: '0.112',
      textToVideoDurationSeconds720p: '0.112',
      imageToVideoDurationSeconds720p: '0.112',
      textToVideoDurationSeconds1080p: '0.112',
      imageToVideoDurationSeconds1080p: '0.112'
    }),
    pricingProfile: null,
    notes: Object.freeze([
      'Metadata was retrieved from the authenticated OpenRouter video models API on 2026-07-14.',
      'Only 720p is enabled in the capability definition because supported_resolutions contains only 720p.',
      '480p and 1080p pricing SKU keys do not override the supported_resolutions capability field.',
      'Reference-to-video is unverified because no formal input-reference capability field was returned.',
      'Pricing values are metadata only and are not connected to credit calculation.'
    ])
  }),

  'openai/sora-2-pro': Object.freeze({
    id: 'openai/sora-2-pro',
    canonicalSlug: 'openai/sora-2-pro-20260320',
    displayName: 'Sora 2 Pro',
    provider: 'openrouter',
    status: MODEL_STATUS.CANDIDATE,
    enabledForGeneration: false,
    metadataConfidence: 'live_openrouter_video_models_api',
    durations: Object.freeze({ type: 'discrete', values: Object.freeze([4, 8, 12, 16, 20]) }),
    resolutions: Object.freeze(['720p', '1080p']),
    aspectRatios: Object.freeze(['16:9', '9:16']),
    sizes: Object.freeze(['1280x720', '1080x1920', '1920x1080', '720x1280']),
    modes: Object.freeze(['text_to_video']),
    frameImages: null,
    inputReferences: null,
    generateAudio: Object.freeze({ supported: true, currentDefault: null }),
    seed: Object.freeze({ supported: false }),
    allowedPassthroughParameters: Object.freeze(['quality', 'style']),
    pricingSkus: Object.freeze({
      durationSeconds720p: '0.30',
      durationSeconds1024p: '0.50',
      durationSeconds1080p: '0.50'
    }),
    pricingProfile: null,
    notes: Object.freeze([
      'Metadata was retrieved from the authenticated OpenRouter video models API on 2026-07-14.',
      'Duration support is discrete: 4, 8, 12, 16, or 20 seconds.',
      'The existing global 1-15 integer validation must not be used for this model.',
      '1024p appears in pricing metadata but not in supported_resolutions, so it is not enabled.',
      'Image-to-video and reference-to-video remain unverified.',
      'Pricing values are metadata only and are not connected to credit calculation.',
      'Before enabling this model, credit pricing must be redesigned because long high-resolution jobs such as 20s at 1080p can greatly exceed the current 400-credit cap.'
    ])
  }),

  'x-ai/grok-imagine-video': Object.freeze({
    id: 'x-ai/grok-imagine-video',
    canonicalSlug: 'x-ai/grok-imagine-video-20260512',
    displayName: 'Grok Imagine Video',
    provider: 'openrouter',
    status: MODEL_STATUS.CANDIDATE,
    enabledForGeneration: false,
    metadataConfidence: 'live_openrouter_video_models_api',
    durations: Object.freeze({ type: 'integer_range', min: 1, max: 15, integerOnly: true }),
    fps: 24,
    resolutions: Object.freeze(['480p', '720p']),
    aspectRatios: Object.freeze(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3']),
    sizes: Object.freeze([
      '854x480', '1280x720', '480x854', '720x1280', '480x480', '720x720',
      '640x480', '960x720', '480x640', '720x960', '720x480', '1080x720',
      '480x720', '720x1080'
    ]),
    modes: Object.freeze(['text_to_video', 'image_to_video']),
    frameImages: Object.freeze(['first_frame']),
    inputReferences: null,
    generateAudio: null,
    seed: null,
    allowedPassthroughParameters: Object.freeze([]),
    pricingSkus: Object.freeze({
      centsPerImageInput: '0.2',
      centsPerVideoOutputSecond480p: '5',
      centsPerVideoOutputSecond720p: '7'
    }),
    pricingProfile: null,
    notes: Object.freeze([
      'Metadata was retrieved from the authenticated OpenRouter video models API on 2026-07-14.',
      'The model officially exists in the OpenRouter video models API.',
      'The description mentions reference-conditioned generation, but no formal input-reference capability field was returned.',
      'Reference-to-video therefore remains disabled and inputReferences remains null.',
      'Audio support was not supplied as a confirmed boolean and remains null.',
      'Pricing values are metadata only and are not connected to credit calculation.'
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