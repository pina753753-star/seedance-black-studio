'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyFictionalAction,
  detectClassificationContradictions,
  extractOutputText,
  isViolenceOnly,
  shouldRunFictionalActionClassifier,
  validateClassification,
  violenceComesFromTextOnly
} = require('../api/_lib/fictional-action-classifier.js');

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

async function captureClassifierPrompt(userPrompt) {
  let sentPrompt = '';

  const result = await classifyFictionalAction(
    userPrompt,
    {
      apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        const body = JSON.parse(options.body);
        sentPrompt = body.input[1].content[0].text;

        return mockResponse(200, {
          output_text: JSON.stringify(safeAllow())
        });
      }
    }
  );

  assert.equal(result.ok, true);
  return sentPrompt;
}

test('violenceだけの場合のみ対象になる', () => {
  assert.equal(isViolenceOnly(['violence']), true);
  assert.equal(isViolenceOnly(['violence', 'violence/graphic']), false);
  assert.equal(isViolenceOnly(['self-harm']), false);
  assert.equal(isViolenceOnly([]), false);
});

test('violenceが文章由来だけなら二次判定対象', () => {
  assert.equal(violenceComesFromTextOnly({ violence: ['text'] }), true);
  assert.equal(violenceComesFromTextOnly({ violence: ['image'] }), false);
  assert.equal(violenceComesFromTextOnly({ violence: ['text', 'image'] }), false);
  assert.equal(violenceComesFromTextOnly({}), false);
});

test('画像由来のviolenceは例外許可しない', () => {
  const decision = shouldRunFictionalActionClassifier({
    ok: true,
    flagged: true,
    categories: ['violence'],
    categoryAppliedInputTypes: { violence: ['image'] }
  });
  assert.deepEqual(decision, {
    run: false,
    reason: 'violence_not_confirmed_text_only'
  });
});


test('安全な参照画像があってもviolenceが文章由来だけなら二次判定対象', () => {
  const decision = shouldRunFictionalActionClassifier({
    ok: true,
    flagged: true,
    categories: ['violence'],
    categoryAppliedInputTypes: { violence: ['text'] },
    checkedImageCount: 9
  });
  assert.deepEqual(decision, {
    run: true,
    reason: 'text_violence_only'
  });
});

test('参照画像がありviolenceが文章と画像の両方に由来する場合は二次判定しない', () => {
  const decision = shouldRunFictionalActionClassifier({
    ok: true,
    flagged: true,
    categories: ['violence'],
    categoryAppliedInputTypes: { violence: ['text', 'image'] },
    checkedImageCount: 9
  });
  assert.deepEqual(decision, {
    run: false,
    reason: 'violence_not_confirmed_text_only'
  });
});

test('violence以外が混ざれば例外許可しない', () => {
  const decision = shouldRunFictionalActionClassifier({
    ok: true,
    flagged: true,
    categories: ['violence', 'violence/graphic'],
    categoryAppliedInputTypes: { violence: ['text'], 'violence/graphic': ['text'] }
  });
  assert.equal(decision.run, false);
  assert.equal(decision.reason, 'not_violence_only');
});

test('全11項目が安全ならdecisionなしでもコード側で許可', () => {
  const result = validateClassification(safeAllow());
  assert.equal(result.ok, true);
  assert.equal(result.allow, true);
  assert.equal(result.reason, 'safe_fictional_non_graphic_action');
});

for (const [name, overrides] of [
  ['実在人物への攻撃', { real_person_target: true }],
  ['未成年への危害', { minor_harm: true }],
  ['残虐な負傷', { graphic_injury: true }],
  ['殺害または切断', { lethal_or_maiming_action: true }],
  ['拷問または処刑', { torture_or_execution: true }],
  ['性的暴力', { sexual_violence: true }],
  ['武器の殺傷指南', { weapon_instruction: true }],
  ['エフェクトで重大危害を隠す', { effects_hide_serious_harm: true }],
  ['非グラフィックではない', { non_graphic_action: false }],
  ['架空設定ではない', { fictional_setting: false }],
  ['成人または人外に限定されない', { adult_or_nonhuman_only: false }]
]) {
  test(`${name}は拒否`, () => {
    const result = validateClassification(safeAllow(overrides));
    assert.equal(result.ok, true);
    assert.equal(result.allow, false);
    assert.equal(result.reason, 'classification_blocked');
  });
}

