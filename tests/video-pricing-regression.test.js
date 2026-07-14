'use strict';

const assert = require('node:assert/strict');
const { calculateVideoCreditCost } = require('../api/_lib/video-pricing');

const MODELS = [
  'bytedance/seedance-2.0',
  'bytedance/seedance-2.0-fast',
  'bytedance/seedance-2.0-lite'
];
const MODES = ['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard'];
const RESOLUTIONS = ['480p', '720p', '1080p'];
const DURATIONS = Array.from({ length: 15 }, (_, index) => index + 1);

function legacyRoundUpToFive(value) {
  return Math.ceil(Math.max(50, Math.min(400, value)) / 5) * 5;
}

function legacySeedanceCreditCost({ mode, duration, resolution, model }) {
  if (mode === 'storyboard') {
    return legacyRoundUpToFive(Math.max(50, duration * 12));
  }
  let credits = 80;
  credits += Math.max(0, duration - 5) * 15;
  if (resolution === '1080p') credits += 100;
  if (resolution === '480p') credits -= 20;
  if (mode === 'text_to_video') credits -= 10;
  credits += 15;
  const multiplier = model === 'bytedance/seedance-2.0-fast' || model === 'bytedance/seedance-2.0-lite'
    ? 0.8
    : 1.0;
  const modeMultiplier = mode === 'reference_to_video' ? 1.15 : 1;
  return legacyRoundUpToFive(credits * multiplier * modeMultiplier);
}

let cases = 0;
for (const model of MODELS) {
  for (const mode of MODES) {
    for (const resolution of RESOLUTIONS) {
      for (const duration of DURATIONS) {
        const input = { model, mode, resolution, duration };
        assert.equal(
          calculateVideoCreditCost(input),
          legacySeedanceCreditCost(input),
          JSON.stringify(input)
        );
        cases += 1;
      }
    }
  }
}

assert.throws(
  () => calculateVideoCreditCost({ model: 'kwaivgi/kling-v3.0-pro' }),
  (error) => error && error.code === 'invalid_model'
);
assert.throws(
  () => calculateVideoCreditCost({ model: 'openai/sora-2-pro' }),
  (error) => error && error.code === 'invalid_model'
);
assert.throws(
  () => calculateVideoCreditCost({ model: 'x-ai/grok-imagine-video' }),
  (error) => error && error.code === 'invalid_model'
);

console.log(`video pricing regression passed: ${cases} Seedance combinations`);
