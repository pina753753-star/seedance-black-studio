'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const api = require('../api/admin-credit-grant.js')._test;
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260804000000_add_atomic_admin_credit_grant.sql'), 'utf8');
const page = fs.readFileSync(path.join(root, 'admin-credit-grant.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

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

test('付与額・理由・UUIDを厳格に検査する', () => {
  const valid = api.validateGrantPayload({
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    targetUserId: '123e4567-e89b-42d3-a456-426614174001',
    amount: 100,
    reason: '障害のお詫び'
  });
  assert.equal(valid.amount, 100);
  assert.equal(api.validateGrantPayload({ ...valid, amount: 0 }), null);
  assert.equal(api.validateGrantPayload({ ...valid, amount: 10001 }), null);
  assert.equal(api.validateGrantPayload({ ...valid, reason: 'a' }), null);
  assert.equal(api.validateGrantPayload({ ...valid, requestId: 'not-a-uuid' }), null);
});

test('メール検索にワイルドカードや空検索を許可しない', () => {
  assert.equal(api.validateSearchQuery('ra'), 'ra');
  assert.equal(api.validateSearchQuery('user@example.com'), 'user@example.com');
  assert.equal(api.validateSearchQuery('%'), null);
  assert.equal(api.validateSearchQuery('_'), null);
  assert.equal(api.validateSearchQuery('a'), null);
});

test('認証なし・管理者以外・GETを拒否する', async () => {
  const getHandler = api.createHandler({ requireAuth: async () => ({ ok: true }), authorize: async () => ({ ok: true }) });
  const getRes = responseRecorder();
  await getHandler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 405);

  const unauthHandler = api.createHandler({ requireAuth: async () => ({ ok: false, status: 401, body: { ok: false } }) });
  const unauthRes = responseRecorder();
  await unauthHandler({ method: 'POST', body: {} }, unauthRes);
  assert.equal(unauthRes.statusCode, 401);

  const forbiddenHandler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin' }, supabase: {} }),
    authorize: async () => ({ ok: false })
  });
  const forbiddenRes = responseRecorder();
  await forbiddenHandler({ method: 'POST', body: { action: 'search', query: 'ra' } }, forbiddenRes);
  assert.equal(forbiddenRes.statusCode, 403);
});

test('管理者メールとDB上のadmin権限が両方一致した場合だけ許可する', async () => {
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

test('付与APIは検査済みの同じ受付IDをDB関数へ渡す', async () => {
  let received = null;
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    grant: async (_db, adminId, payload) => { received = { adminId, payload }; return { ok: true, balanceAfter: 200 }; }
  });
  const res = responseRecorder();
  const body = {
    action: 'grant',
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    targetUserId: '123e4567-e89b-42d3-a456-426614174001',
    amount: 100,
    reason: '障害のお詫び'
  };
  await handler({ method: 'POST', body }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(received.adminId, 'admin-id');
  assert.equal(received.payload.requestId, body.requestId);
});

test('DBエラーの詳細を画面へ漏らさず、同じ受付IDでの確認を案内する', async () => {
  const handler = api.createHandler({
    requireAuth: async () => ({ ok: true, user: { id: 'admin-id' }, supabase: {} }),
    authorize: async () => ({ ok: true, admin: { id: 'admin-id' } }),
    grant: async () => { throw new Error('secret database details'); }
  });
  const res = responseRecorder();
  await handler({
    method: 'POST',
    body: {
      action: 'grant',
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      targetUserId: '123e4567-e89b-42d3-a456-426614174001',
      amount: 100,
      reason: '障害のお詫び'
    }
  }, res);
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.stringify(res.payload), /secret database details/);
  assert.match(res.payload.message, /同じ受付ID/);
});

test('DB処理は残高ロック・監査記録・残高更新・履歴を1関数内で行う', () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = ''/i);
  assert.match(migration, /from public\.credit_balances[\s\S]*for update/i);
  assert.match(migration, /insert into private\.admin_credit_grants/i);
  assert.match(migration, /update public\.credit_balances/i);
  assert.match(migration, /insert into public\.credit_transactions/i);
  assert.match(migration, /'admin_manual_grant:' \|\| p_request_id::text/i);
});

test('同じ受付IDは既存結果を返し、内容違いなら停止する', () => {
  assert.match(migration, /on conflict \(request_id\) do nothing/i);
  assert.match(migration, /'duplicate', true/i);
  assert.match(migration, /request id was already used with different details/i);
});

test('DB関数と監査表は一般ユーザーから直接操作できない', () => {
  assert.match(migration, /revoke all on table private\.admin_credit_grants from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all on function public\.grant_admin_free_credits_atomic[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.grant_admin_free_credits_atomic[\s\S]*to service_role/i);
});

test('監査表の外部キー列に検索用インデックスを備える', () => {
  assert.match(migration, /admin_credit_grants_admin_user_id_idx[\s\S]*\(admin_user_id\)/i);
  assert.match(migration, /admin_credit_grants_target_user_id_idx[\s\S]*\(target_user_id\)/i);
});

test('専用画面は二段階確認・二重押下防止・同じ受付IDでの再確認を備える', () => {
  assert.match(page, /内容を確認する/);
  assert.match(page, /この内容で付与する/);
  assert.match(page, /if\(!pending\|\|submitting\)return/);
  assert.match(page, /同じ受付IDで結果を再確認/);
  assert.match(page, /pending=\{action:'grant',requestId:crypto\.randomUUID\(\)/);
  assert.match(page, /uncertain:body\.action==='grant'/);
  assert.doesNotMatch(page, /setInterval|setTimeout/);
});

test('画面は無料付与だけを提供し、リセットや直接DB更新を持たない', () => {
  assert.match(page, /無料クレジット付与/);
  assert.doesNotMatch(page, /resetFree|無料分を0に戻す/);
  assert.doesNotMatch(page, /\.from\(['"]credit_balances['"]\)[\s\S]{0,200}\.update\(/);
  assert.match(admin, /安全な付与画面を開く/);
});
