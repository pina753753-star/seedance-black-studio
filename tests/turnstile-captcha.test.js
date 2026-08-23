'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..');
const buildScript = path.join(repoRoot, 'scripts', 'build-auth-config.js');
const authConfigSource = fs.readFileSync(path.join(repoRoot, 'auth-config.js'), 'utf8');
const loginSource = fs.readFileSync(path.join(repoRoot, 'login.html'), 'utf8');
const adminLoginSource = fs.readFileSync(path.join(repoRoot, 'admin-login.html'), 'utf8');
const siteKey = '0x4AAAAAAEZDEdtqd4qjQlYG';

function runBuild(extraEnv = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flowvid-auth-config-'));
  const publicDir = path.join(tempRoot, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'auth-config.js'), authConfigSource);
  const result = spawnSync(process.execPath, [buildScript], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      TURNSTILE_SITE_KEY: '',
      SUPABASE_URL: '',
      SUPABASE_PUBLISHABLE_KEY: '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
      SUPABASE_ANON_KEY: '',
      ...extraEnv
    }
  });
  const output = fs.readFileSync(path.join(publicDir, 'auth-config.js'), 'utf8');
  fs.rmSync(tempRoot, { recursive: true, force: true });
  return { ...result, output };
}

test('TURNSTILE_SITE_KEYだけ設定した場合も既存Supabase設定を保ってsite keyを注入する', () => {
  const result = runBuild({ TURNSTILE_SITE_KEY: siteKey });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, new RegExp(`turnstileSiteKey: ${JSON.stringify(siteKey)}`));
  assert.match(result.output, /supabaseUrl: "https:\/\//);
});

test('Supabase設定を書き換えるビルドでもTurnstile site keyを保持する', () => {
  const result = runBuild({
    TURNSTILE_SITE_KEY: siteKey,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /supabaseUrl: "https:\/\/example\.supabase\.co"/);
  assert.match(result.output, new RegExp(`turnstileSiteKey: ${JSON.stringify(siteKey)}`));
});

test('TURNSTILE_SITE_KEY未設定時は空文字のままにする', () => {
  const result = runBuild();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /turnstileSiteKey:\s*""/);
});

test('不正なTURNSTILE_SITE_KEYは値をログへ出さずビルドを停止する', () => {
  const invalidKey = 'invalid secret-shaped value';
  const result = runBuild({ TURNSTILE_SITE_KEY: invalidKey });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TURNSTILE_SITE_KEY has an invalid format/);
  assert.doesNotMatch(result.stderr, new RegExp(invalidKey));
});

test('通常ログインはTurnstileを明示描画しwidget IDでリセットする', () => {
  assert.match(loginSource, /api\.js\?onload=flowvidTurnstileReady&amp;render=explicit/);
  assert.match(loginSource, /window\.turnstile\.render\(captchaWidget,/);
  assert.match(loginSource, /window\.turnstile\.reset\(captchaWidgetId\)/);
  assert.doesNotMatch(loginSource, /className='cf-turnstile'/);
});

test('管理者ログインはCAPTCHA完了を要求しtokenをSupabaseへ渡して送信後にリセットする', () => {
  assert.match(adminLoginSource, /id="captchaField" hidden/);
  assert.match(adminLoginSource, /api\.js\?onload=flowvidTurnstileReady&amp;render=explicit/);
  assert.match(adminLoginSource, /if\(turnstileSiteKey&&!captchaToken\)/);
  assert.match(adminLoginSource, /const options=turnstileSiteKey\?\{captchaToken\}:undefined/);
  assert.match(adminLoginSource, /signInWithPassword\(options/);
  assert.match(adminLoginSource, /finally\{[\s\S]*?resetCaptcha\(\);[\s\S]*?\}/);
  assert.match(adminLoginSource, /window\.turnstile\.reset\(captchaWidgetId\)/);
});

test('Secret key用の環境変数や値をクライアント実装へ追加していない', () => {
  const changedSources = [
    fs.readFileSync(buildScript, 'utf8'),
    loginSource,
    adminLoginSource
  ].join('\n');
  assert.doesNotMatch(changedSources, /TURNSTILE_SECRET_KEY|turnstileSecretKey/);
});
