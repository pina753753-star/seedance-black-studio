'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { moderateContent } = require('../api/_lib/openai-moderation.js');

function response(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

test('複数バッチのcategory scoreは最大値、input typeは和集合で集約', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  const queued = [
    response({
      results: [{
        flagged: true,
        categories: { violence: true, 'violence/graphic': false },
        category_scores: { violence: 0.71, 'violence/graphic': 0.02 },
        category_applied_input_types: { violence: ['text'] }
      }]
    }),
    response({
      results: [{
        flagged: false,
        categories: { violence: false, 'violence/graphic': false },
        category_scores: { violence: 0.12, 'violence/graphic': 0.01 },
        category_applied_input_types: {}
      }]
    }),
    response({
      results: [{
        flagged: true,
        categories: { violence: true, 'violence/graphic': false },
        category_scores: { violence: 0.83, 'violence/graphic': 0.01 },
        category_applied_input_types: { violence: ['image'] }
      }]
    })
  ];

  global.fetch = async () => queued.shift();

  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const result = await moderateContent(
    'アニメ戦闘',
    ['https://example.com/1.png', 'https://example.com/2.png'],
    { maxConcurrentRequests: 1 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ['violence']);
  assert.equal(result.categoryScores.violence, 0.83);
  assert.deepEqual(
    [...result.categoryAppliedInputTypes.violence].sort(),
    ['image', 'text']
  );
  assert.equal(result.checkedInputCount, 3);
  assert.equal(result.checkedImageCount, 2);
});

test('文章と参照画像を別リクエストで判定し安全な画像を文章由来violenceへ混ぜない', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  const receivedInputs = [];
  const queued = [
    response({
      results: [{
        flagged: true,
        categories: { violence: true, 'violence/graphic': false },
        category_scores: { violence: 0.68, 'violence/graphic': 0.01 },
        category_applied_input_types: { violence: ['text'] }
      }]
    }),
    response({
      results: [{
        flagged: false,
        categories: { violence: false, 'violence/graphic': false },
        category_scores: { violence: 0.04, 'violence/graphic': 0.01 },
        category_applied_input_types: {}
      }]
    }),
    response({
      results: [{
        flagged: false,
        categories: { violence: false, 'violence/graphic': false },
        category_scores: { violence: 0.03, 'violence/graphic': 0.01 },
        category_applied_input_types: {}
      }]
    })
  ];

  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    receivedInputs.push(body.input);
    return queued.shift();
  };

  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const result = await moderateContent(
    '成人キャラクターが蚊を電撃ハエ叩きで追うアニメ場面',
    [
      'https://example.com/character.png',
      'https://example.com/room.png'
    ],
    { maxConcurrentRequests: 1 }
  );

  assert.equal(receivedInputs.length, 3);

  assert.deepEqual(receivedInputs[0], [
    {
      type: 'text',
      text: '成人キャラクターが蚊を電撃ハエ叩きで追うアニメ場面'
    }
  ]);

  assert.deepEqual(receivedInputs[1], [
    {
      type: 'image_url',
      image_url: { url: 'https://example.com/character.png' }
    }
  ]);

  assert.deepEqual(receivedInputs[2], [
    {
      type: 'image_url',
      image_url: { url: 'https://example.com/room.png' }
    }
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ['violence']);
  assert.deepEqual(result.categoryAppliedInputTypes.violence, ['text']);
  assert.equal(result.checkedInputCount, 3);
  assert.equal(result.checkedImageCount, 2);
});

test('文章だけのviolenceは入力元情報が欠落してもtext由来として保持', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  global.fetch = async () => response({
    results: [{
      flagged: true,
      categories: { violence: true },
      category_scores: { violence: 0.64 }
    }]
  });

  t.after(() => {
    global.fetch = previousFetch;

    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  });

  const result = await moderateContent(
    '成人剣士同士のアニメ戦闘',
    []
  );

  assert.equal(result.ok, true);
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ['violence']);
  assert.deepEqual(
    result.categoryAppliedInputTypes.violence,
    ['text']
  );
  assert.equal(result.checkedInputCount, 1);
  assert.equal(result.checkedImageCount, 0);
});

test('画像だけのviolenceは入力元情報が欠落してもimage由来として保持', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  global.fetch = async () => response({
    results: [{
      flagged: true,
      categories: {
        violence: true,
        'violence/graphic': false
      },
      category_scores: {
        violence: 0.72,
        'violence/graphic': 0.01
      }
    }]
  });

  t.after(() => {
    global.fetch = previousFetch;

    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  });

  const result = await moderateContent(
    '',
    ['https://example.com/violent-image.png']
  );

  assert.equal(result.ok, true);
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ['violence']);
  assert.deepEqual(
    result.categoryAppliedInputTypes.violence,
    ['image']
  );
  assert.equal(result.checkedInputCount, 1);
  assert.equal(result.checkedImageCount, 1);
});

test('OpenAIの入力元情報が送信内容と食い違っても実際の送信種別を優先', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  global.fetch = async () => response({
    results: [{
      flagged: true,
      categories: { violence: true },
      category_scores: { violence: 0.61 },
      category_applied_input_types: {
        violence: ['image']
      }
    }]
  });

  t.after(() => {
    global.fetch = previousFetch;

    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  });

  const result = await moderateContent(
    '成人キャラクター同士の架空アニメ戦闘',
    []
  );

  assert.equal(result.ok, true);
  assert.equal(result.flagged, true);
  assert.deepEqual(result.categories, ['violence']);
  assert.deepEqual(
    result.categoryAppliedInputTypes.violence,
    ['text']
  );
  assert.equal(result.checkedInputCount, 1);
  assert.equal(result.checkedImageCount, 0);
});

test('Moderation応答不正時は安全側のエラー', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  global.fetch = async () => response({ results: [] });

  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const result = await moderateContent('test', []);

  assert.equal(result.ok, false);
  assert.equal(result.flagged, false);
  assert.equal(result.errorCode, 'invalid_response');
});
