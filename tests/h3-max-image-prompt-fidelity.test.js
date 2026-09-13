'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h3Fal = require('../api/_lib/h3-live-fal.js');

const { buildH3MaxInput, buildH3MaxReferenceInput, buildH3MaxStoryboardInput } =
  h3Fal._internals || {};

const {
  buildH3MaxImagePrompt,
  buildH3MaxImageInput,
  H3_IMAGE_FIDELITY_MARKER,
  buildH3MaxMotionPrompt,
  H3_MOTION_MARKER
} = h3Fal._test || {};

// ---------------------------------------------------------------
// Image identity guidance (unchanged behavior, kept from prior task)
// ---------------------------------------------------------------

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
  assert.match(built, /Image 1 is the authoritative visual reference for the main subject/i);
  assert.match(built, /Keep the main subject consistent with Image 1 throughout the entire video/i);
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

  assert.deepEqual(input.reference_image_urls, [imageUrl]);
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'image_url'), false);
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

test('11. H3 image prompt contains the 3 added subject-identity-reference sentences', () => {
  const built = buildH3MaxImagePrompt('普通に歩く');

  assert.match(built, /Treat Image 1 as a subject-identity reference, not merely as a style reference\./);
  assert.match(
    built,
    /The generated main subject must remain recognizably the same individual or character as Image 1 across all shots and camera angles\./
  );
  assert.match(
    built,
    /When Image 1 does not show the full body or every angle, infer unseen details conservatively while preserving all visible identity-defining features and costume design\./
  );
});

// ---------------------------------------------------------------
// H3 Max common motion guidance (new, applies to text/image/reference/storyboard)
// ---------------------------------------------------------------

test('1. text prompt: original prompt is fully preserved at the beginning', () => {
  const original = '素早く敵へ踏み込んで攻撃する';
  const input = buildH3MaxInput(original);

  assert.ok(input.prompt.startsWith(original));
});

test('2. text prompt: H3_MOTION_MARKER appears exactly once', () => {
  const input = buildH3MaxInput('普通に歩く');
  const matches = input.prompt.match(
    /\[Pina Studio H3 motion requirements\]/g
  ) || [];

  assert.equal(matches.length, 1);
});

test('3. reference: H3_MOTION_MARKER appears exactly once, reference_image_urls unchanged', () => {
  const urls = ['https://example.test/a.png', 'https://example.test/b.png'];
  const input = buildH3MaxReferenceInput('ゆっくり歩く', urls);

  const matches = input.prompt.match(
    /\[Pina Studio H3 motion requirements\]/g
  ) || [];

  assert.equal(matches.length, 1);
  assert.deepEqual(input.reference_image_urls, urls);
});

test('4. storyboard: H3_MOTION_MARKER appears exactly once, STORYBOARD_ORDER_HINT is preserved', () => {
  const urls = ['https://example.test/a.png', 'https://example.test/b.png'];
  const input = buildH3MaxStoryboardInput('走って戦う', urls);

  const matches = input.prompt.match(
    /\[Pina Studio H3 motion requirements\]/g
  ) || [];

  assert.equal(matches.length, 1);
  assert.match(input.prompt, /添付画像はImage 1から順に時間的な流れの参考として使用してください。/);
});

test('5. image: H3_MOTION_MARKER and H3_IMAGE_FIDELITY_MARKER each appear exactly once', () => {
  const input = buildH3MaxImageInput('走って戦う', 'https://example.test/frame.png');

  const motionMatches = input.prompt.match(
    /\[Pina Studio H3 motion requirements\]/g
  ) || [];
  const identityMatches = input.prompt.match(
    /\[Pina Studio H3 image fidelity requirements\]/g
  ) || [];

  assert.equal(motionMatches.length, 1);
  assert.equal(identityMatches.length, 1);
});

test('6. fast action: generated prompt keeps the original and includes fast-motion guidance', () => {
  const original = '急加速して高速で戦う';
  const built = buildH3MaxMotionPrompt(original);

  assert.ok(built.startsWith(original));
  assert.match(built, /clearly fast real-time speed/i);
  assert.match(built, /sharp acceleration/i);
  assert.match(built, /immediate follow-through/i);
  assert.match(built, /Do not smooth fast action/i);
});

test('7. slow action: original prompt preserved, explicit slow motion is not overridden', () => {
  const original = 'ゆっくり歩く';
  const built = buildH3MaxMotionPrompt(original);

  assert.ok(built.startsWith(original));
  assert.match(built, /Do not accelerate movement that the user explicitly asks to be slow\./);
  assert.doesNotMatch(built, /slow motion禁止/);
});

test('8. mixed speed: original prompt preserved, limited slow-motion window is respected', () => {
  const original =
    '2〜5秒は急加速。5〜8秒だけスローモーション。その後すぐ高速戦闘へ戻る';
  const built = buildH3MaxMotionPrompt(original);

  assert.ok(built.startsWith(original));
  assert.match(built, /limit slow motion to that moment/i);
  assert.match(built, /immediately return to the requested normal or fast speed afterward/i);
});

