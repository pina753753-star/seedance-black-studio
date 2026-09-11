'use strict';

// H3 Max Live: violence-only secondary review, reusing the existing
// fictional-action safety exception (fictional-action-classifier.js /
// moderation-decision.js) exactly as-is — this file never calls those
// modules' real network paths and never changes their safety rules.
//
// No real OpenAI API, no real fal API, no credits, no DB. fetchImpl and
// resolveDecision are always mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const moderationModule = require('../api/_lib/h3-director-moderation.js');
const { moderateDirectorPrompt, moderateDirectorImageInput } = moderationModule;
const { isViolenceOnly } = moderationModule._test;

const IMAGE_URL = 'https://example.test/quarantine/frame.jpg';

function moderationResponse(categories) {
  const cats = {};
  for (const c of categories) cats[c] = true;
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({
      results: [{ flagged: categories.length > 0, categories: cats }]
    })
  };
}

function flaggedWithoutCategoryResponse() {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ results: [{ flagged: true, categories: {} }] })
  };
}

function httpErrorResponse() {
  return { status: 500, ok: false, text: async () => '{}' };
}

// A fetchImpl that returns pre-scripted responses in call order.
function scriptedFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const r = responses[i] || responses[responses.length - 1];
    i += 1;
    return r;
  };
  fn.calls = calls;
  return fn;
}

function countingResolveDecision(result) {
  let calls = 0;
  const fn = async (prompt, moderation, options) => {
    calls += 1;
    fn.lastModeration = moderation;
    return result;
  };
  fn.callCount = () => calls;
  return fn;
}

// ---------------------------------------------------------------
// text (1-10)
// ---------------------------------------------------------------

test('1. flagなし → allow true / secondary未呼び出し', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorPrompt('普通の散歩シーン', { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
  assert.equal(resolveDecision.callCount(), 0);
});

test('2. violence-only → secondaryが1回呼ばれる', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateDirectorPrompt('二丁拳銃のガンアクション', { fetchImpl, resolveDecision });
  assert.equal(resolveDecision.callCount(), 1);
});

test('3. violence-only + secondary allow → allow true', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true, reason: 'safe_fictional_non_graphic_action' });
  const res = await moderateDirectorPrompt('架空アクション', { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
});

test('4. violence-only + secondary block → allow false', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: false, reason: 'classification_blocked' });
  const res = await moderateDirectorPrompt('架空アクション', { fetchImpl, resolveDecision });
  assert.equal(res.ok, true);
  assert.equal(res.allow, false);
  assert.deepEqual(res.categories, ['violence']);
});

test('5. sexual/minors → 即block / secondary未呼び出し', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['sexual/minors'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorPrompt('禁止コンテンツ', { fetchImpl, resolveDecision });
  assert.equal(res.ok, true);
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('6. violence/graphic → 即block / secondary未呼び出し', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence/graphic'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorPrompt('グラフィック暴力', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('7. violence + sexual → 即block / secondary未呼び出し', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence', 'sexual'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorPrompt('複数カテゴリ', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('8. flagged=trueだがcategoryなし → ok false', async () => {
  const fetchImpl = scriptedFetch([flaggedWithoutCategoryResponse()]);
  const res = await moderateDirectorPrompt('あいまいな判定', { fetchImpl });
  assert.equal(res.ok, false);
});

test('9. Moderation API失敗 → ok false', async () => {
  const fetchImpl = scriptedFetch([httpErrorResponse()]);
  const res = await moderateDirectorPrompt('何かのprompt', { fetchImpl });
  assert.equal(res.ok, false);
});

test('10. secondary unavailable → ok false', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: false, reason: 'secondary_classifier_unavailable' });
  const res = await moderateDirectorPrompt('架空アクション', { fetchImpl, resolveDecision });
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------
// image (11-18)
// ---------------------------------------------------------------

test('11. text clear + image clear → allow true', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse([])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorImageInput({ instruction: '普通のシーン', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
  assert.equal(fetchImpl.calls.length, 2);
});

test('12. text violence-only + secondary allow → image判定へ進む', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence']), moderationResponse([])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateDirectorImageInput({ instruction: 'ガンアクション', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.equal(fetchImpl.calls.length, 2, 'image moderation must have been called');
});

test('13. text violence-only + secondary block → source textでblock、imageは呼ばない', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: false });
  const res = await moderateDirectorImageInput({ instruction: 'アクション', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.equal(res.ok, true);
  assert.equal(res.allow, false);
  assert.equal(res.source, 'text');
  assert.equal(fetchImpl.calls.length, 1, 'image moderation must NOT be called after a text block');
});

test('14. image violence-only → secondaryへimage URLが渡る', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateDirectorImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.equal(resolveDecision.callCount(), 1);
  assert.deepEqual(resolveDecision.lastModeration.flaggedImageUrls, [IMAGE_URL]);
});

test('15. image violence-only + secondary allow → allow true', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
});

