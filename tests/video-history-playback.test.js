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
