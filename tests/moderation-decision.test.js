'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModerationDecision } = require('../api/_lib/moderation-decision.js');

function safeAllow(overrides = {}) {
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

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

test('flaggedでなければ二次APIなしで許可', async () => {
  let called = false;
  const result = await resolveModerationDecision('通常の動画', {
    ok: true,
    flagged: false,
    categories: []
  }, {
    apiKey: 'test',
    fetchImpl: async () => {
      called = true;
      throw new Error('should not run');
    }
  });

  assert.equal(result.allow, true);
  assert.equal(called, false);
});

test('violence/graphicを含む場合は二次APIなしで拒否', async () => {
  let called = false;
  const result = await resolveModerationDecision('残虐な動画', {
    ok: true,
    flagged: true,
    categories: ['violence', 'violence/graphic'],
    categoryAppliedInputTypes: {
      violence: ['text'],
      'violence/graphic': ['text']
    }
  }, {
    apiKey: 'test',
    fetchImpl: async () => {
      called = true;
      throw new Error('should not run');
    }
  });

  assert.equal(result.status, 422);
  assert.equal(result.allow, false);
  assert.equal(called, false);
});

test('画像由来のviolenceは二次APIなしで拒否', async () => {
  let called = false;
  const result = await resolveModerationDecision('安全そうな文章', {
    ok: true,
    flagged: true,
    categories: ['violence'],
    categoryAppliedInputTypes: { violence: ['image'] }
  }, {
    apiKey: 'test',
    fetchImpl: async () => {
      called = true;
      throw new Error('should not run');
    }
  });

  assert.equal(result.status, 422);
  assert.equal(result.allow, false);
  assert.equal(called, false);
});


test('安全な参照画像がありviolenceが文章由来だけなら二次判定し許可', async () => {
  let called = false;

  const result = await resolveModerationDecision(
    '劇場版アニメ。成人キャラクターが蚊を電撃ハエ叩きで追う。流血、負傷、殺害なし。',
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] },
      checkedImageCount: 9
    },
    {
      apiKey: 'test',
      fetchImpl: async () => {
        called = true;
        return mockResponse(200, {
          output_text: JSON.stringify(safeAllow())
        });
      }
    }
  );

  assert.equal(called, true);
  assert.equal(result.status, 200);
  assert.equal(result.allow, true);
  assert.equal(result.reason, 'safe_fictional_non_graphic_action');
});

test('文章由来のviolenceだけなら二次判定し、安全なら許可', async () => {
  let called = false;
  const result = await resolveModerationDecision(
    '劇場版アニメ。成人剣士が剣を交え、火花が飛ぶ。流血なし。',
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] }
    },
    {
      apiKey: 'test',
      fetchImpl: async () => {
        called = true;
        return mockResponse(200, {
          output_text: JSON.stringify(safeAllow())
        });
      }
    }
  );

  assert.equal(called, true);
  assert.equal(result.status, 200);
  assert.equal(result.allow, true);
});

test('二次判定API障害は503で停止', async () => {
  const result = await resolveModerationDecision('アニメ戦闘', {
    ok: true,
    flagged: true,
    categories: ['violence'],
    categoryAppliedInputTypes: { violence: ['text'] }
  }, {
    apiKey: 'test',
    fetchImpl: async () => mockResponse(500, {
      error: { type: 'server_error' }
    })
  });

  assert.equal(result.status, 503);
  assert.equal(result.allow, false);
  assert.equal(result.ok, false);
});

test('二次判定API timeoutは503 secondary_classifier_unavailableで停止', async () => {
  const result = await resolveModerationDecision('アニメ戦闘', {
    ok: true,
    flagged: true,
    categories: ['violence'],
    categoryAppliedInputTypes: { violence: ['text'] }
  }, {
    apiKey: 'test',
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
    timeoutMs: 50
  });

  assert.equal(result.status, 503);
  assert.equal(result.allow, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'secondary_classifier_unavailable');
});

