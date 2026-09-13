'use strict';

// H3 Max: violence-only secondary review, aligned with H3 Max Live
// (api/_lib/h3-director-moderation.js). Reuses the existing fictional-action
// safety exception (fictional-action-classifier.js / moderation-decision.js)
// exactly as-is — this file never calls those modules' real network paths
// and never changes their safety rules.
//
// No real OpenAI API, no real fal API, no credits, no DB, no real Storage
// writes/deletes. fetchImpl and resolveDecision are always mocked.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const { moderateH3LiveInstruction } = require('../api/_lib/h3-live-moderation.js');
const {
  moderateH3LiveImageInput,
  moderateH3LiveImageOnly
} = require('../api/_lib/h3-live-image-moderation.js');

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
    fn.lastPrompt = prompt;
    fn.lastModeration = moderation;
    return result;
  };
  fn.callCount = () => calls;
  return fn;
}

// ---------------------------------------------------------------
// text (1-9): api/_lib/h3-live-moderation.js
// ---------------------------------------------------------------

test('1. text clear → allow true', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveInstruction('普通の散歩シーン', { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
  assert.equal(resolveDecision.callCount(), 0);
});

test('2. text violence-only + secondary allow → allow true', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true, reason: 'safe_fictional_non_graphic_action' });
  const res = await moderateH3LiveInstruction('架空アクション', { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
  assert.equal(resolveDecision.callCount(), 1);
});

test('3. text violence-only + secondary block → allow false', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: false, reason: 'classification_blocked' });
  const res = await moderateH3LiveInstruction('架空アクション', { fetchImpl, resolveDecision });
  assert.equal(res.ok, true);
  assert.equal(res.allow, false);
  assert.deepEqual(res.categories, ['violence']);
});

test('4. sexual/minors → secondaryを呼ばずblock', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['sexual/minors'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveInstruction('禁止コンテンツ', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('5. violence/graphic → secondaryを呼ばずblock', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence/graphic'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveInstruction('グラフィック暴力', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('6. violence + sexual → secondaryを呼ばずblock', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence', 'sexual'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveInstruction('複数カテゴリ', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
  assert.equal(resolveDecision.callCount(), 0);
});

test('7. flaggedだがcategoryなし → fail closed (ok:false)', async () => {
  const fetchImpl = scriptedFetch([flaggedWithoutCategoryResponse()]);
  const res = await moderateH3LiveInstruction('あいまいな判定', { fetchImpl });
  assert.equal(res.ok, false);
});

test('8. Moderation APIエラー → fail closed (ok:false)', async () => {
  const fetchImpl = scriptedFetch([httpErrorResponse()]);
  const res = await moderateH3LiveInstruction('何かのprompt', { fetchImpl });
  assert.equal(res.ok, false);
});

test('9. secondary classifier unavailable → fail closed (ok:false)', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: false, reason: 'secondary_classifier_unavailable' });
  const res = await moderateH3LiveInstruction('架空アクション', { fetchImpl, resolveDecision });
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------
// single-image mode (10-14): api/_lib/h3-live-image-moderation.js
// moderateH3LiveImageInput()
// ---------------------------------------------------------------

test('10. single-image: text violence-only + secondary allow → image moderationへ進む', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence']), moderationResponse([])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveImageInput(
    { instruction: 'ガンアクション', imageUrl: IMAGE_URL },
    { fetchImpl, resolveDecision }
  );
  assert.deepEqual(res, { ok: true, allow: true });
  assert.equal(fetchImpl.calls.length, 2, 'image moderation must have been called');
});

test('11. single-image: text block → source:text、画像はblockedにしない/削除しない', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['sexual/minors'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveImageInput(
    { instruction: '禁止コンテンツ', imageUrl: IMAGE_URL },
    { fetchImpl, resolveDecision }
  );
  assert.equal(res.ok, true);
  assert.equal(res.allow, false);
  assert.equal(res.source, 'text');
  assert.equal(fetchImpl.calls.length, 1, 'image moderation must NOT be called after a text block');
  // The caller (api/h3-live/start.js) gates markModeration('blocked') /
  // deleteUploadObject() on source === 'image' only — verified separately
  // via the static source-code check below (test 11b).
});