test('出力形式が欠けていれば安全側でエラー', () => {
  const value = safeAllow();
  delete value.minor_harm;
  const result = validateClassification(value);
  assert.equal(result.ok, false);
  assert.equal(result.allow, undefined);
});

test('decisionフィールドの混入は許可判定に使わず形式不正として扱う', () => {
  const result = validateClassification({
    ...safeAllow(),
    decision: 'allow'
  });

  assert.equal(result.ok, false);
  assert.notEqual(result.allow, true);
  assert.equal(result.reason, 'unexpected_classification_field');
});

test('output_textを優先して抽出する', () => {
  assert.equal(extractOutputText({ output_text: '{"decision":"allow"}' }), '{"decision":"allow"}');
});

test('output配列からも文章を抽出できる', () => {
  const data = {
    output: [{ content: [{ text: '{"decision":"block"}' }] }]
  };
  assert.equal(extractOutputText(data), '{"decision":"block"}');
});

test('モックAPIで安全な架空戦闘を許可', async () => {
  const result = await classifyFictionalAction(
    '劇場版アニメ。成人剣士同士が剣を交え、火花が飛ぶ。流血や負傷の接写はない。',
    {
      apiKey: 'test-key',
      fetchImpl: async () => mockResponse(200, {
        output_text: JSON.stringify(safeAllow())
      })
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.allow, true);
});

test('モックAPIで刺傷をエフェクトで隠す内容を拒否', async () => {
  const responses = [
    safeAllow({
      lethal_or_maiming_action: true,
      effects_hide_serious_harm: true
    }),
    safeAllow({
      lethal_or_maiming_action: true,
      effects_hide_serious_harm: true,
      non_graphic_action: false
    })
  ];

  let callIndex = 0;

  const result = await classifyFictionalAction(
    'アニメ。剣で胸を刺す瞬間を白い閃光で隠す。',
    {
      apiKey: 'test-key',
      logger: { warn: () => {} },
      fetchImpl: async () => mockResponse(200, {
        output_text: JSON.stringify(responses[callIndex++])
      })
    }
  );

  assert.equal(callIndex, 2);
  assert.equal(result.ok, true);
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'classification_blocked');
});

