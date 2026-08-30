'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVE_MODEL_IDS, getVideoModel } = require('../api/_lib/video-models');
const { validateVideoGenerationOptions } = require('../api/_lib/video-model-validation');

test('Seedance 2.5 standard and Turbo are separate active WaveSpeed models', () => {
  const standard = getVideoModel('bytedance/seedance-2.5-standard');
  const turbo = getVideoModel('bytedance/seedance-2.5');
  for (const model of [standard, turbo]) {
    assert.ok(model);
    assert.equal(model.enabledForGeneration, true);
    assert.equal(model.provider, 'wavespeed');
    assert.ok(ACTIVE_MODEL_IDS.includes(model.id));
    assert.deepEqual(model.durations, { type: 'integer_range', min: 4, max: 30, integerOnly: true });
    assert.ok(model.aspectRatios.includes('21:9'));
  }
  assert.equal(standard.displayName, 'Seedance 2.5');
  assert.deepEqual(standard.resolutions, ['480p', '720p']);
  assert.deepEqual(standard.providerModels, {
    text: 'bytedance/seedance-2.5/text-to-video',
    image: 'bytedance/seedance-2.5/image-to-video'
  });
  assert.equal(turbo.displayName, 'Seedance 2.5 Turbo');
  assert.deepEqual(turbo.resolutions, ['720p', '1080p']);
  assert.deepEqual(turbo.providerModels, {
    text: 'bytedance/seedance-2.5/text-to-video-turbo',
    image: 'bytedance/seedance-2.5/image-to-video-turbo'
  });
});

test('Seedance 2.5 accepts its minimum and maximum duration', () => {
  for (const model of ['bytedance/seedance-2.5-standard', 'bytedance/seedance-2.5']) {
    for (const duration of [4, 30]) {
      const result = validateVideoGenerationOptions({
        model, mode: 'reference_to_video', resolution: '720p', aspectRatio: '21:9', duration
      });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
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

test('standard accepts 480p while Turbo rejects it', () => {
  assert.equal(validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.5-standard', resolution: '480p', duration: 5
  }).ok, true);
  const turbo = validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.5', resolution: '480p', duration: 5
  });
  assert.equal(turbo.ok, false);
  assert.equal(turbo.error, 'invalid_resolution');
});

test('Turbo accepts 1080p while standard rejects it until separate pricing is approved', () => {
  assert.equal(validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.5', resolution: '1080p', duration: 5
  }).ok, true);
  const standard = validateVideoGenerationOptions({
    model: 'bytedance/seedance-2.5-standard', resolution: '1080p', duration: 5
  });
  assert.equal(standard.ok, false);
  assert.equal(standard.error, 'invalid_resolution');
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

test('the public generation entry point forwards both Seedance 2.5 variants to the core handler', async () => {
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
    for (const model of ['bytedance/seedance-2.5-standard', 'bytedance/seedance-2.5']) {
      await handler({ method: 'POST', body: { model, prompt: 'test' } }, {});
      assert.equal(forwardedBody.model, model);
    }
  } finally {
    if (originalCore) require.cache[corePath] = originalCore;
    else delete require.cache[corePath];
    if (originalEntry) require.cache[entryPath] = originalEntry;
    else delete require.cache[entryPath];
  }

});
