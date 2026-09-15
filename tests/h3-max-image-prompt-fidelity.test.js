'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const h3Fal = require('../api/_lib/h3-live-fal.js');

const { buildH3MaxInput, buildH3MaxReferenceInput, buildH3MaxStoryboardInput } =
  h3Fal._internals || {};

const {
  buildH3MaxImagePrompt,
  buildH3MaxReferencePrompt,
  buildH3MaxImageInput,
  H3_IMAGE_FIDELITY_MARKER,
  H3_REFERENCE_FIDELITY_MARKER,
  buildH3MaxMotionPrompt,
  H3_MOTION_MARKER,
  requestsSlowMotion
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

  assert.match(built, /supplied image is the exact first frame/i);
  assert.match(built, /face/i);
  assert.match(built, /hair/i);
  assert.match(built, /outfit/i);
  assert.match(built, /body proportions/i);
  assert.match(built, /throughout the video/i);
  assert.match(built, /Never morph, age, or change the subject/i);
});

test('H3 image prompt explicitly prioritizes requested action and motion speed', () => {
  const built = buildH3MaxImagePrompt('激しく走って戦う');

  assert.match(built, /FAST REAL-TIME ACTION/i);
  assert.match(built, /Start moving in the first frame/i);
  assert.match(built, /clear body displacement/i);
  assert.match(built, /without pose holds, lingering close-ups, floaty movement, or slow motion/i);
});

test('H3 image prompt does not duplicate the system guidance', () => {
  const once = buildH3MaxImagePrompt('普通に歩く');
  const twice = buildH3MaxImagePrompt(once);

  assert.equal(twice, once);

  const markerMatches =
    twice.match(/\[Pina Studio H3 image fidelity requirements\]/g) || [];

  assert.equal(markerMatches.length, 1);
});

test('H3 image input uses the official exact-first-frame payload', () => {
  const imageUrl = 'https://example.test/frame.png';

  const input = buildH3MaxImageInput(
    '素早く薙刀を振る',
    imageUrl
  );

  assert.equal(input.image_url, imageUrl);
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'reference_image_urls'), false);
  assert.equal(input.duration, 15);
  assert.equal(input.resolution, '768P');
  assert.equal(Object.prototype.hasOwnProperty.call(input, 'aspect_ratio'), false);
  assert.equal(input.enable_safety_checker, true);
  assert.equal(input.prompt_expansion_mode, 'disabled');
  assert.ok(input.prompt.startsWith('素早く薙刀を振る'));
  assert.ok(input.prompt.includes(H3_IMAGE_FIDELITY_MARKER));
});

test('empty prompt stays empty rather than becoming system-guidance-only', () => {
  assert.equal(buildH3MaxImagePrompt(''), '');
  assert.equal(buildH3MaxImagePrompt('   '), '');
});

test('H3 image guidance preserves the complete original scene instruction', () => {
  const original =
    '月夜に照らされ薙刀を使って舞っているように戦う。背景は実写の日本庭園。';

  const built = buildH3MaxImagePrompt(original);

  assert.ok(built.startsWith(original));
  assert.equal(built.slice(0, original.length), original);
  assert.match(built, /supplied image is the exact first frame/i);
});

test('11. H3 image prompt uses concise identity guidance without repeated requirements', () => {
  const built = buildH3MaxImagePrompt('普通に歩く');

  assert.match(built, /The supplied image is the exact first frame\./);
  assert.match(built, /Keep the same recognizable face, hair, eyes, outfit, accessories, body proportions, and colors throughout the video\./);
  assert.match(built, /Infer unseen details conservatively\./);
  assert.ok(built.length < 700, 'system guidance should not overwhelm a short user action');
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
  assert.equal((input.prompt.match(/\[Pina Studio H3 reference fidelity requirements\]/g) || []).length, 1);
  assert.deepEqual(input.reference_image_urls, urls);
});

test('3b. reference prompt preserves identity guidance without changing the user instruction', () => {
  const original = '画像1の女性が全速力で走る';
  const built = buildH3MaxReferencePrompt(original);

  assert.ok(built.startsWith(original));
  assert.ok(built.includes(H3_REFERENCE_FIDELITY_MARKER));
  assert.match(built, /Treat each Image N as an identity and design reference/i);
  assert.match(built, /Do not merge distinct referenced subjects/i);
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
  assert.match(built, /FAST REAL-TIME ACTION/i);
  assert.match(built, /immediate acceleration/i);
  assert.match(built, /immediate follow-through/i);
  assert.match(built, /rapid consecutive actions/i);
});

