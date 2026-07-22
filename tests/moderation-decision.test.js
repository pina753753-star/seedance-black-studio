'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveModerationDecision } = require('../api/_lib/moderation-decision.js');

function safeAllow() {
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
    decision: 'allow'
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
