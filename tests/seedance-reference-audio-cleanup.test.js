'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('音源削除APIは認証ユーザー自身のパスだけをStorage APIで削除する', () => {
  const source = read('api/reference-audio-delete.js');
  assert.match(source, /requireConfirmedAuth\(req\)/);
  assert.match(source, /normalizeReferenceAudioPaths\(body\.path, auth\.user\.id\)/);
  assert.match(source, /\.from\(REFERENCE_AUDIO_BUCKET\)[\s\S]*?\.remove\(\[path\]\)/);
  assert.match(source, /REFERENCE_AUDIO_REGISTRY_TABLE/);
});

test('添付解除と差し替えは即時削除APIを呼び、生成受付後は即削除しない', () => {
  const source = read('generate-prod.html');
  assert.match(source, /fetch\('\/api\/reference-audio-delete'/);
  assert.match(source, /if\(path\)deleteReferenceAudioPath\(path\)/);
  assert.match(source, /previousAudio\?\.path&&previousAudio\.path!==urlData\.path\)deleteReferenceAudioPath\(previousAudio\.path\)/);
  assert.match(source, /generationRequestInFlight=true;syncReferenceAudioUi\(\)/);
  assert.match(source, /audioAsset\?\.status==='uploading'\|\|generationRequestInFlight/);
  assert.match(source, /finally\{generationRequestInFlight=false;syncReferenceAudioUi\(\)\}/);
  const clearStart = source.indexOf('function clearAcceptedGenerationInputs');
  const clearEnd = source.indexOf('\n}', clearStart);
  assert.ok(clearStart >= 0 && clearEnd > clearStart);
  assert.doesNotMatch(source.slice(clearStart, clearEnd), /deleteReferenceAudioPath/);
});

test('アップロード記録はクライアントから遮断し、期限検索用indexを持つ', () => {
  const migration = read('supabase/migrations/20260821020000_track_seedance_reference_audio_cleanup.sql');
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete[\s\S]*to service_role/i);
  assert.match(migration, /expires_at_idx/i);
  assert.match(migration, /check \(path like \('users\/' \|\| user_id::text \|\| '\/%\.mp3'\)\)/i);
});

test('アップロードは24時間の削除期限を登録し、生成前に保持期限を延長する', () => {
  const upload = read('api/reference-audio-upload-url.js');
  const start = read('api/_lib/seedance-start.js');
  assert.match(upload, /REFERENCE_AUDIO_RETENTION_MS/);
  assert.match(upload, /\.from\(REFERENCE_AUDIO_REGISTRY_TABLE\)[\s\S]*?\.insert\(/);
  assert.match(start, /\.from\(REFERENCE_AUDIO_REGISTRY_TABLE\)[\s\S]*?\.update\(\{ expires_at: expiresAt \}\)/);
  assert.match(start, /reference_audio_retention_failed/);
});

test('時間切れ音源のCronはStorage API削除成功後だけ記録を消す', () => {
  const cleanup = read('api/reference-audio-cleanup.js');
  const vercel = JSON.parse(read('vercel.json'));
  const removeIndex = cleanup.indexOf('.remove(paths)');
  const registryDeleteIndex = cleanup.indexOf('.delete()', removeIndex);
  assert.ok(removeIndex >= 0 && registryDeleteIndex > removeIndex);
  assert.match(cleanup, /CRON_SECRET/);
  assert.ok(vercel.crons.some(cron => cron.path === '/api/reference-audio-cleanup'));
});
