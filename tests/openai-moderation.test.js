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
});

test('文章だけのviolenceはtext由来として保持', async (t) => {
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  global.fetch = async () => response({
    results: [{
      flagged: true,
      categories: { violence: true },
      category_scores: { violence: 0.64 },
      category_applied_input_types: { violence: ['text'] }
    }]
  });

  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const result = await moderateContent('成人剣士同士のアニメ戦闘', []);

  assert.equal(result.ok, true);
  assert.deepEqual(result.categories, ['violence']);
  assert.deepEqual(result.categoryAppliedInputTypes.violence, ['text']);
  assert.equal(result.checkedInputCount, 1);
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
