'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const baseline = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260720000000_add_signup_credit_campaign.sql'),
  'utf8'
);
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260823120000_require_invite_code_for_signup_credit.sql'),
  'utf8'
);

function extractHandleNewUser(source) {
  const start = source.indexOf('create or replace function public.handle_new_user');
  assert.notEqual(start, -1, 'handle_new_user() definition not found');
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, 'handle_new_user() end marker not found');
  return source.slice(start, end + '$function$;'.length);
}

test('キャンペーン付与条件にinvite_code_uses存在チェックを追加している', () => {
  assert.match(
    migration,
    /signup_campaign\.granted_count\s*<\s*signup_campaign\.max_grants\s*and exists \(\s*select 1\s*from private\.invite_code_uses\s*where user_id = new\.id\s*\)\s*then/
  );
});

test('招待コードなし登録は初期無料クレジットが0のままである(insertデフォルト経路を変更していない)', () => {
  assert.match(migration, /initial_free_credits integer := 0;/);
  assert.match(
    migration,
    /insert into public\.credit_balances \(\s*user_id,\s*free_credits,\s*subscription_credits,\s*purchased_credits\s*\)\s*values \(\s*new\.id,\s*initial_free_credits,\s*0,\s*0\s*\)/
  );
});

test('handle_new_user()の変更点はexists(invite_code_uses)条件の追加1箇所のみである', () => {
  const baseFn = extractHandleNewUser(baseline);
  const newFn = extractHandleNewUser(migration);

  const withoutInviteClause = newFn.replace(
    /\s*and exists \(\s*select 1\s*from private\.invite_code_uses\s*where user_id = new\.id\s*\)/,
    ''
  );

  assert.notEqual(newFn, baseFn, 'invite_code_uses条件が追加されていない');
  assert.equal(
    withoutInviteClause.replace(/\s+/g, ' ').trim(),
    baseFn.replace(/\s+/g, ' ').trim(),
    'exists(invite_code_uses)以外の差分が含まれている'
  );
});

test('年齢確認・プロフィール作成・user_age_verifications記録のロジックは変更していない', () => {
  for (const marker of [
    "message = 'Age verification failed.'",
    'insert into public.profiles (',
    'insert into private.user_age_verifications (',
    "verification_version = excluded.verification_version".replace(/\s+/g, ' ')
  ]) {
    const normalized = migration.replace(/\s+/g, ' ');
    assert.ok(normalized.includes(marker.replace(/\s+/g, ' ')), `missing: ${marker}`);
  }
});

test('招待コードの仕組み自体(テーブル・トリガー・invite_required)は変更していない', () => {
  assert.doesNotMatch(migration, /create table/i);
  assert.doesNotMatch(migration, /drop trigger/i);
  assert.doesNotMatch(migration, /create trigger/i);
  assert.doesNotMatch(migration, /invite_access_settings\s+set/i);
  assert.doesNotMatch(migration, /alter table private\.invite_codes/i);
  assert.doesNotMatch(migration, /alter table private\.invite_code_uses/i);
});

test('既存データ(credit_balances/credit_transactions/signup_credit_grants)への遡及UPDATEを行っていない', () => {
  assert.doesNotMatch(migration, /update public\.credit_balances/i);
  assert.doesNotMatch(migration, /update public\.credit_transactions/i);
  assert.doesNotMatch(migration, /update private\.signup_credit_grants/i);
  // handle_new_user()内の唯一のUPDATEはキャンペーンのgranted_countカウンタ更新のみ
  const updateStatements = migration.match(/^\s*update\s+\S+/gim) || [];
  assert.equal(updateStatements.length, 1);
  assert.match(updateStatements[0], /update private\.signup_credit_campaigns/i);
});

test('マイグレーションはbegin/commitで囲まれている', () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;\s*$/m);
});