test('11b. api/h3-live/start.js: source===text ではmarkModeration/deleteUploadObjectを呼ばない (静的確認)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'h3-live', 'start.js'), 'utf8');
  assert.match(
    src,
    /if \(imageModeration\.source === 'image'\) \{\s*\n\s*await markModeration\(db, imageUploadRow\.id, 'blocked'/
  );
});

test('12. single-image: image block → source:image、従来どおり画像blocked+object削除 (静的確認)', () => {
  // markModeration/deleteUploadObject remain gated to run when
  // source === 'image', preserving pre-existing behavior for an image-side
  // block. This is asserted by the same guard checked in 11b — the guard
  // wraps BOTH calls, so an image-source block still runs them.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'h3-live', 'start.js'), 'utf8');
  const guardIdx = src.indexOf("if (imageModeration.source === 'image') {");
  assert.notEqual(guardIdx, -1);
  const guardBlock = src.slice(guardIdx, guardIdx + 400);
  assert.match(guardBlock, /markModeration\(db, imageUploadRow\.id, 'blocked'/);
  assert.match(guardBlock, /deleteUploadObject\(db, imageUploadRow\)/);
});

test('13. single-image: image violence-only + secondary allow → allow true', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveImageInput(
    { instruction: '普通の指示', imageUrl: IMAGE_URL },
    { fetchImpl, resolveDecision }
  );
  assert.deepEqual(res, { ok: true, allow: true });
});

test('14. single-image: image sexual/minors → block', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['sexual/minors'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveImageInput(
    { instruction: '普通の指示', imageUrl: IMAGE_URL },
    { fetchImpl, resolveDecision }
  );
  assert.equal(res.allow, false);
  assert.equal(res.source, 'image');
  assert.equal(resolveDecision.callCount(), 0);
});

// ---------------------------------------------------------------
// image-only violence secondary review context (moderateH3LiveImageInput)
// ---------------------------------------------------------------

test('image violence-only secondary時: categoryAppliedInputTypes.violence === ["image"]', async () => {
  const fetchImpl = scriptedFetch([moderationResponse([]), moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateH3LiveImageInput({ instruction: '普通の指示', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.deepEqual(resolveDecision.lastModeration.categoryAppliedInputTypes, { violence: ['image'] });
  assert.deepEqual(resolveDecision.lastModeration.flaggedImageUrls, [IMAGE_URL]);
  assert.deepEqual(resolveDecision.lastModeration.reviewImageUrls, [IMAGE_URL]);
});

test('text violence-only secondary時: categoryAppliedInputTypes.violence === ["text"]', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence']), moderationResponse([])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateH3LiveImageInput({ instruction: 'ガンアクション', imageUrl: IMAGE_URL }, { fetchImpl, resolveDecision });
  assert.deepEqual(resolveDecision.lastModeration.categoryAppliedInputTypes, { violence: ['text'] });
});

// ---------------------------------------------------------------
// reference/storyboard image-only (15-16): moderateH3LiveImageOnly()
// ---------------------------------------------------------------

test('15. reference/storyboard image-only: violence-only時だけsecondaryへ進み、instruction+image URLがコンテキストに入る', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveImageOnly(
    { imageUrl: IMAGE_URL, instruction: '架空アクションの指示' },
    { fetchImpl, resolveDecision }
  );
  assert.deepEqual(res, { ok: true, allow: true });
  assert.equal(resolveDecision.callCount(), 1);
  // instruction is passed through as the `prompt` arg to resolveDecision,
  // and the image URL context comes from flaggedImageUrls/reviewImageUrls.
  assert.equal(
    resolveDecision.lastPrompt,
    '架空アクションの指示'
  );
  assert.deepEqual(resolveDecision.lastModeration.flaggedImageUrls, [IMAGE_URL]);
  assert.deepEqual(resolveDecision.lastModeration.reviewImageUrls, [IMAGE_URL]);
  assert.deepEqual(resolveDecision.lastModeration.categoryAppliedInputTypes, { violence: ['image'] });
});

test('15b. reference/storyboard image-only: sexual/minors → secondaryを呼ばずblock', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['sexual/minors'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  const res = await moderateH3LiveImageOnly(
    { imageUrl: IMAGE_URL, instruction: '普通の指示' },
    { fetchImpl, resolveDecision }
  );
  assert.equal(res.allow, false);
  assert.equal(res.source, 'image');
  assert.equal(resolveDecision.callCount(), 0);
});

test('16. reference/storyboard: 各画像に対するtext Moderation API呼び出しは増えていない (moderateH3LiveImageOnlyは画像リクエストのみ送信)', async () => {
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({ ok: true, allow: true });
  await moderateH3LiveImageOnly({ imageUrl: IMAGE_URL, instruction: '何らかの指示' }, { fetchImpl, resolveDecision });
  assert.equal(fetchImpl.calls.length, 1, 'moderateH3LiveImageOnly must send exactly one OpenAI Moderation request (image only)');
  assert.equal(fetchImpl.calls[0].body.input[0].type, 'image_url');
});

test('16b. api/h3-live/start.js: reference/storyboardループはmoderateH3LiveImageOnlyを1画像1回だけ呼び、textモデレーションはループ後に1回だけ (静的確認)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'api', 'h3-live', 'start.js'), 'utf8');
  const forIdx = src.indexOf('for (const row of rows) {');
  const afterLoopIdx = src.indexOf('moderateH3LiveInstruction(instruction)');
  assert.notEqual(forIdx, -1);
  assert.notEqual(afterLoopIdx, -1);
  assert.ok(afterLoopIdx > forIdx, 'shared text moderation call must come after the per-image loop');
  const loopBody = src.slice(forIdx, afterLoopIdx);
  const imageOnlyMatches = loopBody.match(/moderateH3LiveImageOnly\(/g) || [];
  assert.equal(imageOnlyMatches.length, 1, 'moderateH3LiveImageOnly must be called exactly once inside the per-image loop body');
  const textMatches = loopBody.match(/moderateH3LiveInstruction\(/g) || [];
  assert.equal(textMatches.length, 0, 'no per-image text moderation call inside the loop');
});

// ---------------------------------------------------------------
// 17. 代表回帰ケース (mock only, never sent to real OpenAI)
// ---------------------------------------------------------------

test('17. 代表回帰ケース: 月夜の薙刀アクション(実写日本庭園背景) — violence-only primary + secondary allow → allow true', async () => {
  // NOTE: this exact wording is never sent to a real moderation API in this
  // test — moderation and secondary classification are both mocked.
  const prompt = '月夜に照らされ薙刀を使って舞っているように戦う。背景は実写の日本庭園。';
  const fetchImpl = scriptedFetch([moderationResponse(['violence'])]);
  const resolveDecision = countingResolveDecision({
    ok: true,
    allow: true,
    reason: 'safe_fictional_non_graphic_action'
  });
  const res = await moderateH3LiveInstruction(prompt, { fetchImpl, resolveDecision });
  assert.deepEqual(res, { ok: true, allow: true });
});

// ---------------------------------------------------------------
// 安全境界の追加確認
// ---------------------------------------------------------------

test('secondaryへ渡すのはcategories===["violence"]のケースだけ (isViolenceOnly)', () => {
  const { isViolenceOnly } = require('../api/_lib/h3-live-moderation.js')._test;
  assert.equal(isViolenceOnly(['violence']), true);
  assert.equal(isViolenceOnly(['violence', 'sexual']), false);
  assert.equal(isViolenceOnly(['sexual/minors']), false);
  assert.equal(isViolenceOnly([]), false);
  assert.equal(isViolenceOnly(['violence', 'violence']), true); // de-duplicated
});

test('secondary結果がreal_person_target等でallow=false → block', async () => {
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
  const res = await moderateH3LiveInstruction('実在人物を対象にしたシーン', { fetchImpl, resolveDecision });
  assert.equal(res.allow, false);
});
