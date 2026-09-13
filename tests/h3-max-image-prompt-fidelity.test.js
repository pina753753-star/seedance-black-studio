'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h3Fal = require('../api/_lib/h3-live-fal.js');

const {
  buildH3MaxImagePrompt,
  buildH3MaxImageInput,
  H3_IMAGE_FIDELITY_MARKER
} = h3Fal._test || {};

test('H3 image prompt keeps the original user prompt verbatim at the beginning', () => {
  const original =
    '月夜に照らされ薙刀を使って舞っているように戦う。背景は実写の日本庭園。';

  const built = buildH3MaxImagePrompt(original);

  assert.ok(built.startsWith(original));
  assert.ok(built.includes(H3_IMAGE_FIDELITY_MARKER));
});

test('H3 image prompt explicitly preserves subject identity and appearance', () => {
  const built = buildH3MaxImagePrompt('走りながら振り返る');

  assert.match(built, /Preserve the same character or subject identity/i);
  assert.match(built, /face/i);
  assert.match(built, /hairstyle/i);
  assert.match(built, /outfit/i);
  assert.match(built, /body proportions/i);
  assert.match(built, /color palette/i);
  assert.match(built, /Do not redesign/i);
  assert.match(built, /different person or character/i);
});

test('H3 image prompt explicitly prioritizes requested action and motion speed', () => {
  const built = buildH3MaxImagePrompt('激しく走って戦う');

  assert.match(built, /Follow the user's requested action/i);
  assert.match(built, /motion speed and intensity/i);
  assert.match(built, /do not reinterpret it as slow motion/i);
  assert.match(built, /unless the user explicitly asks for slow/i);
});

test('H3 image prompt does not duplicate the system guidance', () => {
  const once = buildH3MaxImagePrompt('普通に歩く');
  const twice = buildH3MaxImagePrompt(once);

  assert.equal(twice, once);

  const markerMatches =
    twice.match(/\[Pina Studio H3 image fidelity requirements\]/g) || [];

  assert.equal(markerMatches.length, 1);
});

test('H3 image input keeps existing provider parameters unchanged', () => {
  const imageUrl = 'https://example.test/frame.png';

  const input = buildH3MaxImageInput(
    '素早く薙刀を振る',
    imageUrl
  );

  assert.equal(input.image_url, imageUrl);
  assert.equal(input.duration, 15);
  assert.equal(input.resolution, '768P');
  assert.equal(input.enable_safety_checker, true);
  assert.equal(input.prompt_expansion_mode, 'balanced');
  assert.ok(input.prompt.startsWith('素早く薙刀を振る'));
  assert.ok(input.prompt.includes(H3_IMAGE_FIDELITY_MARKER));
});

test('empty prompt stays empty rather than becoming system-guidance-only', () => {
  assert.equal(buildH3MaxImagePrompt(''), '');
  assert.equal(buildH3MaxImagePrompt('   '), '');
});

test('H3 image guidance preserves identity without weakening explicit scene instructions', () => {
  const original =
    '月夜に照らされ薙刀を使って舞っているように戦う。背景は実写の日本庭園。';

  const built = buildH3MaxImagePrompt(original);

  assert.ok(built.startsWith(original));
  assert.match(built, /fully applying any scene, lighting, camera, environment, or background changes explicitly requested by the user/i);
  assert.match(built, /Do not alter the subject's identity or appearance merely to satisfy those scene changes/i);
});

test('H3 text/reference/storyboard builders are not modified by the image fidelity helper', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'api', '_lib', 'h3-live-fal.js'),
    'utf8'
  );

  assert.match(
    src,
    /function buildH3MaxInput\(instruction\)[\s\S]*?prompt:\s*String\(instruction \|\| ''\)\.trim\(\)/
  );

  assert.match(
    src,
    /function buildH3MaxReferenceInput\(instruction, imageUrls\)[\s\S]*?prompt:\s*String\(instruction \|\| ''\)\.trim\(\)/
  );

  assert.match(
    src,
    /function buildH3MaxStoryboardInput\(instruction, imageUrls\)/
  );
});
