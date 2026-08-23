'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const api = require('../api/admin-invite-codes.js')._test;

const VALID_UUID = '123e4567-e89b-42d3-a456-426614174000';
const VALID_HASH = 'a'.repeat(64);

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

test('未認証を401、GETを405で拒否する', async () => {
  const getHandler = api.createHandler({ requireAuth: async () => ({ ok: true }), authorize: async () => ({ ok: true }) });
  const getRes = responseRecorder();
  await getHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 405);

  const unauthHandler = api.createHandler({ requireAuth: async () => ({ ok: false, status: 401, body: { ok: false } }) });
  const unauthRes = responseRecorder();
  await unauthHandler({ method: 'POST', body: {} }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);
});

test('管理者以外を403で拒否する', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin' }, supabase: {} }),
    authorize: async () => ({ ok: false })
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { action: 'list' } }, res);
  assert.equal(res.statusCode, 403);
});

test('管理者メールとprofiles.role=adminの両方を確認する', async () => {
  function authWith(profile, email = 'hinaran53@gmail.com') {
    return {
      user: { id: 'admin-id', email },
      supabase: {
        from(table) {
          assert.equal(table, 'profiles');
          return {
            select() {
              return {
                eq(column, value) {
                  assert.equal(column, 'id');
                  assert.equal(value, 'admin-id');
                  return { maybeSingle: async () => ({ data: profile, error: null }) };
                }
              };
            }
          };
        }
      }
    };
  }

  assert.equal((await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'admin' }))).ok, true);
  assert.equal((await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'hinaran53@gmail.com', role: 'user' }))).ok, false);
  assert.equal((await api.authorizeAdmin(authWith({ id: 'admin-id', email: 'other@example.com', role: 'admin' }, 'other@example.com'))).ok, false);
});

test('発行リクエストIDをUUID検証する', () => {
  const valid = api.validateCreatePayload({
    requestId: VALID_UUID,
    label: 'SNS公開用',
    codeHash: VALID_HASH,
    codeHint: 'PINA-abcd…1234'
  });
  assert.equal(valid.requestId, VALID_UUID);
  assert.equal(api.validateCreatePayload({ requestId: 'not-a-uuid', label: 'a', codeHash: VALID_HASH, codeHint: 'hint-hint' }), null);
});

test('ハッシュを64桁hex検証する', () => {
  const base = { requestId: VALID_UUID, label: 'ラベル', codeHint: 'hint-hint' };
  assert.equal(api.validateCreatePayload({ ...base, codeHash: 'short' }), null);
  assert.equal(api.validateCreatePayload({ ...base, codeHash: 'g'.repeat(64) }), null);
  assert.equal(api.validateCreatePayload({ ...base, codeHash: VALID_HASH }).codeHash, VALID_HASH);
});

test('用途名を2〜80文字に制限する', () => {
  const base = { requestId: VALID_UUID, codeHash: VALID_HASH, codeHint: 'hint-hint' };
  assert.equal(api.validateCreatePayload({ ...base, label: 'a' }), null);
  assert.equal(api.validateCreatePayload({ ...base, label: 'a'.repeat(81) }), null);
  assert.equal(api.validateCreatePayload({ ...base, label: 'ab' }).label, 'ab');
});

test('setActive/setRequiredのペイロードを検査する', () => {
  assert.equal(api.validateActivePayload({ inviteCodeId: VALID_UUID, isActive: true }).isActive, true);
  assert.equal(api.validateActivePayload({ inviteCodeId: 'not-a-uuid', isActive: true }), null);
  assert.equal(api.validateActivePayload({ inviteCodeId: VALID_UUID, isActive: 'true' }), null);

  assert.equal(api.validateRequiredPayload({ inviteRequired: true }).inviteRequired, true);
  assert.equal(api.validateRequiredPayload({ inviteRequired: 'true' }), null);
});

test('発行・停止・必須化以外のactionを拒否する', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } })
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { action: 'deleteEverything' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'INVALID_ACTION');
});

test('list/create/setActive/setRequiredは検査済みの値をRPCへ渡す', async () => {
  let received = null;
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    rpc: async (_db, name, params) => { received = { name, params }; return { ok: true }; }
  });

  const listRes = responseRecorder();
  await handler({ method: 'POST', body: { action: 'list' } }, listRes);
  assert.equal(received.name, 'admin_list_invite_codes');
  assert.equal(received.params.p_admin_user_id, 'admin-id');

  const createRes = responseRecorder();
  await handler({ method: 'POST', body: { action: 'create', requestId: VALID_UUID, label: 'ラベル', codeHash: VALID_HASH, codeHint: 'hint-hint' } }, createRes);
  assert.equal(received.name, 'admin_create_invite_code');
  assert.equal(received.params.p_code_hash, VALID_HASH);
  assert.equal(createRes.statusCode, 200);

  const activeRes = responseRecorder();
  await handler({ method: 'POST', body: { action: 'setActive', inviteCodeId: VALID_UUID, isActive: false } }, activeRes);
  assert.equal(received.name, 'admin_set_invite_code_active');
  assert.equal(received.params.p_is_active, false);

  const requiredRes = responseRecorder();
  await handler({ method: 'POST', body: { action: 'setRequired', inviteRequired: true } }, requiredRes);
  assert.equal(received.name, 'admin_set_invite_required');
  assert.equal(received.params.p_invite_required, true);
});

test('DBエラー詳細を漏らさない', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    rpc: async () => { throw new Error('secret database details'); }
  });
  const res = responseRecorder();
  await handler({ method: 'POST', body: { action: 'list' } }, res);
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.payload), /secret database details/);
});
