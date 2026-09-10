'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'h3-director.html'), 'utf8');
const ui = fs.readFileSync(path.join(__dirname, '..', 'h3-director-history-ui.js'), 'utf8');

test('h3-director.html: 履歴を見る/閉じるの折りたたみ構造を維持する', () => {
  assert.match(html, /id="historyToggle"[^>]*aria-expanded="false"[^>]*aria-controls="historyPanel">履歴を見る<\/button>/);
  assert.match(html, /<div class="history" id="historyPanel" hidden>/);
  assert.match(html, /\$\('historyToggle'\)\.addEventListener\('click'/);
});

test('履歴UI: 固定全画面オーバーレイを作らない', () => {
  assert.doesNotMatch(ui, /h3HistoryPlayer|h3-history-player|position:fixed!important/);
  assert.doesNotMatch(ui, /document\.body\.classList\.add\('h3-history-open'\)/);
});

test('履歴UI: PinaStudio本体と同様にカード内へ動画枠と操作列を持つ', () => {
  assert.match(ui, /className='h3-history-video-frame'/);
  assert.match(ui, /<video playsinline webkit-playsinline controls preload="metadata"><\/video>/);
  assert.match(ui, /actionHost\.classList\.add\('h3-history-actions'\)/);
  assert.match(ui, /item\.insertBefore\(frame,actionHost\)/);
});

test('履歴UI: プロンプトはカード内2行で省略する', () => {
  assert.match(ui, /-webkit-line-clamp:2/);
  assert.match(ui, /white-space:normal/);
});

test('履歴再生: ライブ表示用#videoを使い回さない', () => {
  assert.doesNotMatch(ui, /getElementById\('video'\)/);
  assert.doesNotMatch(ui, /querySelector\('#video'\)/);
  assert.match(ui, /frame\.querySelector\('video'\)/);
});

test('履歴再生: data-playをcaptureで処理し既存onclickを二重実行させない', () => {
  assert.match(ui, /document\.addEventListener\('click',[\s\S]*?,true\);/);
  assert.match(ui, /event\.stopImmediatePropagation\(\);[\s\S]*playRecording\(playButton\)/);
});

test('履歴再生: signed URL取得後にカード内videoへ設定しcontrolsを維持する', () => {
  const start = ui.indexOf('async function playRecording(button){');
  assert.ok(start >= 0);
  const end = ui.indexOf('async function saveRecordingFile', start);
  const src = ui.slice(start, end);
  assert.match(src, /var info=await recordingInfo\(button\.dataset\.play\|\|''\);/);
  assert.match(src, /video\.src=info\.url;/);
  assert.match(src, /video\.controls=true;/);
  assert.match(src, /frame\.classList\.add\('ready'\)/);
});

test('履歴再生: 他の履歴動画は停止しカードをまたいだ多重再生を防ぐ', () => {
  assert.match(ui, /function stopOtherHistoryVideos\(except\)/);
  assert.match(ui, /document\.querySelectorAll\('#history \.h3-history-video-frame video'\)/);
  assert.match(ui, /if\(video===except\)return;/);
  assert.match(ui, /video\.pause\(\)/);
});

test('履歴UI: loadHistory後のDOM差し替えにもMutationObserverで再適用する', () => {
  assert.match(ui, /new MutationObserver\(enhanceHistory\)\.observe\(historyRoot,\{childList:true,subtree:true\}\)/);
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
