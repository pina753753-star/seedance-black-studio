'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../api/invite-code/validate.js')._test;

function responseRecorder() {
  return {
    headers: {},
    statusCode: 0,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
}

test('GETを405で拒否する', async () => {
  const handler = api.createHandler({});
  const res = responseRecorder();
  await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 405);
});

test('64桁hex以外のハッシュを拒否する', () => {
  assert.equal(api.normalizeHash('not-a-hash'), null);
  assert.equal(api.normalizeHash('a'.repeat(63)), null);
  assert.equal(api.normalizeHash('g'.repeat(64)), null);
  assert.equal(api.normalizeHash('A'.repeat(64)), 'a'.repeat(64));
});

test('空ハッシュはDB関数へnullとして渡せる', async () => {
  assert.equal(api.normalizeHash(''), '');
  assert.equal(api.normalizeHash(undefined), '');

  let received;
  const handler = api.createHandler({
    serviceClient: () => ({}),
    validateHash: async (_db, codeHash) => { received = codeHash; return { valid: true, required: false }; }
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { codeHash: '' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(received, '');
  assert.equal(res.payload.valid, true);
});

test('不正な形式のハッシュはDBへ問い合わせずrequired扱いで返す', async () => {
  const handler = api.createHandler({
    serviceClient: () => ({}),
    validateHash: async () => { throw new Error('should not be called'); }
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { codeHash: 'invalid' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.valid, false);
  assert.equal(res.payload.required, true);
});

test('DBエラー詳細をレスポンスへ漏らさない', async () => {
  const handler = api.createHandler({
    serviceClient: () => ({}),
    validateHash: async () => { throw new Error('secret database details'); }
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { codeHash: 'a'.repeat(64) } }, res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(res.payload), /secret database details/);
});

test('サービス接続が無い場合は503を返す', async () => {
  const handler = api.createHandler({ serviceClient: () => null });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { codeHash: 'a'.repeat(64) } }, res);
  assert.equal(res.statusCode, 503);
});

test('平文コードを要求・保存していない', () => {
  const source = api.createHandler.toString() + api.validateHash.toString();
  assert.doesNotMatch(source, /plainCode|plain_code|inviteCode\b/);
});

test('Cache-Control: no-storeを設定する', async () => {
  const handler = api.createHandler({
    serviceClient: () => ({}),
    validateHash: async () => ({ valid: true, required: false })
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { codeHash: 'a'.repeat(64) } }, res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});