test('API障害は許可せずエラーにする', async () => {
  const result = await classifyFictionalAction('アニメ戦闘', {
    apiKey: 'test-key',
    fetchImpl: async () => mockResponse(500, {
      error: { type: 'server_error', code: 'temporary_error' }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.allow, false);
  assert.equal(result.errorCode, 'openai_http_error');
});

test('形式不正は許可しない', async () => {
  const result = await classifyFictionalAction('アニメ戦闘', {
    apiKey: 'test-key',
    fetchImpl: async () => mockResponse(200, {
      output_text: '{"decision":"allow"}'
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.allow, false);
  assert.equal(result.errorCode, 'invalid_classification');
});

test('矛盾ルールと非矛盾ルールを検知する', () => {
  assert.deepEqual(
    detectClassificationContradictions(
      safeAllow({ minor_harm: true })
    ),
    ['adult_only_with_minor_harm']
  );

  assert.deepEqual(
    detectClassificationContradictions(
      safeAllow({ graphic_injury: true })
    ),
    ['non_graphic_with_graphic_injury']
  );

  assert.deepEqual(
    detectClassificationContradictions(
      safeAllow({ effects_hide_serious_harm: true })
    ),
    ['non_graphic_with_hidden_serious_harm']
  );

  assert.deepEqual(
    detectClassificationContradictions(
      safeAllow({ real_person_target: true })
    ),
    []
  );
});

test('全11項目が安全なら矛盾なし、再判定なしで即座に許可', async () => {
  let callCount = 0;
  const logs = [];

  assert.deepEqual(detectClassificationContradictions(safeAllow()), []);

  const result = await classifyFictionalAction(
    '成人剣士同士のアニメ戦闘',
    {
      apiKey: 'test-key',
      logger: { warn: (...args) => logs.push(args) },
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
  assert.equal(logs.length, 0);
});

test('ハード矛盾は1回だけ再判定し、整合すれば許可', async (t) => {
  let callCount = 0;
  const receivedPrompts = [];
  const previousWarn = console.warn;
  const logs = [];

  const queued = [
    safeAllow({
      adult_or_nonhuman_only: true,
      minor_harm: true
    }),
    safeAllow()
  ];

  t.after(() => {
    console.warn = previousWarn;
  });

  const result = await classifyFictionalAction(
    '成人剣士同士のアニメ戦闘',
    {
      apiKey: 'test-key',
      logger: { warn: (...args) => logs.push(args) },
      fetchImpl: async (_url, options) => {
        callCount += 1;
        const body = JSON.parse(options.body);
        receivedPrompts.push(body.input[1].content[0].text);
        return mockResponse(200, {
          output_text: JSON.stringify(queued.shift())
        });
      }
    }
  );

  assert.equal(callCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.allow, true);

  assert.equal(receivedPrompts[1].includes('Do not relax any safety rule.'), true);
  assert.equal(
    receivedPrompts[1].includes('Do not assume that an ambiguous human person is an adult.'),
    true
  );
  assert.equal(receivedPrompts[1].includes('adult_only_with_minor_harm'), true);
  assert.equal(
    receivedPrompts[1].includes(
      'Apply the age and non-human classification rules above exactly.'
    ),
    true
  );

  assert.equal(receivedPrompts[1].toLowerCase().includes('use decision'), false);
  assert.equal(receivedPrompts[1].includes('decision "uncertain"'), false);
  assert.equal(receivedPrompts[1].includes('decision "block"'), false);

  assert.equal(logs.length, 1);
  assert.equal(logs[0][1].attempt, 1);
  assert.equal(logs[0][1].finalAction, 'retry');
});

test('ハード矛盾は1回だけ再判定し、整合すれば通常拒否も許可しない', async () => {
  let callCount = 0;

  const queued = [
    safeAllow({
      adult_or_nonhuman_only: true,
      minor_harm: true
    }),
    safeAllow({
      adult_or_nonhuman_only: false,
      minor_harm: false
    })
  ];

  const result = await classifyFictionalAction(
    '成人剣士同士のアニメ戦闘',
    {
      apiKey: 'test-key',
      fetchImpl: async () => {
        callCount += 1;
        return mockResponse(200, {
          output_text: JSON.stringify(queued.shift())
        });
      }
    }
  );

  assert.equal(callCount, 2);
  assert.equal(result.ok, true);
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'classification_blocked');
});

test('2回とも矛盾すれば503相当のerrorCodeで安全側停止', async () => {
  let callCount = 0;
  const logs = [];
  const prompt = '秘密のプロンプト文字列';

  const contradictory = () => safeAllow({
    adult_or_nonhuman_only: true,
    minor_harm: true
  });

  const result = await classifyFictionalAction(prompt, {
    apiKey: 'test-key',
    logger: { warn: (...args) => logs.push(args) },
    fetchImpl: async () => {
      callCount += 1;
      return mockResponse(200, {
        output_text: JSON.stringify(contradictory())
      });
    }
  });

  assert.equal(callCount, 2);
  assert.equal(result.ok, false);
  assert.equal(result.allow, false);
  assert.equal(result.errorCode, 'secondary_classifier_inconsistent');

  assert.equal(logs.length, 2);
  assert.equal(logs[0][1].attempt, 1);
  assert.equal(logs[0][1].finalAction, 'retry');
  assert.equal(logs[1][1].attempt, 2);
  assert.equal(logs[1][1].finalAction, 'fail_closed');

  const serializedLog = JSON.stringify(logs);
  assert.equal(serializedLog.includes(prompt), false);
  assert.equal(serializedLog.includes('test-key'), false);
  assert.equal(serializedLog.includes('https://'), false);
  assert.equal(serializedLog.includes('image_url'), false);
});

test('架空設定と実在人物の組み合わせは矛盾扱いせず通常拒否', async () => {
  let callCount = 0;

  const result = await classifyFictionalAction('架空世界に実在人物が登場', {
    apiKey: 'test-key',
    fetchImpl: async () => {
      callCount += 1;
      return mockResponse(200, {
        output_text: JSON.stringify(safeAllow({
          real_person_target: true
        }))
      });
    }
  });

  assert.equal(callCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.allow, false);
  assert.equal(result.reason, 'classification_blocked');
});

test('二次判定指示文は人間・非人間を問わず明確な未成年設定を優先する', async () => {
  const sentPrompt = await captureClassifierPrompt(
    '架空の精霊キャラクターが杖で戦う'
  );

  assert.equal(
    sentPrompt.includes(
      'Prioritize minor protection for both human and non-human characters.'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'A god, spirit, fairy, robot, or other non-human character explicitly described as a child or minor is not covered by the adult-or-non-human exception.'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'gives an age below adulthood'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'grade or school-age status that clearly establishes minor status'
    ),
    true
  );
});

test('二次判定指示文はアニメ的な外見だけで未成年と断定しない', async () => {
  const sentPrompt = await captureClassifierPrompt(
    '小柄で大きな瞳の精霊が魔法の杖を構える'
  );

  assert.equal(
    sentPrompt.includes(
      'Do not infer that a character is a minor solely from stylized anime features'
    ),
    true
  );

  for (const phrase of [
    'short stature',
    'chibi proportions',
    'a small body',
    'a youthful-looking face',
    'large eyes',
    'a generally cute or youthful design'
  ]) {
    assert.equal(sentPrompt.includes(phrase), true);
  }
});

test('二次判定指示文は明示された非人間を外見だけで未成年扱いしない', async () => {
  const sentPrompt = await captureClassifierPrompt(
    '幼く見えるが人間ではない古代の精霊が剣で戦う'
  );

  assert.equal(
    sentPrompt.includes(
      'adult_or_nonhuman_only may be true even if the visual design appears youthful'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'provided there is no explicit minor or child status'
    ),
    true
  );

  for (const nonHumanType of [
    'god',
    'spirit',
    'fairy',
    'robot',
    'demon'
  ]) {
    assert.equal(sentPrompt.includes(nonHumanType), true);
  }
});

test('二次判定指示文は非人間設定でも性的内容と児童保護を緩めない', async () => {
  const sentPrompt = await captureClassifierPrompt(
    '架空の非人間キャラクターの場面'
  );

  assert.equal(
    sentPrompt.includes(
      'A non-human label never relaxes rules for sexual content, sexual violence, child exploitation, or clearly established minor characters.'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'Explicit child roles or clearly stated child status override a non-human label.'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'If age information conflicts'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'use adult_or_nonhuman_only false.'
    ),
    true
  );
});

test('二次判定指示文はdecisionフィールドを一切要求しない', async () => {
  const sentPrompt = await captureClassifierPrompt(
    '成人剣士同士のアニメ戦闘'
  );

  assert.equal(
    sentPrompt.includes(
      'Return only the eleven boolean fields defined by the schema.'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'Do not return an overall decision, allow, block, or uncertain field.'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'The application computes the final result from the individual boolean fields.'
    ),
    true
  );

  assert.equal(sentPrompt.toLowerCase().includes('use decision'), false);
  assert.equal(sentPrompt.includes('decision "uncertain"'), false);
  assert.equal(sentPrompt.includes('decision "block"'), false);
});

test('二次判定指示文は蚊・害虫のコミカルな対峙を非グラフィックの例として明文化する', async () => {
  const sentPrompt = await captureClassifierPrompt(
    '成人キャラクターが蚊を電撃ハエ叩きで追うアニメ場面'
  );

  assert.equal(
    sentPrompt.includes(
      'comically swats at, chases, or battles a mosquito or ordinary pest'
    ),
    true
  );

  assert.equal(
    sentPrompt.includes('is ordinarily non-graphic action'),
    true
  );

  assert.equal(
    sentPrompt.includes(
      'does not by itself constitute lethal_or_maiming_action'
    ),
    true
  );

  assert.equal(sentPrompt.includes('torture_or_execution'), true);
  assert.equal(sentPrompt.includes('weapon_instruction'), true);

  for (const boundary of [
    'graphic crushing',
    'dismemberment',
    'prolonged suffering',
    'torture',
    'sexual content',
    'harm to a minor',
    'harm to a real person',
    'practical instructions for injuring living beings'
  ]) {
    assert.equal(sentPrompt.includes(boundary), true);
  }
});
