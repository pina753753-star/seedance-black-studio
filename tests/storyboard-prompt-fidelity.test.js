'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'api', 'storyboard-prompt.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(root, 'generate-prod.html'), 'utf8');
const builderStart = apiSource.indexOf('function buildStoryboardPromptInstruction(');
const builderEnd = apiSource.indexOf('function extractJsonObject(', builderStart);
const context = {};
vm.createContext(context);
vm.runInContext(`${apiSource.slice(builderStart, builderEnd)}\nthis.buildInstruction=buildStoryboardPromptInstruction;`, context);

test('絵コンテ解析指示は画風・変身・具体動作・最終オチを忠実に保つ', () => {
  const instruction = context.buildInstruction(15, '16:9');

  assert.match(instruction, /左上から右、上段から下段/);
  assert.match(instruction, /1コマずつ個別解析/);
  assert.match(instruction, /変身・変化/);
  assert.match(instruction, /存在しない人物、動物、小道具、設定、出来事を追加しない/);
  assert.match(instruction, /最終コマ/);
  assert.match(instruction, /コミカルなオチ/);
  assert.match(instruction, /温かい結末へ置き換えない/);
  assert.match(instruction, /日本アニメ調/);
  assert.match(instruction, /3D、実写、写実、フォトリアル/);
  assert.match(instruction, /お守り等へ勝手に決めない/);
  assert.match(instruction, /壁蹴り、方向転換、回収/);
});

test('補足指示は最大2000文字で画像と同じ解析リクエストへ渡す', () => {
  assert.match(apiSource, /const MAX_STORY_CONTEXT_CHARS = 2000/);
  assert.match(apiSource, /storyContext\.length > MAX_STORY_CONTEXT_CHARS/);
  assert.match(apiSource, /ユーザーの補足指示/);
  assert.match(pageSource, /id="sbStoryContext" maxlength="2000"/);
  assert.match(pageSource, /durationSeconds:duration,aspectRatio,storyContext/);
});

test('生成前確認は画像にない追加と変更をユーザーが確認できる', () => {
  assert.match(pageSource, /登場人物・画風・変身・小道具・最後のオチ/);
  assert.match(pageSource, /画像にない追加や変更がないか確認/);
});

test('現行仕様は参照画像が絵コンテ1枚だけであることを明示する', () => {
  assert.match(pageSource, /動画生成時に参照される画像も、この絵コンテ画像1枚です/);
  assert.match(pageSource, /const refUrls=sbLocked\?\[sbGenerationImageUrl\]:urls/);
});