test('危険項目が1つでもtrueなら422 classification_blocked', async () => {
  const result = await resolveModerationDecision(
    'アニメ。剣で胸を刺す瞬間を白い閃光で隠す。',
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] }
    },
    {
      apiKey: 'test',
      fetchImpl: async () => mockResponse(200, {
        output_text: JSON.stringify(safeAllow({
          lethal_or_maiming_action: true,
          effects_hide_serious_harm: true,
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

test('adult_or_nonhuman_onlyがfalseなら422 classification_blocked', async () => {
  const result = await resolveModerationDecision(
    '年齢不明の人物同士のアニメ戦闘',
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] }
    },
    {
      apiKey: 'test',
      fetchImpl: async () => mockResponse(200, {
        output_text: JSON.stringify(safeAllow({
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

test('二次判定で拒否された場合は機微情報を含めず判定項目だけをログに記録', async () => {
  const logs = [];
  const prompt = '診断用の秘密のプロンプト文字列';

  const blockedClassification = {
    fictional_setting: true,
    adult_or_nonhuman_only: false,
    real_person_target: false,
    minor_harm: false,
    graphic_injury: false,
    lethal_or_maiming_action: false,
    torture_or_execution: false,
    sexual_violence: false,
    weapon_instruction: false,
    effects_hide_serious_harm: false,
    non_graphic_action: true
  };

  const result = await resolveModerationDecision(
    prompt,
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] },
      checkedImageCount: 3
    },
    {
      apiKey: 'test',
      logger: {
        warn: (...args) => logs.push(args)
      },
      fetchImpl: async () => mockResponse(200, {
        output_text: JSON.stringify(blockedClassification)
      })
    }
  );

  assert.equal(result.status, 422);
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'classification_blocked');

  assert.equal(logs.length, 1);
  assert.equal(
    logs[0][0],
    '[moderation-decision] secondary classifier blocked request'
  );

  assert.deepEqual(logs[0][1], blockedClassification);

  const serializedLog = JSON.stringify(logs);

  assert.equal(serializedLog.includes(prompt), false);
  assert.equal(serializedLog.includes('https://'), false);
  assert.equal(serializedLog.includes('image_url'), false);
  assert.equal(serializedLog.includes('apiKey'), false);
  assert.equal(serializedLog.includes('test'), false);
  assert.equal(serializedLog.includes('checkedImageCount'), false);
});

test('二次判定で許可された場合は診断警告ログを出さない', async () => {
  const logs = [];

  const result = await resolveModerationDecision(
    '成人キャラクターの安全な架空アニメアクション',
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] }
    },
    {
      apiKey: 'test',
      logger: {
        warn: (...args) => logs.push(args)
      },
      fetchImpl: async () => mockResponse(200, {
        output_text: JSON.stringify(safeAllow())
      })
    }
  );

  assert.equal(result.status, 200);
  assert.equal(result.allow, true);
  assert.equal(logs.length, 0);
});

test('二次判定AIが2回とも個別項目のハード矛盾を返す場合は503かつ専用reasonで安全側停止', async () => {
  let callCount = 0;

  const contradictory = () => safeAllow({
    adult_or_nonhuman_only: true,
    minor_harm: true
  });

  const result = await resolveModerationDecision(
    '成人剣士同士のアニメ戦闘',
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] }
    },
    {
      apiKey: 'test',
      fetchImpl: async () => {
        callCount += 1;
        return mockResponse(200, {
          output_text: JSON.stringify(contradictory())
        });
      }
    }
  );

  assert.equal(callCount, 2);
  assert.equal(result.ok, false);
  assert.equal(result.allow, false);
  assert.equal(result.status, 503);
  assert.equal(result.reason, 'secondary_classifier_inconsistent');
  assert.equal(result.errorCode, 'secondary_classifier_inconsistent');
  assert.notEqual(result.status, 422);
});

test('全11項目が安全な分類結果は1回の呼び出しだけで許可される', async () => {
  let callCount = 0;

  const result = await resolveModerationDecision(
    '成人剣士同士のアニメ戦闘',
    {
      ok: true,
      flagged: true,
      categories: ['violence'],
      categoryAppliedInputTypes: { violence: ['text'] }
    },
    {
      apiKey: 'test',
      fetchImpl: async () => {
        callCount += 1;
        return mockResponse(200, {
          output_text: JSON.stringify(safeAllow())
        });
      }
    }
  );

  assert.equal(callCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.allow, true);
  assert.equal(result.status, 200);
  assert.equal(result.reason, 'safe_fictional_non_graphic_action');
});
