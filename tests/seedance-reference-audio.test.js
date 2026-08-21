'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REFERENCE_AUDIO_BUCKET,
  normalizeReferenceAudioPaths,
  isMp3Header,
  createReferenceAudioSignedUrls
} = require('../api/_lib/reference-audio.js');

test('参照音源パスはログインユーザー配下のMP3を1件だけ許可する', () => {
  assert.deepEqual(
    normalizeReferenceAudioPaths(['users/user-1/track.mp3'], 'user-1'),
    { ok: true, paths: ['users/user-1/track.mp3'] }
  );
  assert.equal(normalizeReferenceAudioPaths(['users/user-2/track.mp3'], 'user-1').ok, false);
  assert.equal(normalizeReferenceAudioPaths(['users/user-1/../user-2/track.mp3'], 'user-1').ok, false);
  assert.equal(normalizeReferenceAudioPaths(['users/user-1/track.wav'], 'user-1').ok, false);
  assert.equal(normalizeReferenceAudioPaths(['users/user-1/a.mp3', 'users/user-1/b.mp3'], 'user-1').ok, false);
});

test('MP3のID3またはMPEGフレームヘッダーだけを許可する', () => {
  assert.equal(isMp3Header(Uint8Array.from([0x49, 0x44, 0x33])), true);
  assert.equal(isMp3Header(Uint8Array.from([0xff, 0xfb, 0x90])), true);
  assert.equal(isMp3Header(Uint8Array.from([0x52, 0x49, 0x46])), false);
});

test('生成時だけ非公開音源の期限付きURLを作成する', async () => {
  const calls = [];
  const mp3 = new Blob([Uint8Array.from([0x49, 0x44, 0x33, 0x04])], { type: 'audio/mpeg' });
  const db = { storage: { from(bucket) { calls.push(['bucket', bucket]); return { async download(path) { calls.push(['download', path]); return { data: mp3, error: null }; }, async createSignedUrl(path, ttl) { calls.push(['sign', path, ttl]); return { data: { signedUrl: 'https://signed.example/audio' }, error: null }; } }; } } };
  const result = await createReferenceAudioSignedUrls(db, ['users/user-1/track.mp3']);
  assert.deepEqual(result, { ok: true, urls: ['https://signed.example/audio'] });
  assert.equal(calls[0][1], REFERENCE_AUDIO_BUCKET);
  assert.equal(calls[1][0], 'download');
  assert.equal(calls[2][1], 'users/user-1/track.mp3');
  assert.equal(calls[2][2], 3600);
});

test('UIと開始APIは音源をWaveSpeed専用項目で受け渡す', () => {
  const root = path.join(__dirname, '..');
  const ui = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
  const start = fs.readFileSync(path.join(root, 'api/_lib/seedance-start.js'), 'utf8');
  assert.match(ui, /id="audioFile"[^>]+accept="audio\/mpeg,\.mp3"/);
  assert.match(ui, /動画と同じ長さに切り出したMP3がおすすめです/);
  assert.match(ui, /「何秒から」と指定すると、使用位置がずれる場合があります/);
  assert.match(ui, /name="audioSyncMode" value="singing" checked>歌唱に合わせる/);
  assert.match(ui, /name="audioSyncMode" value="rhythm">リズム・雰囲気に合わせる/);
  assert.match(ui, /aria-label="歌唱に合わせるの説明"/);
  assert.match(ui, /aria-label="リズム・雰囲気に合わせるの説明"/);
  assert.match(ui, /\.audioSyncInfoButton\{width:30px;min-height:30px;padding:0;border:0;background:transparent/);
  assert.match(ui, /歌ってるキャラクターが映る動画向けです。曲の歌詞・メロディ・歌声をできるだけそのまま保ち/);
  assert.match(ui, /歌ってる人が映らない、ダンスやアクション動画向けです。歌詞の再現よりも、曲のビート・強拍・展開に合わせて/);
  assert.match(ui, /function toggleAudioSyncInfo\(kind,button\)/);
  assert.match(ui, /body\.reference_audio_paths=\[audioAsset\.path\]/);
  assert.match(ui, /body\.reference_audio_sync_mode=getReferenceAudioSyncMode\(\)/);
  assert.match(ui, /const currentAudioId=typeof audioAsset==='undefined'\?'':\(audioAsset\?\.id\|\|'\'\)/);
  assert.match(ui, /currentAudioId===\(submission\.audioId\|\|'\'\)/);
  assert.match(start, /mode === 'image_to_video'/);
  assert.match(start, /payload\.reference_audios/);
  assert.match(start, /createReferenceAudioSignedUrls/);
  assert.match(start, /body\.reference_audio_sync_mode === 'rhythm' \? 'rhythm' : 'singing'/);
  assert.match(start, /referenceAudioSyncMode/);
});
