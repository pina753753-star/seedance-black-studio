'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'flowvid-history.js'), 'utf8');

test('履歴動画の初期化は遅延したseekedイベントでタップ再生を停止しない', () => {
  assert.doesNotMatch(source, /addEventListener\(['"]seeked['"][\s\S]{0,80}\.pause\(\)/);
  assert.match(source, /v\.pause\(\);v\.removeAttribute\(['"]autoplay['"]\)/);
});

test('履歴動画は動画部分のタップで再生と停止を切り替える', () => {
  assert.match(source, /closest\?\.\(['"]\.fv-video-frame['"]\)/);
  assert.match(source, /v\.paused\?v\.play\(\)\.catch\(\(\)=>\{\}\):v\.pause\(\)/);
});

test('履歴カードは保存済みモデルを短い名称で表示する', () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '..', 'api', 'generated-videos.js'), 'utf8');

  assert.match(apiSource, /model: row\.model \|\| ''/);
  assert.match(apiSource, /model: task\.model \|\| ''/);
  assert.match(apiSource, /provider: task\.api_provider \|\| ''/);
  assert.match(source, /provider:String\(row\?\.provider\|\|row\?\.api_provider/);
  assert.match(source, /model:String\(row\?\.model\|\|row\?\.settings\?\.model\|\|''\)\.trim\(\)/);
  assert.match(source, /bytedance\/seedance-2\.5-standard'\?'Seedance 2\.5'/);
  assert.match(source, /provider==='wavespeed'\?'Seedance 2\.5 Turbo'/);
  assert.match(source, /bytedance\/seedance-2\.0-fast'\?'Seedance 2\.0 Fast'/);
  assert.match(source, /\[modelLabel\(it\.model,it\.provider\),it\.aspect/);
});