test('16. image violence-only + secondary block → source imageでblock', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: false });
  const res = await moderateDirectorImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(res.source, 'image');
});

test('17. image sexual/minors → 即block / secondary未呼び出し', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['sexual/minors'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(res.source, 'image');
  assert.equal(resolveDecision.callCount(), 0);
});

test('18. image violence/graphic → 即block', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence/graphic'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(res.source, 'image');
  assert.equal(resolveDecision.callCount(), 0);
});

// ---------------------------------------------------------------
// 安全境界 (19-22)
// ---------------------------------------------------------------

test('19. violence以外のflagはresolveDecisionへ絶対渡らない(text)', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence', 'harassment'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateDirectorPrompt('複数カテゴリ', { fetchImpl, resolveDecision });
  assert.equal(resolveDecision.callCount(), 0);
});

test('20. secondaryへ渡すのはcategories===["violence"]のケースだけ', () => {
  assert.equal(isViolenceOnly(['violence']), true);
  assert.equal(isViolenceOnly(['violence', 'sexual']), false);
  assert.equal(isViolenceOnly(['sexual/minors']), false);
  assert.equal(isViolenceOnly([]), false);
  assert.equal(isViolenceOnly(['violence', 'violence']), true); // de-duplicated
});

test('21. image secondary時: categoryAppliedInputTypes.violence === ["image"]', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateDirectorImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.deepEqual(resolveDecision.lastModeration.categoryAppliedInputTypes, { violence: ['image'] });
});

test('22. image secondary時: flaggedImageUrls / reviewImageUrls にimage URLが入る', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateDirectorImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.deepEqual(resolveDecision.lastModeration.flaggedImageUrls, [IMAGE_URL]);
  assert.deepEqual(resolveDecision.lastModeration.reviewImageUrls, [IMAGE_URL]);
});

// ---------------------------------------------------------------
// 代表ケース: 今回allowにしたいシーン / 今回もblockするシーン
// ---------------------------------------------------------------

test('代表ケース: 成人架空女性のガンアクション(violence-onlyのみ) + secondary allow → allow true', async () => {
  // NOTE: this exact wording is never sent to a real moderation API in this
  // test — moderation and secondary classification are both mocked.
  const prompt = '成人の架空アニメ女性キャラクター。二丁拳銃を使った一対多数のスタイリッシュなガンアクション。'
    + '流血・傷の接写・ゴアなし。敵をかわしながら非グラフィックに制圧する。';
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({
    ok: true,
    allow: true,
    reason: 'safe_fictional_non_graphic_action'
  });
  const res = await moderateDirectorPrompt(prompt, { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
});

test('代表ブロックケース: sexual/minors:true → block', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['sexual/minors'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorPrompt('禁止コンテンツ', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('代表ブロックケース: violence/graphic:true → block', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence/graphic'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorPrompt('グラフィック暴力', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('代表ブロックケース: violence:true + sexual:true → block', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence', 'sexual'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateDirectorPrompt('複合カテゴリ', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('代表ブロックケース: secondary結果がreal_person_target等でallow=false → block', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({
    ok: true,
    allow: false,
    reason: 'classification_blocked',
    classification: {
      fictional_setting: true, adult_or_nonhuman_only: true, real_person_target: true,
      minor_harm: false, graphic_injury: false, lethal_or_maiming_action: false,
      torture_or_execution: false, sexual_violence: false, weapon_instruction: false,
      effects_hide_serious_harm: false, non_graphic_action: true
    }
  });
  const res = await moderateDirectorPrompt('実在人物を対象にしたシーン', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
});

// ---------------------------------------------------------------
// approve-prompt.js / start-session.js が同じ経路を使うことの静的確認
// ---------------------------------------------------------------

test('approve-prompt.jsはmoderateDirectorPrompt()を使い続けている(別経路を新設していない)', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'h3-director', 'approve-prompt.js'), 'utf8');
  assert.match(src, /require\('\.\.\/_lib\/h3-director-moderation\.js'\)/);
  assert.match(src, /moderateDirectorPrompt\(prompt\)/);
  assert.doesNotMatch(src, /h3-live-image-moderation/);
});

test('start-session.jsはmoderateDirectorPrompt/moderateDirectorImageInputの両方を使い、h3-live-image-moderationをimportしない', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'h3-director', 'start-session.js'), 'utf8');
  assert.match(src, /moderateDirectorPrompt,\s*\n\s*moderateDirectorImageInput\s*\n\}\s*=\s*require\('\.\.\/_lib\/h3-director-moderation\.js'\)/);
  assert.doesNotMatch(src, /h3-live-image-moderation/);
  assert.match(src, /moderateImageInput: moderateDirectorImageInput,/);
});
