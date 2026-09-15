'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h3Fal = require('../api/_lib/h3-live-fal.js');

const { buildH3AnchoredSegmentInput } = h3Fal._internals;
const { ANCHORED_SEGMENT_DURATION_SECONDS, H3_REFERENCE_FIDELITY_MARKER, H3_MOTION_MARKER } = h3Fal._test;

test('anchored segment is fixed to a short five-second interval', () => {
  const input = buildH3AnchoredSegmentInput(
    '全速力で前進して斬る',
    'https://example.test/identity.png'
  );

  assert.equal(ANCHORED_SEGMENT_DURATION_SECONDS, 5);
  assert.equal(input.duration, 5);
  assert.equal(input.resolution, '768P');
  assert.equal(input.aspect_ratio, '16:9');
  assert.equal(input.prompt_expansion_mode, 'disabled');
});

test('every segment carries the original identity image', () => {
  const identity = 'https://example.test/identity.png';
  const first = buildH3AnchoredSegmentInput('走る', identity);
  const later = buildH3AnchoredSegmentInput(
    '振り返って斬る',
    identity,
    'https://v3.fal.media/files/example/segment-1.mp4'
  );

  assert.deepEqual(first.reference_image_urls, [identity]);
  assert.deepEqual(later.reference_image_urls, [identity]);
});

test('only the immediately previous segment is used for motion continuity', () => {
  const previous = 'https://v3.fal.media/files/example/segment-1.mp4';
  const first = buildH3AnchoredSegmentInput('走る', 'https://example.test/identity.png');
  const later = buildH3AnchoredSegmentInput('斬る', 'https://example.test/identity.png', previous);

  assert.equal(Object.hasOwn(first, 'reference_video_urls'), false);
  assert.deepEqual(later.reference_video_urls, [previous]);
});

test('original image is authoritative and previous video cannot redefine appearance', () => {
  const input = buildH3AnchoredSegmentInput(
    '斬り返す',
    'https://example.test/identity.png',
    'https://v3.fal.media/files/example/segment-1.mp4'
  );

  assert.match(input.prompt, /Image 1 is the sole authority/i);
  assert.match(input.prompt, /use it only for motion, pose, camera, scene, and temporal continuity/i);
  assert.match(input.prompt, /Never inherit a changed face, hair, outfit/i);
});

test('later segments can reuse the first provider seed', () => {
  const input = buildH3AnchoredSegmentInput(
    '走り続ける',
    'https://example.test/identity.png',
    'https://v3.fal.media/files/example/segment-1.mp4',
    123456789
  );

  assert.equal(input.seed, 123456789);
});

test('invalid seeds are omitted instead of being sent upstream', () => {
  const negative = buildH3AnchoredSegmentInput('走る', 'https://example.test/identity.png', '', -1);
  const fractional = buildH3AnchoredSegmentInput('走る', 'https://example.test/identity.png', '', 1.5);
  const unsafe = buildH3AnchoredSegmentInput('走る', 'https://example.test/identity.png', '', Number.MAX_SAFE_INTEGER + 1);

  assert.equal(Object.hasOwn(negative, 'seed'), false);
  assert.equal(Object.hasOwn(fractional, 'seed'), false);
  assert.equal(Object.hasOwn(unsafe, 'seed'), false);
});

test('anchored prompts include both action timing and identity requirements once', () => {
  const input = buildH3AnchoredSegmentInput(
    '高速で戦う。スローモーションにしない。',
    'https://example.test/identity.png'
  );

  assert.equal((input.prompt.match(/\[Pina Studio H3 motion requirements\]/g) || []).length, 1);
  assert.equal((input.prompt.match(/\[Pina Studio H3 reference fidelity requirements\]/g) || []).length, 1);
  assert.ok(input.prompt.includes(H3_MOTION_MARKER));
  assert.ok(input.prompt.includes(H3_REFERENCE_FIDELITY_MARKER));
  assert.match(input.prompt, /FAST REAL-TIME ACTION/);
  assert.match(input.prompt, /without pose holds, lingering close-ups, floaty movement, or slow motion/i);
});

test('anchored segment keeps provider input surface minimal', () => {
  const input = buildH3AnchoredSegmentInput('走る', 'https://example.test/identity.png');

  assert.deepEqual(Object.keys(input).sort(), [
    'aspect_ratio',
    'duration',
    'enable_safety_checker',
    'prompt',
    'prompt_expansion_mode',
    'reference_image_urls',
    'resolution'
  ]);
  assert.equal(Object.hasOwn(input, 'fps'), false);
  assert.equal(Object.hasOwn(input, 'motion_bucket_id'), false);
  assert.equal(Object.hasOwn(input, 'guidance_scale'), false);
  assert.equal(Object.hasOwn(input, 'controlnet'), false);
});

test('submit rejects an untrusted previous segment before any provider request', async () => {
  const result = await h3Fal.submitAnchoredSegmentJob({
    instruction: '走る',
    identityImageUrl: 'https://example.test/identity.png',
    previousVideoUrl: 'https://attacker.example/video.mp4'
  });

  assert.equal(result.ok, false);
  assert.equal(result.category, 'invalid_input');
  assert.match(result.detail, /untrusted previous segment/);
});
