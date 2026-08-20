'use strict';

const { getVideoModel, isGenerationEnabledModel } = require('./video-models');

const DEFAULT_MODEL = 'bytedance/seedance-2.0';
const DEFAULT_MODE = 'reference_to_video';
const DEFAULT_DURATION = 5;
const DEFAULT_RESOLUTION = '720p';
const DEFAULT_ASPECT_RATIO = '9:16';

function invalid(error, message) {
  return { ok: false, error, message };
}

function supportsDuration(model, duration) {
  const capability = model?.durations || {};
  if (!Number.isInteger(duration)) return false;
  if (Array.isArray(capability.values)) return capability.values.includes(duration);
  return duration >= Number(capability.min) && duration <= Number(capability.max);
}

function validateVideoGenerationOptions(input) {
  const body = input || {};
  const modelId = String(body.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  if (!isGenerationEnabledModel(modelId)) {
    return invalid('invalid_model', 'Unsupported generation model.');
  }

  const model = getVideoModel(modelId);
  const mode = String(body.mode || DEFAULT_MODE).trim() || DEFAULT_MODE;
  if (!model.modes.includes(mode)) {
    return invalid('invalid_mode', 'Unsupported generation mode.');
  }

  const resolution = String(body.resolution || DEFAULT_RESOLUTION).trim() || DEFAULT_RESOLUTION;
  if (!model.resolutions.includes(resolution)) {
    return invalid('invalid_resolution', 'このモデルでは選択した解像度を利用できません。');
  }

  const aspectRatio = String(body.aspectRatio || body.aspect_ratio || DEFAULT_ASPECT_RATIO).trim() || DEFAULT_ASPECT_RATIO;
  if (!model.aspectRatios.includes(aspectRatio)) {
    return invalid('invalid_aspect_ratio', 'このモデルでは選択したアスペクト比を利用できません。');
  }

  const providedDuration = body.duration !== undefined ? body.duration : body.duration_seconds;
  const rawDuration = providedDuration === undefined || providedDuration === ''
    ? DEFAULT_DURATION
    : providedDuration;
  const duration = Number(rawDuration);
  if (!supportsDuration(model, duration)) {
    const capability = model.durations || {};
    const range = Array.isArray(capability.values)
      ? capability.values.join(', ')
      : `${capability.min}〜${capability.max}`;
    return invalid('invalid_duration', `このモデルの長さは${range}秒の整数で指定してください。`);
  }

  const unsupported = (model.unsupportedCombinations || []).some((combination) =>
    Object.entries(combination).every(([key, value]) => ({ mode, resolution, aspectRatio, duration })[key] === value)
  );
  if (unsupported) {
    return invalid('unsupported_combination', 'このモデルと設定の組み合わせは利用できません。');
  }

  return { ok: true, model: modelId, modelInfo: model, mode, resolution, aspectRatio, duration };
}

module.exports = {
  DEFAULT_MODEL,
  validateVideoGenerationOptions
};
