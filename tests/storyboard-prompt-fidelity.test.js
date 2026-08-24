'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'api', 'storyboard-prompt.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
const storyboard = require(path.join(root, 'api', 'storyboard-prompt.js'));

test('解析指示は題材・画風・コマ数を固定せず全コマと状態を追跡する', () => {
  const instruction = storyboard.buildStoryboardAnalysisInstruction(15, '16:9');

  assert.match(instruction, /題材・ジャンル・画風・コマ数を限定せず/);
  assert.match(instruction, /全コマを1コマずつ解析/);
  assert.match(instruction, /安定したID/);
  assert.match(instruction, /保持者の変更/);
  assert.match(instruction, /最終コマ/);
  assert.match(instruction, /創作しない/);
  assert.match(instruction, /uncertain_details/);
  assert.doesNotMatch(instruction, /黒豹|スズメ|おやつ袋/);
});

test('完成文指示は検出コマ数と同数の時間区間と詳細な共通見出しを要求する', () => {
  const instruction = storyboard.buildStoryboardPromptInstruction(15, '16:9', 9);

  assert.match(instruction, /必ず9個の時間区間/);
  assert.match(instruction, /1コマを1区間/);
  assert.match(instruction, /最初を0秒、最後を15秒/);
  assert.match(instruction, /【この動画の目的】/);
  assert.match(instruction, /【登場人物・登場物の固定】/);
  assert.match(instruction, /【音・環境音】/);
  assert.match(instruction, /【今回の禁止事項】/);
  assert.match(instruction, /存在しない設定シートや画像2以降を書かない/);
  assert.doesNotMatch(instruction, /黒豹|スズメ|おやつ袋/);
});

function validPrompt() {
  return [
    '【動画生成｜3秒｜絵コンテ使用】',
    '【基本設定】',
    '詳細設定',
    '【使用する基準画像】',
    '絵コンテ画像1枚',
    '【絵コンテの読み順】',
    '番号順',
    '【この動画の目的】',
    '解析内容を忠実に映像化する',
    '【登場人物・登場物の固定】',
    '同一性を維持する',
    '【舞台と時間帯】',
    '前後で連続させる',
    '【秒数ごとの映像】',
    '0〜1秒：第1コマ。' + '具体的な動作と表情と構図。'.repeat(12),
    '1〜2秒：第2コマ。' + '具体的な動作と表情と構図。'.repeat(12),
    '2〜3秒：第3コマ。' + '具体的な動作と表情と構図。'.repeat(12),
    '【セリフ】',
    'セリフなし',
    '【音・環境音】',
    '各動作に対応する音',
    '【画風固定】',
    '解析された画風を維持',
    '【今回の禁止事項】',
    '解析にない追加をしない'
  ].join('\n');
}

test('完成プロンプト検証はコマ数・連続時間・見出し・最低密度を確認する', () => {
  const prompt = validPrompt();
  const accepted = storyboard.validateFinalPrompt(prompt, 3, 3);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.ranges, [[0, 1], [1, 2], [2, 3]]);

  const merged = prompt.replace('1〜2秒：第2コマ。' + '具体的な動作と表情と構図。'.repeat(12) + '\n', '');
  assert.equal(storyboard.validateFinalPrompt(merged, 3, 3).ok, false);

  const gap = prompt.replace('1〜2秒：', '1.2〜2秒：');
  assert.equal(storyboard.validateFinalPrompt(gap, 3, 3).ok, false);
});

test('APIは構造化解析後に完成文を作り、構造違反時だけ修復する', () => {
  const analysisIndex = apiSource.indexOf('analysisCall = await callClaude');
  const writerIndex = apiSource.indexOf('writerCall = await callClaude');
  const repairIndex = apiSource.indexOf('repairCall = await callClaude');

  assert.ok(analysisIndex >= 0);
  assert.ok(writerIndex > analysisIndex);
  assert.ok(repairIndex > writerIndex);
  assert.match(apiSource, /const expectedCuts = cuts\.length/);
  assert.match(apiSource, /validateFinalPrompt\(prompt, expectedCuts, durationSeconds\)/);
  assert.match(apiSource, /if \(!parsed \|\| Number\(parsed\.detected_cuts\) !== expectedCuts \|\| !validation\.ok\)/);
});

test('補足指示は最大2000文字で画像と同じ解析へ渡す', () => {
  assert.match(apiSource, /const MAX_STORY_CONTEXT_CHARS = 2000/);
  assert.match(apiSource, /storyContext\.length > MAX_STORY_CONTEXT_CHARS/);
  assert.match(apiSource, /<user_story_context>/);
  assert.match(pageSource, /id="sbStoryContext" maxlength="2000"/);
  assert.match(pageSource, /durationSeconds:duration,aspectRatio,storyContext/);
});

test('現行UIと動画生成は絵コンテ画像1枚のまま変更しない', () => {
  assert.match(pageSource, /画像は1枚のみアップロードできます/);
  assert.match(pageSource, /動画生成時に参照される画像も、この絵コンテ画像1枚です/);
  assert.match(pageSource, /const refUrls=sbLocked\?\[sbGenerationImageUrl\]:urls/);
});
