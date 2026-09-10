'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'h3-director.html'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'h3-director-history-ui.js'), 'utf8');

test('h3-director.html: 履歴専用UIスクリプトを読み込む', () => {
  assert.match(html, /<script src="\.\/h3-director-history-ui\.js\?v=abc6a78"><\/script>/);
});

test('履歴再生: ライブ表示用#videoを使い回さず専用videoを生成する', () => {
  assert.match(ui, /id="h3HistoryVideo" playsinline webkit-playsinline controls preload="metadata"/);
  assert.match(ui, /player=overlay\.querySelector\('video'\)/);
  assert.doesNotMatch(ui, /getElementById\('video'\)/);
});

test('履歴再生: 閉じる時はpause→src削除→loadで完全リセットする', () => {
  const start = ui.indexOf('function closeOverlay(){');
  assert.ok(start >= 0);
  const end = ui.indexOf('async function playRecording', start);
  const src = ui.slice(start, end);
  const pause = src.indexOf('player.pause()');
  const remove = src.indexOf("player.removeAttribute('src')");
  const load = src.indexOf('player.load()');
  assert.ok(pause >= 0 && remove > pause && load > remove);
});

test('履歴再生: iPhoneでページ状態を崩す自動playを行わずcontrolsで明示再生する', () => {
  const start = ui.indexOf('async function playRecording(sessionId){');
  assert.ok(start >= 0);
  const end = ui.indexOf('async function saveRecordingFile', start);
  const src = ui.slice(start, end);
  assert.match(src, /player\.controls=true;/);
  assert.match(src, /showNotice\('再生ボタンを押してください。'\);/);
  assert.doesNotMatch(src, /player\.play\(\)/);
});

test('履歴再生: オーバーレイは固定100%領域で元ページのvideo寸法に依存しない', () => {
  assert.match(ui, /\.h3-history-player\{position:fixed!important;inset:0!important;width:100%!important;height:100%!important;/);
  assert.match(ui, /\.h3-history-player video\{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;/);
  assert.doesNotMatch(ui, /100dvh/);
});

test('履歴再生: data-playクリックをcaptureで横取りし既存onclickを実行させない', () => {
  assert.match(ui, /document\.addEventListener\('click',[\s\S]*?,true\);/);
  assert.match(ui, /event\.stopImmediatePropagation\(\);[\s\S]*playRecording\(playButton\.dataset\.play\|\|''\)/);
});

test('保存: signed URLをBlob取得してobject URLからdownloadする', () => {
  assert.match(ui, /var response=await fetch\(info\.url,\{cache:'no-store'\}\);/);
  assert.match(ui, /var blob=await response\.blob\(\);/);
  assert.match(ui, /var blobUrl=URL\.createObjectURL\(blob\);/);
  assert.match(ui, /anchor\.href=blobUrl;/);
  assert.match(ui, /anchor\.download=info\.filename\|\|/);
  assert.match(ui, /URL\.revokeObjectURL\(blobUrl\)/);
});

test('保存: data-saveクリックも既存の直接URLダウンロード処理を抑止する', () => {
  assert.match(ui, /var saveButton=[\s\S]*?closest\('\[data-save\]'\)/);
  assert.match(ui, /event\.stopImmediatePropagation\(\);[\s\S]*saveRecordingFile\(saveButton\.dataset\.save\|\|'',saveButton\)/);
});

test('録画形式: Safariが対応するMP4候補を検出しH3本体の先頭候補へ安全に割り当てる', () => {
  assert.match(ui, /var mp4Candidates=\[/);
  assert.match(ui, /'video\/mp4;codecs=h264,aac'/);
  assert.match(ui, /'video\/mp4;codecs=avc1\.42E01E,mp4a\.40\.2'/);
  assert.match(ui, /'video\/mp4'/);
  assert.match(ui, /if\(!supportedMp4\)return;/);
  assert.match(ui, /options&&options\.mimeType==='video\/mp4;codecs=h264,aac'/);
  assert.match(ui, /Object\.assign\(\{\},options,\{mimeType:supportedMp4\}\)/);
});

test('録画形式: MP4非対応ならMediaRecorderを変更せずWebMフォールバックを残す', () => {
  const start = ui.indexOf('function installMp4RecorderCompatibility(){');
  const end = ui.indexOf('installMp4RecorderCompatibility();', start);
  const src = ui.slice(start, end);
  const noMp4 = src.indexOf('if(!supportedMp4)return;');
  const replace = src.indexOf('window.MediaRecorder=H3MediaRecorder;');
  assert.ok(noMp4 >= 0 && replace > noMp4);
});

test('履歴UI: 生成開始API・credits・DB書き込みコードを持たない', () => {
  assert.doesNotMatch(ui, /start-session|approve-prompt|recording-upload-url|recording-complete|440\s*credits|supabase\.from\(/);
});
