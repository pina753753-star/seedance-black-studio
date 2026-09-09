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

test('モバイルLive中はhistory-wrap全体が非表示になる', () => {
  const mediaBlock = page.slice(
    page.indexOf('@media(max-width:900px){'),
    page.indexOf('</style>')
  );
  assert.match(
    mediaBlock,
    /body\.live-mode \.history-wrap,\s*\n\s*body\.live-mode \.history,\s*\n\s*body\.live-mode \.imagepick,/
  );
});

test('モバイルLive中も.logは非表示対象に含まれない（チャットとして表示を継続）', () => {
  const mediaBlock = page.slice(
    page.indexOf('@media(max-width:900px){'),
    page.indexOf('</style>')
  );
  const hiddenListMatch = mediaBlock.match(/body\.live-mode \.history-wrap,[\s\S]*?display:none!important;\s*\}/);
  assert.ok(hiddenListMatch, 'hidden list block not found');
  assert.doesNotMatch(hiddenListMatch[0], /body\.live-mode \.log,/);
  // Explicit visible override, kept compact so it doesn't push the composer down.
  assert.match(mediaBlock, /body\.live-mode \.log\{\s*display:flex;\s*max-height:96px;\s*\}/);
});

test('モバイルの.log/.msgはコンパクト化されている（動画を圧迫しない）', () => {
  const mediaBlock = page.slice(
    page.indexOf('@media(max-width:900px){'),
    page.indexOf('</style>')
  );
  assert.match(mediaBlock, /\.log\{\s*flex:none;\s*min-height:0;\s*max-height:110px;/);
  assert.match(mediaBlock, /\.msg\{\s*font-size:11\.5px;/);
});

test('.history[hidden]はdisplay:none!importantで確実に隠れる', () => {
  assert.match(page, /\.history\[hidden\]\{display:none!important\}/);
});

test('history-toggleは大きなカードではなく1行ボタンのスタイル', () => {
  assert.match(page, /\.history-toggle\{width:100%;border:0;background:#0a0a0b;color:#aaa;padding:12px 14px;text-align:left;font-size:11px;font-weight:700\}/);
  assert.match(page, /\.history-toggle:hover\{color:#fff\}/);
});

// ---------------------------------------------------------------
// 「動画 → チャット → 入力 → 履歴」への並び替え
// ---------------------------------------------------------------

test('side-head（「ライブ指示」見出し・説明）はHTML/CSSから削除されている', () => {
  assert.doesNotMatch(page, /class="side-head"/);
  assert.doesNotMatch(page, /<h1>ライブ指示<\/h1>/);
  assert.doesNotMatch(page, /最初の指示でライブを開始。Live中は追加指示で映像を変化させられます。/);
  assert.doesNotMatch(page, /\.side-head\{/);
});

test('aside内の順序が gate → log → composer → history-wrap になっている', () => {
  const asideStart = page.indexOf('<aside>');
  const asideEnd = page.indexOf('</aside>');
  assert.ok(asideStart > 0 && asideEnd > asideStart, '<aside> block not found');
  const aside = page.slice(asideStart, asideEnd);
  const gateIdx = aside.indexOf('id="gate"');
  const logIdx = aside.indexOf('class="log" id="log"');
  const composerIdx = aside.indexOf('class="composer"');
  const historyWrapIdx = aside.indexOf('id="historyWrap"');
  assert.ok(gateIdx > -1 && logIdx > -1 && composerIdx > -1 && historyWrapIdx > -1, 'one of gate/log/composer/history-wrap missing from <aside>');
  assert.ok(gateIdx < logIdx, 'gate must come before log');
  assert.ok(logIdx < composerIdx, 'log must come before composer');
  assert.ok(composerIdx < historyWrapIdx, 'composer must come before history-wrap');
});

test('チャット風ログ(log(prompt,\'user\')・prompt_pending/applied/rejected・deadline_missed)は無変更で維持されている', () => {
  assert.match(page, /log\(prompt,'user'\)/);
  assert.match(page, /if\(msg\.type==='prompt_pending'\)log\('次の映像へ反映準備中です。'\);/);
  assert.match(page, /if\(msg\.type==='prompt_applied'\)log\('追加指示を反映しました。'\);/);
  assert.match(page, /if\(msg\.type==='prompt_rejected'\)\{/);
  // deadline_missed now also carries a Preview-only diagnostic() call, but the
  // user-facing message text itself is unchanged.
  assert.match(page, /if\(msg\.type==='deadline_missed'\)\{\s*log\('生成が追いつくまで映像を調整しています。'\);/);
  assert.match(page, /log\('準備完了。最初の指示を入力してライブを開始してください。'\);/);
  assert.match(page, /log\('Previewテスト中: Live開始で440 creditsを消費します。'\)/);
});

test('.msg.user / .msg.system の配置・色指定は無変更', () => {
  assert.match(page, /\.msg\.user\{align-self:flex-end;background:#151519\}/);
  assert.match(page, /\.msg\.system\{align-self:flex-start;color:#aaa;background:#080809\}/);
});