test('7. slow action: original prompt preserved, explicit slow motion is not overridden', () => {
  const original = 'ゆっくり歩く';
  const built = buildH3MaxMotionPrompt(original);

  assert.ok(built.startsWith(original));
  assert.match(built, /Follow the user's requested timing exactly\./);
  assert.doesNotMatch(built, /FAST REAL-TIME ACTION/);
});

test('8. mixed speed: original prompt preserved, limited slow-motion window is respected', () => {
  const original =
    '2〜5秒は急加速。5〜8秒だけスローモーション。その後すぐ高速戦闘へ戻る';
  const built = buildH3MaxMotionPrompt(original);

  assert.ok(built.startsWith(original));
  assert.match(built, /Keep slow motion only within the explicitly requested moment/i);
  assert.match(built, /return immediately to the requested normal or fast speed/i);
});

test('8b. a no-slow-motion instruction selects fast guidance rather than slow guidance', () => {
  const original = '高速で戦う。スローモーションにしない。';
  const built = buildH3MaxMotionPrompt(original);

  assert.equal(requestsSlowMotion(original), false);
  assert.match(built, /FAST REAL-TIME ACTION/i);
  assert.doesNotMatch(built, /Keep slow motion only/);
});

test('8c. fast text prompts disable provider rewriting', () => {
  const input = buildH3MaxInput('高速で戦う。スローモーションにしない。');
  assert.equal(input.prompt_expansion_mode, 'disabled');
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
  assert.equal(refInput.aspect_ratio, '16:9');
  assert.equal(refInput.enable_safety_checker, true);
  assert.equal(refInput.prompt_expansion_mode, 'disabled');

  const storyboardInput = buildH3MaxStoryboardInput('通常のシーン', ['https://example.test/a.png']);
  assert.equal(storyboardInput.duration, 15);
  assert.equal(storyboardInput.resolution, '768P');
  assert.equal(storyboardInput.aspect_ratio, '16:9');
  assert.equal(storyboardInput.enable_safety_checker, true);
  assert.equal(storyboardInput.prompt_expansion_mode, 'disabled');

  const imageInput = buildH3MaxImageInput('通常のシーン', 'https://example.test/frame.png');
  assert.equal(imageInput.duration, 15);
  assert.equal(imageInput.resolution, '768P');
  assert.equal(Object.prototype.hasOwnProperty.call(imageInput, 'aspect_ratio'), false);
  assert.equal(imageInput.enable_safety_checker, true);
  assert.equal(imageInput.prompt_expansion_mode, 'disabled');
});

test('13. single-image mode uses the exact-first-frame image-to-video model', () => {
  const fs = require('fs');
  const path = require('path');

  const falSrc = fs.readFileSync(
    path.join(__dirname, '..', 'api', '_lib', 'h3-live-fal.js'),
    'utf8'
  );
  const imageSubmit = falSrc.slice(
    falSrc.indexOf('async function submitImageJob'),
    falSrc.indexOf('async function submitReferenceJob')
  );

  assert.match(
    imageSubmit,
    /async function submitImageJob[\s\S]*?modelId:\s*FAL_MODEL_ID_IMAGE/
  );

  assert.doesNotMatch(
    imageSubmit,
    /async function submitImageJob[\s\S]*?modelId:\s*FAL_MODEL_ID_REFERENCE/
  );
});

test('14. reference and exact-first-frame modes keep distinct official payload shapes', () => {
  const urls = ['https://example.test/a.png', 'https://example.test/b.png', 'https://example.test/c.png'];
  const refInput = buildH3MaxReferenceInput('通常のシーン', urls);
  assert.deepEqual(refInput.reference_image_urls, urls);

  const imageInput = buildH3MaxImageInput('通常のシーン', 'https://example.test/frame.png');
  assert.equal(imageInput.image_url, 'https://example.test/frame.png');
  assert.equal(Object.prototype.hasOwnProperty.call(imageInput, 'reference_image_urls'), false);
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
    /const providerModelId = mode === 'text'[\s\S]*?\?\s*FAL_MODEL_ID_TEXT[\s\S]*?mode === 'image'[\s\S]*?\?\s*FAL_MODEL_ID_IMAGE[\s\S]*?:\s*FAL_MODEL_ID_REFERENCE/
  );

  assert.match(
    startSrc,
    /models:\s*\{\s*text:\s*FAL_MODEL_ID_TEXT,\s*image:\s*FAL_MODEL_ID_IMAGE,/
  );

  assert.doesNotMatch(
    startSrc,
    /models:\s*\{\s*text:\s*FAL_MODEL_ID_TEXT,\s*image:\s*FAL_MODEL_ID_REFERENCE,/
  );
});

test('H3 image mode requires the image-to-video model configuration', () => {
  const fs = require('fs');
  const path = require('path');

  const configSrc = fs.readFileSync(
    path.join(__dirname, '..', 'api', '_lib', 'h3-live-config.js'),
    'utf8'
  );

  assert.match(
    configSrc,
    /mode === 'image' && !FAL_MODEL_ID_IMAGE/
  );
});

test('H3_MOTION_MARKER differs from H3_IMAGE_FIDELITY_MARKER (no collision)', () => {
  assert.notEqual(H3_MOTION_MARKER, H3_IMAGE_FIDELITY_MARKER);
});

test('provider diagnostics keep only bounded prompt, safe integer seed, and finite numeric timings', () => {
  const { extractProviderDiagnostics } = h3Fal._internals;
  const diagnostics = extractProviderDiagnostics({
    expanded_prompt: 'x'.repeat(50010),
    seed: 123456,
    timings: { inference: 12.5, queue: '3.2', bad: 'not-a-number' }
  });

  assert.equal(diagnostics.expandedPrompt.length, 50000);
  assert.equal(diagnostics.seed, 123456);
  assert.deepEqual(diagnostics.timings, { inference: 12.5, queue: 3.2 });
  assert.deepEqual(extractProviderDiagnostics({ seed: 'unsafe', timings: [] }), {
    expandedPrompt: null,
    seed: null,
    timings: null
  });
});
