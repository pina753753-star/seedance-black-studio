'use strict';

// H3 Max Live: history panel is collapsed by default (behind a "履歴を見る"
// toggle) so the video + prompt + action buttons stay near the top of the
// screen. Purely a static-source check on h3-director.html, matching the
// style already used in tests/h3-director.test.js — no server call, no
// Supabase, no fal, no credits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const page = fs.readFileSync(path.join(__dirname, '..', 'h3-director.html'), 'utf8');

test('history-wrap: 初期状態はhistoryPanelがhiddenで「履歴を見る」ボタンを持つ', () => {
  assert.match(
    page,
    /<div class="history-wrap" id="historyWrap">\s*<button type="button" class="history-toggle" id="historyToggle" aria-expanded="false" aria-controls="historyPanel">履歴を見る<\/button>\s*<div class="history" id="historyPanel" hidden>/
  );
  // #history (the element loadHistory() writes innerHTML into) is unchanged.
  assert.match(page, /<div class="history" id="historyPanel" hidden><div class="history-title">H3 MAX LIVE HISTORY<\/div><div id="history">履歴を確認中…<\/div><\/div>/);
});

test('history-wrap: loadHistory()の取得・描画ロジックは無変更 ($(\'history\')のinnerHTMLのみ操作)', () => {
  assert.match(
    page,
    /async function loadHistory\(\)\{try\{var d=await api\('\/api\/h3-director\/history\?limit=10',\{method:'GET'\}\);/
  );
  assert.match(page, /\$\('history'\)\.innerHTML=rows\.length\?/);
  // Playback/save wiring inside the fetched rows is untouched.
  assert.match(page, /data-play="'\+s\.id\+'"/);
  assert.match(page, /openRecording\(b\.dataset\.play,false,b\.dataset\.ratio\)/);
  assert.match(page, /openRecording\(b\.dataset\.save,true\)/);
});

test('historyToggle: クリックで開閉しaria-expanded/文言が切り替わる', () => {
  assert.match(
    page,
    /\$\('historyToggle'\)\.addEventListener\('click',function\(\)\{var open=\$\('historyPanel'\)\.hidden;\$\('historyPanel'\)\.hidden=!open;\$\('historyToggle'\)\.textContent=open\?'履歴を閉じる':'履歴を見る';\$\('historyToggle'\)\.setAttribute\('aria-expanded',open\?'true':'false'\)\}\)/
  );
});

test('Live開始成功時にhistoryPanelを閉じ、ボタン文言を「履歴を見る」へ戻す', () => {
  const idx = page.indexOf("live=true;starting=false;heartbeatFailures=0;document.body.classList.add('live-mode');");
  assert.ok(idx > 0, 'live start success line not found');
  const chunk = page.slice(idx, idx + 400);
  assert.match(chunk, /\$\('historyPanel'\)\.hidden=true;/);
  assert.match(chunk, /\$\('historyToggle'\)\.textContent='履歴を見る';/);
  assert.match(chunk, /\$\('historyToggle'\)\.setAttribute\('aria-expanded','false'\);/);
});

test('モバイルLive中はhistory-wrap全体が非表示になる（既存の.historyに加えて）', () => {
  const mediaBlock = page.slice(
    page.indexOf('@media(max-width:900px){'),
    page.indexOf('</style>')
  );
  assert.match(
    mediaBlock,
    /body\.live-mode \.side-head,\s*\n\s*body\.live-mode \.history-wrap,\s*\n\s*body\.live-mode \.history,\s*\n\s*body\.live-mode \.log,/
  );
});

test('.history[hidden]はdisplay:none!importantで確実に隠れる', () => {
  assert.match(page, /\.history\[hidden\]\{display:none!important\}/);
});

test('history-toggleは大きなカードではなく1行ボタンのスタイル', () => {
  assert.match(page, /\.history-toggle\{width:100%;border:0;background:#0a0a0b;color:#aaa;padding:12px 14px;text-align:left;font-size:11px;font-weight:700\}/);
  assert.match(page, /\.history-toggle:hover\{color:#fff\}/);
});
