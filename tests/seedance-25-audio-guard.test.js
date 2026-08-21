'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildProviderPrompt, SEEDANCE_25_AUDIO_GUARD_MARKER } = require('../api/_lib/video-provider-prompt');

test('Seedance 2.5の音声生成だけに内部の著作権回避指示を追加する', () => {
  const original = 'らんが「ここは通さない」と日本語で話す。';
  const providerPrompt = buildProviderPrompt({
    model: 'bytedance/seedance-2.5',
    prompt: original,
    generateAudio: true
  });

  assert.ok(providerPrompt.startsWith(original));
  assert.ok(providerPrompt.includes(SEEDANCE_25_AUDIO_GUARD_MARKER));
  assert.match(providerPrompt, /Do not add background music, songs, melodies, humming/);
  assert.match(providerPrompt, /Preserve the user's exact dialogue text/);
});

test('既存Seedanceと音声なしではユーザーのプロンプトを変更しない', () => {
  const original = '既存モデルのプロンプト';
  assert.equal(buildProviderPrompt({
    model: 'bytedance/seedance-2.0',
    prompt: original,
    generateAudio: true
  }), original);
  assert.equal(buildProviderPrompt({
    model: 'bytedance/seedance-2.5',
    prompt: original,
    generateAudio: false
  }), original);
});

test('参照音源の既定値は歌唱同期として@audio1の維持と同期を指示する', () => {
  const providerPrompt = buildProviderPrompt({
    model: 'bytedance/seedance-2.5',
    prompt: '実写ライブで歌う。',
    generateAudio: true,
    hasReferenceAudio: true
  });
  assert.match(providerPrompt, /Use @audio1 as the supplied soundtrack/);
  assert.match(providerPrompt, /Synchronize the performer's lip movements/);
  assert.doesNotMatch(providerPrompt, /Do not add background music/);
});

test('リズム同期では動き・照明・カメラ・場面転換を@audio1に合わせる', () => {
  const providerPrompt = buildProviderPrompt({
    model: 'bytedance/seedance-2.5',
    prompt: '音楽に合わせてダンスする。',
    generateAudio: true,
    hasReferenceAudio: true,
    referenceAudioSyncMode: 'rhythm'
  });
  assert.match(providerPrompt, /Use @audio1 as the master timing, rhythm, and mood reference/);
  assert.match(providerPrompt, /lighting changes, camera movements, and scene transitions/);
  assert.match(providerPrompt, /The visual pacing must follow @audio1 continuously/);
  assert.match(providerPrompt, /If a singer is visible, synchronize lip movements/);
  assert.match(providerPrompt, /Do not compose or add a different song/);
  assert.doesNotMatch(providerPrompt, /Use @audio1 as the supplied soundtrack and vocal performance/);
});

test('不明な同期用途は従来互換の歌唱同期へフォールバックする', () => {
  const providerPrompt = buildProviderPrompt({
    model: 'bytedance/seedance-2.5',
    prompt: '実写ライブで歌う。',
    generateAudio: true,
    hasReferenceAudio: true,
    referenceAudioSyncMode: 'unknown'
  });
  assert.match(providerPrompt, /Use @audio1 as the supplied soundtrack and vocal performance/);
});

test('内部指示を二重に追加しない', () => {
  const once = buildProviderPrompt({
    model: 'bytedance/seedance-2.5',
    prompt: 'test',
    generateAudio: true
  });
  const twice = buildProviderPrompt({
    model: 'bytedance/seedance-2.5',
    prompt: once,
    generateAudio: true
  });
  assert.equal(twice, once);
});

test('履歴保存には元プロンプト、OpenRouter payloadだけに内部指示を使う', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api/_lib/seedance-start.js'), 'utf8');
  const taskIndex = source.indexOf('createTask(db, { userId: user.id, mode, model, prompt,');
  const providerIndex = source.indexOf('const providerPrompt = buildProviderPrompt');
  const payloadIndex = source.indexOf('prompt: providerPrompt', providerIndex);

  assert.ok(taskIndex >= 0 && taskIndex < providerIndex);
  assert.ok(providerIndex >= 0 && payloadIndex > providerIndex);
});