test('9. empty prompt stays empty for the motion helper', () => {
  assert.equal(buildH3MaxMotionPrompt(''), '');
  assert.equal(buildH3MaxMotionPrompt('   '), '');
});

test('10. idempotency: applying the motion helper twice yields an identical result with one marker', () => {
  const once = buildH3MaxMotionPrompt('普通に歩く');
  const twice = buildH3MaxMotionPrompt(once);

  assert.equal(twice, once);

  const matches = twice.match(/\[Pina Studio H3 motion requirements\]/g) || [];
  assert.equal(matches.length, 1);
});

test('12. provider parameters unchanged: text/reference/storyboard/image', () => {
  const textInput = buildH3MaxInput('通常のシーン');
  assert.equal(textInput.duration, 15);
  assert.equal(textInput.resolution, '768P');
  assert.equal(textInput.enable_safety_checker, true);
  assert.equal(textInput.prompt_expansion_mode, 'balanced');
  assert.equal(textInput.aspect_ratio, '16:9');

  const refInput = buildH3MaxReferenceInput('通常のシーン', ['https://example.test/a.png']);
  assert.equal(refInput.duration, 15);
  assert.equal(refInput.resolution, '768P');
  assert.equal(refInput.enable_safety_checker, true);
  assert.equal(refInput.prompt_expansion_mode, 'balanced');

  const storyboardInput = buildH3MaxStoryboardInput('通常のシーン', ['https://example.test/a.png']);
  assert.equal(storyboardInput.duration, 15);
  assert.equal(storyboardInput.resolution, '768P');
  assert.equal(storyboardInput.enable_safety_checker, true);
  assert.equal(storyboardInput.prompt_expansion_mode, 'balanced');

  const imageInput = buildH3MaxImageInput('通常のシーン', 'https://example.test/frame.png');
  assert.equal(imageInput.duration, 15);
  assert.equal(imageInput.resolution, '768P');
  assert.equal(imageInput.enable_safety_checker, true);
  assert.equal(imageInput.prompt_expansion_mode, 'balanced');
});

test('13. single-image routing unchanged: uses the reference-to-video model', () => {
  const fs = require('fs');
  const path = require('path');

  const falSrc = fs.readFileSync(
    path.join(__dirname, '..', 'api', '_lib', 'h3-live-fal.js'),
    'utf8'
  );

  assert.match(
    falSrc,
    /async function submitImageJob[\s\S]*?modelId:\s*FAL_MODEL_ID_REFERENCE/
  );

  assert.doesNotMatch(
    falSrc,
    /async function submitImageJob[\s\S]*?modelId:\s*FAL_MODEL_ID_IMAGE/
  );
});

test('14. reference_image_urls structure unchanged for reference and image modes', () => {
  const urls = ['https://example.test/a.png', 'https://example.test/b.png', 'https://example.test/c.png'];
  const refInput = buildH3MaxReferenceInput('通常のシーン', urls);
  assert.deepEqual(refInput.reference_image_urls, urls);

  const imageInput = buildH3MaxImageInput('通常のシーン', 'https://example.test/frame.png');
  assert.deepEqual(imageInput.reference_image_urls, ['https://example.test/frame.png']);
});

// ---------------------------------------------------------------
// Provider routing / config regression (unchanged from the prior task)
// ---------------------------------------------------------------

test('H3 provider model metadata matches actual routing', () => {
  const fs = require('fs');
  const path = require('path');

  const startSrc = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'h3-live', 'start.js'),
    'utf8'
  );

  assert.match(
    startSrc,
    /const providerModelId = mode === 'text'[\s\S]*?\?\s*FAL_MODEL_ID_TEXT[\s\S]*?:\s*FAL_MODEL_ID_REFERENCE/
  );

  assert.match(
    startSrc,
    /models:\s*\{\s*text:\s*FAL_MODEL_ID_TEXT,\s*image:\s*FAL_MODEL_ID_REFERENCE,/
  );

  assert.doesNotMatch(
    startSrc,
    /models:\s*\{\s*text:\s*FAL_MODEL_ID_TEXT,\s*image:\s*FAL_MODEL_ID_IMAGE,/
  );
});

test('H3 image mode requires the reference model configuration', () => {
  const fs = require('fs');
  const path = require('path');

  const configSrc = fs.readFileSync(
    path.join(__dirname, '..', 'api', '_lib', 'h3-live-config.js'),
    'utf8'
  );

  assert.match(
    configSrc,
    /mode === 'image'[\s\S]*?FAL_MODEL_ID_REFERENCE/
  );
});

test('H3_MOTION_MARKER differs from H3_IMAGE_FIDELITY_MARKER (no collision)', () => {
  assert.notEqual(H3_MOTION_MARKER, H3_IMAGE_FIDELITY_MARKER);
});
