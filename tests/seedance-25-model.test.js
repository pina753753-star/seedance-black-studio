'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVE_MODEL_IDS, getVideoModel } = require('../api/_lib/video-models');
const { validateVideoGenerationOptions } = require('../api/_lib/video-model-validation');

test('Seedance 2.5 routes only 1080p to WaveSpeed', () => {
  const model = getVideoModel('bytedance/seedance-2.5');
  assert.ok(model);
  assert.equal(model.enabledForGeneration, true);
  assert.ok(ACTIVE_MODEL_IDS.includes(model.id));
  assert.deepEqual(model.resolutions, ['480p', '720p', '1080p']);
  assert.deepEqual(model.providersByResolution, { '480p': 'openrouter', '720p': 'openrouter', '1080p': 'wavespeed' });
  assert.deepEqual(model.durations, { type: 'integer_range', min: 4, max: 30, integerOnly: true });
  assert.ok(model.aspectRatios.includes('21:9'));
  assert.equal(model.pricingSkus.videoTokens, '0.0000107');
});

test('Seedance 2.5 accepts its minimum and maximum duration', () => {
  for (const duration of [4, 30]) {
    const result = validateVideoGenerationOptions({
      model: 'bytedance/seedance-2.5',
      mode: 'reference_to_video',
      resolution: '720p',
      aspectRatio: '21:9',
      duration
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  }
});

test('Seedance 2.5 accepts 1080p and rejects durations outside 4-30 seconds', () => {
  const resolution = validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.5', resolution: '1080p', duration: 5
  });
  assert.equal(resolution.ok, true);

  for (const duration of [3, 31, 4.5, null]) {
    const result = validateVideoGenerationOptions({
      model: 'bytedance/seedance-2.5', resolution: '720p', duration
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_duration');
  }
});

test('empty duration keeps the existing five-second default', () => {
  const result = validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.5', resolution: '720p', duration: ''
  });
  assert.equal(result.ok, true);
  assert.equal(result.duration, 5);
});

test('existing Seedance 2.0 constraints and Fast 1080p reference block remain unchanged', () => {
  assert.equal(validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.0', mode: 'text_to_video', resolution: '1080p', duration: 15
  }).ok, true);
  assert.equal(validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.0', mode: 'text_to_video', resolution: '720p', duration: 16
  }).error, 'invalid_duration');
  assert.equal(validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.0-fast', mode: 'reference_to_video', resolution: '1080p', duration: 5
  }).error, 'unsupported_combination');
});

test('the public generation entry point forwards Seedance 2.5 to the core handler', async () => {
  const corePath = require.resolve('../api/_lib/seedance-start');
  const entryPath = require.resolve('../api/seedance-start-priced');
  const originalCore = require.cache[corePath];
  const originalEntry = require.cache[entryPath];
  let forwardedBody = null;

  try {
    require.cache[corePath] = {
      id: corePath,
      filename: corePath,
      loaded: true,
      exports: async (req) => { forwardedBody = req.body; }
    };
    delete require.cache[entryPath];
    const handler = require(entryPath);
    await handler({ method: 'POST', body: { model: 'bytedance/seedance-2.5', prompt: 'test' } }, {});
  } finally {
    if (originalCore) require.cache[corePath] = originalCore;
    else delete require.cache[corePath];
    if (originalEntry) require.cache[entryPath] = originalEntry;
    else delete require.cache[entryPath];
  }

  assert.equal(forwardedBody.model, 'bytedance/seedance-2.5');
});
