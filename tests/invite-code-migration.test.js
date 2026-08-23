'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260823000000_add_invite_code_mvp.sql'),
  'utf8'
);

test('invite_required初期値はfalseである', () => {
  assert.match(migration, /invite_required boolean not null default false/i);
  assert.match(migration, /values \(\s*1,\s*false\s*\)/i);
});

test('既存のhandle_new_user\\(\\)を置換していない', () => {
  assert.doesNotMatch(migration, /create or replace function public\.handle_new_user/i);
});

test('既存のhook_enforce_minimum_signup_age\\(\\)を置換していない', () => {
  assert.doesNotMatch(migration, /create or replace function.*hook_enforce_minimum_signup_age/i);
});

test('トリガー名はon_auth_00_invite_codeで、on_auth_user_createdより先に実行される命名になっている', () => {
  assert.match(migration, /create trigger on_auth_00_invite_code/i);
  assert.match(migration, /after insert on auth\.users/i);
});

test('招待コードのロックはFOR UPDATEで行う', () => {
  assert.match(migration, /from private\.invite_codes\s*where code_hash = v_hash\s*for update/i);
});

test('invite_code_uses.user_idはUNIQUE制約を持つ', () => {
  assert.match(migration, /constraint invite_code_uses_user_unique\s*unique \(user_id\)/i);
});

test('invite_codes.code_hashはUNIQUE制約を持つ', () => {
  assert.match(migration, /constraint invite_codes_code_hash_unique\s*unique \(code_hash\)/i);
});

test('平文コード用カラムが存在しない', () => {
  assert.doesNotMatch(migration, /\bplain_code\b/i);
  assert.doesNotMatch(migration, /\bcode_plain\b/i);
  assert.doesNotMatch(migration, /\braw_code\b/i);
});

test('一般ユーザーからテーブル・RPCを直接実行できない', () => {
  assert.match(migration, /revoke all\s*on table private\.invite_access_settings\s*from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all\s*on table private\.invite_codes\s*from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all\s*on table private\.invite_code_uses\s*from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all\s*on function public\.validate_invite_code_hash\(text\)\s*from public, anon, authenticated, service_role/i);
});

test('管理RPCはservice_role限定で実行できる', () => {
  for (const fn of [
    'admin_create_invite_code(\n  uuid, uuid, text, text, text\n)',
    'admin_list_invite_codes(\n  uuid\n)',
    'admin_set_invite_code_active(\n  uuid, uuid, boolean\n)',
    'admin_set_invite_required(\n  uuid, boolean\n)'
  ]) {
    assert.ok(migration.includes(`grant execute on function public.${fn} to service_role;`), `missing service_role grant for ${fn}`);
  }
});

test('必須化ON時には利用可能なコードが最低1件必要', () => {
  assert.match(migration, /if p_invite_required then/i);
  assert.match(migration, /if v_enabled_code_count < 1 then/i);
  assert.match(migration, /raise exception 'at least one usable invite code is required'/i);
});

test('招待コード必須化OFF中でも不正コードは拒否される', () => {
  assert.match(migration, /if v_hash !~ '\^\[0-9a-f\]\{64\}\$' then/i);
  assert.match(migration, /Invite code is invalid or unavailable\./i);
});
