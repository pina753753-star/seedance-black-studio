'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { moderateContent } = require('../api/_lib/openai-moderation.js');
const { resolveModerationDecision } = require('../api/_lib/moderation-decision.js');

function safeClassification(overrides = {}) {
  return {
    fictional_setting: true,
    adult_or_nonhuman_only: true,
    real_person_target: false,
    minor_harm: false,
    graphic_injury: false,
    lethal_or_maiming_action: false,
    torture_or_execution: false,
    sexual_violence: false,
    weapon_instruction: false,
    effects_hide_serious_harm: false,
    non_graphic_action: true,
    ...overrides
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

function moderationResult(overrides = {}) {
  return {
    ok: true,
    flagged: true,
    categories: ['violence'],
    categoryAppliedInputTypes: { violence: ['image'] },
    flaggedImageUrls: ['https://example.com/action.png'],
    flaggedImageIndexes: [0],
    ...overrides
  };
}

test('画像由来violenceの画像URLと番号を保持する', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  global.fetch = async () => response({
    results: [{
      flagged: true,
      categories: { violence: true, 'violence/graphic': false },
      category_scores: { violence: 0.8, 'violence/graphic': 0.01 }
    }]
  });

  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const result = await moderateContent('', [
    'https://example.com/action.png'
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.categories, ['violence']);
  assert.deepEqual(result.flaggedImageUrls, [
    'https://example.com/action.png'
  ]);
  assert.deepEqual(result.flaggedImageIndexes, [0]);
});

test('安全な架空アニメ画像は画像付き二次判定で許可する', async () => {
  let requestBody = null;
  const result = await resolveModerationDecision(
    '架空の成人キャラクターによる一般向けアニメアクション。流血や負傷なし。',
    moderationResult(),
    {
      apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return response({
          output_text: JSON.stringify(safeClassification())
        });
      }
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.allow, true);
  assert.equal(result.status, 200);
  const userContent = requestBody.input[1].content;
  assert.equal(userContent.some((item) => (
    item.type === 'input_image'
    && item.image_url === 'https://example.com/action.png'
  )), true);
});

test('画像由来violenceなのに確認画像URLが無ければ503で安全側停止', async () => {
  let called = false;
  const result = await resolveModerationDecision(
    '架空アニメアクション',
    moderationResult({ flaggedImageUrls: [] }),
    {
      apiKey: 'test-key',
      fetchImpl: async () => {
        called = true;
        throw new Error('should not run');
      }
    }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.allow, false);
  assert.equal(result.status, 503);
  assert.equal(result.reason, 'image_violence_missing_review_inputs');
});

test('violence/graphicは二次判定せず422で拒否する', async () => {
  let called = false;
  const result = await resolveModerationDecision(
    '大量の流血を伴う場面',
    moderationResult({
      categories: ['violence', 'violence/graphic'],
      categoryAppliedInputTypes: {
        violence: ['image'],
        'violence/graphic': ['image']
      }
    }),
    {
      apiKey: 'test-key',
      fetchImpl: async () => {
        called = true;
        throw new Error('should not run');
      }
    }
  );

  assert.equal(called, false);
  assert.equal(result.ok, true);
  assert.equal(result.allow, false);
  assert.equal(result.status, 422);
  assert.equal(result.reason, 'not_violence_only');
});

for (const [name, blockedField] of [
  ['大量流血や傷口', 'graphic_injury'],
  ['未成年への危害', 'minor_harm'],
  ['実在人物を対象にした暴力', 'real_person_target'],
  ['武器の実用的指南', 'weapon_instruction']
]) {
  test(`${name}は二次判定でも422で拒否する`, async () => {
    const classification = safeClassification({
      [blockedField]: true,
      non_graphic_action: blockedField === 'graphic_injury' ? false : true,
      ...(blockedField === 'minor_harm' ? { adult_or_nonhuman_only: false } : {})
    });

    const result = await resolveModerationDecision(
      '安全確認用の架空アニメ場面',
      moderationResult(),
      {
        apiKey: 'test-key',
        fetchImpl: async () => response({
          output_text: JSON.stringify(classification)
        })
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.allow, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'classification_blocked');
  });
}

for (const [name, prompt] of [
  ['成人主人公+年齢未記載の敵兵士', '成人女性の主人公と、年齢の記載がない敵兵士との架空アニメ戦闘シーン'],
  ['成人主人公+ヘルメット姿の敵兵士', '成人女性の主人公と、ヘルメットで顔を隠した敵兵士との架空アニメ戦闘シーン'],
  ['成人主人公+覆面の背景人物', '成人女性の主人公と、覆面をした背景の群衆との架空アニメシーン']
]) {
  test(`${name}は脇役の年齢未記載を理由に拒否しない`, async () => {
    const result = await resolveModerationDecision(
      prompt,
      moderationResult(),
      {
        apiKey: 'test-key',
        fetchImpl: async () => response({
          output_text: JSON.stringify(safeClassification())
        })
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.allow, true);
    assert.equal(result.status, 200);
  });
}

for (const [name, prompt] of [
  ['成人主人公+「16歳の敵兵士」', '成人女性の主人公と、16歳の敵兵士との架空アニメ戦闘シーン'],
  ['成人主人公+「少年兵」', '成人女性の主人公と、少年兵との架空アニメ戦闘シーン']
]) {
  test(`${name}は未成年指標により拒否する`, async () => {
    const result = await resolveModerationDecision(
      prompt,
      moderationResult(),
      {
        apiKey: 'test-key',
        fetchImpl: async () => response({
          output_text: JSON.stringify(safeClassification({
            adult_or_nonhuman_only: false
          }))
        })
      }
    );

    assert.equal(result.ok, true);
    assert.equal(result.allow, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'classification_blocked');
  });
}

test('実写・実在人物らしき画像には脇役ルールを適用せず従来通り拒否する', async () => {
  const result = await resolveModerationDecision(
    '実在の人物らしき画像に基づく戦闘シーン',
    moderationResult(),
    {
      apiKey: 'test-key',
      fetchImpl: async () => response({
        output_text: JSON.stringify(safeClassification({
          fictional_setting: false,
          real_person_target: true
        }))
      })
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.allow, false);
  assert.equal(result.status, 422);
  assert.equal(result.reason, 'classification_blocked');
});

test('年齢不詳の兵士でも大量流血・切断を含む場合は年齢判定に関係なく拒否する', async () => {
  const result = await resolveModerationDecision(
    '年齢不詳の敵兵士が大量出血し四肢が切断される架空アニメ戦闘シーン',
    moderationResult(),
    {
      apiKey: 'test-key',
      fetchImpl: async () => response({
        output_text: JSON.stringify(safeClassification({
          graphic_injury: true,
          lethal_or_maiming_action: true,
          non_graphic_action: false
        }))
      })
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.allow, false);
  assert.equal(result.status, 422);
  assert.equal(result.reason, 'classification_blocked');
});
