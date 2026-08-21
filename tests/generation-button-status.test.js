'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'generate-prod.html'), 'utf8');
const start = source.indexOf('function updateCreditUi()');
const end = source.indexOf('function ensureGenerationModelOptions()', start);
const updateCreditUi = source.slice(start, end);

test('画像・曲の状態は上部に表示し、生成ボタンの文言を置き換えない', () => {
  for (const duplicatedLabel of [
    '画像を追加してください',
    '画像アップロード中',
    '失敗した画像を再試行してください',
    '音源アップロード中',
    '音源を選び直してください'
  ]) {
    assert.doesNotMatch(updateCreditUi, new RegExp(duplicatedLabel));
  }
  assert.match(updateCreditUi, /btn\.textContent='作成する ✦ '\+c/);
});

test('画像・曲が未完了の間はボタンの無効化を維持する', () => {
  assert.match(updateCreditUi, /blockedByAudio/);
  assert.match(updateCreditUi, /blockedByImage/);
  assert.match(updateCreditUi, /btn\.disabled=blockedByAudio\|\|blockedByImage/);
});

test('画像・曲それぞれのアップロード状態表示は上部に残す', () => {
  assert.match(source, /画像をアップロードしています/);
  assert.match(source, /音源を安全にアップロード中/);
});
