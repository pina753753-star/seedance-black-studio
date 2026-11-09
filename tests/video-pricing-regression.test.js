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
        // Seedance 2.0 / Fast 480p 4-15s (non-storyboard) is intentionally repriced;
        // its exact values are verified in seedance20-480p-pricing.test.js.
        if ((model === 'bytedance/seedance-2.0' || model === 'bytedance/seedance-2.0-fast') && resolution === '480p' && mode !== 'storyboard' && duration >= 4 && duration <= 15) continue;
        assert.equal(
          calculateVideoCreditCost(input),
          model === 'bytedance/seedance-2.0' && resolution === '1080p'
            ? Math.max(legacySeedanceCreditCost(input), Math.ceil(((1080*1920*24*duration/1024*0.0000077)*180*1.055*1.2+20)/((15800/5100)*0.9*(1/1.1-0.036))/5)*5)
            : legacySeedanceCreditCost(input),
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

assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'image_to_video',
  resolution: '720p',
  duration: 5
}), 95);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'text_to_video',
  resolution: '720p',
  duration: 15
}), 275);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'reference_to_video',
  resolution: '720p',
  duration: 30
}), 550);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'storyboard',
  resolution: '720p',
  duration: 30
}), 550);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5-standard',
  mode: 'image_to_video',
  resolution: '480p',
  duration: 30
}), 495);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5-standard',
  mode: 'reference_to_video',
  resolution: '720p',
  duration: 30
}), 990);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'reference_to_video',
  resolution: '720p',
  duration: 30
}), 550);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'text_to_video',
  resolution: '1080p',
  duration: 30
}), 600);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'text_to_video',
  resolution: '1080p',
  duration: 15
}), 300);
assert.equal(calculateVideoCreditCost({
  model: 'bytedance/seedance-2.5',
  mode: 'reference_to_video',
  resolution: '1080p',
  duration: 30
}), 600);

console.log(`video pricing regression passed: ${cases} Seedance combinations`);
