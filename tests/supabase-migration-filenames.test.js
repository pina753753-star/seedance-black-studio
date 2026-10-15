const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Supabase migration versions are unique', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));
  const versions = new Map();

  for (const file of files) {
    const match = /^(\d+)_/.exec(file);
    assert.ok(match, `migration filename must begin with a numeric version: ${file}`);
    const version = match[1];
    assert.equal(
      versions.has(version),
      false,
      `duplicate Supabase migration version ${version}: ${versions.get(version)} and ${file}`
    );
    versions.set(version, file);
  }
});

test('legacy history hardening tolerates clean preview databases', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  for (const file of [
    '20260715084713_revoke_legacy_video_history_access.sql',
    '20260726000001_harden_internal_table_access.sql'
  ]) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    assert.match(sql, /to_regclass\('public\.flowvid_video_history'\) is not null/i);
  }
});

test('legacy generated videos migrations tolerate clean preview databases', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  for (const file of [
    '20260726000000_add_public_sample_flag.sql',
    '20260726000001_harden_internal_table_access.sql'
  ]) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    assert.match(sql, /to_regclass\('public\.generated_videos'\) is not null/i);
  }
});

test('signup credit settings migration accepts only known production and preview states', () => {
  const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
  const sql = fs.readFileSync(
    path.join(migrationsDir, '20260822020000_update_signup_credit_campaign_v1_settings.sql'),
    'utf8'
  );

  assert.match(sql, /max_grants\s*=\s*20[\s\S]*credits_per_user\s*=\s*800[\s\S]*granted_count\s*=\s*19/i);
  assert.match(sql, /max_grants\s*=\s*10[\s\S]*credits_per_user\s*=\s*100[\s\S]*granted_count\s*=\s*0/i);
  assert.match(sql, /max_grants\s*=\s*50[\s\S]*credits_per_user\s*=\s*100/i);
  assert.match(sql, /if\s+v_updated_id\s+is\s+null\s+and\s+not\s+exists/i);
  assert.match(sql, /raise\s+exception/i);
});
