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

// ---------------------------------------------------------------
// openRecording(): 履歴再生時のvideo要素リセットと読み込みエラー処理
// (WebRTC MediaStream → 保存録画signed URLへの切り替え時の黒画面バグ対応)
// ---------------------------------------------------------------

function extractOpenRecordingSource() {
  const startIndex = page.indexOf('async function openRecording(id,download,ratio){');
  assert.ok(startIndex > 0, 'openRecording() not found in h3-director.html');
  const braceStart = page.indexOf('{', startIndex);
  let depth = 0;
  for (let i = braceStart; i < page.length; i++) {
    if (page[i] === '{') depth++;
    else if (page[i] === '}') {
      depth--;
      if (depth === 0) return page.slice(startIndex, i + 1);
    }
  }
  throw new Error('unbalanced braces while extracting openRecording() source');
}

test('openRecording(): 再生前にvideo要素をpause()する', () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /try\{videoEl\.pause\(\)\}catch\(e\)\{\}/);
});

test('openRecording(): srcObject=null / removeAttribute(\'src\') / load()でリセットする', () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /videoEl\.srcObject=null;/);
  assert.match(src, /videoEl\.removeAttribute\('src'\);/);
  const resetIdx = src.indexOf("videoEl.removeAttribute('src');");
  const loadIdx = src.indexOf('try{videoEl.load()}catch(e){}');
  assert.ok(resetIdx > 0 && loadIdx > resetIdx, 'load() must follow the src reset');
});

test('openRecording(): 新しいsigned URL設定後にもload()を呼ぶ', () => {
  const src = extractOpenRecordingSource();
  const srcAssignIdx = src.indexOf('videoEl.src=d.url;');
  assert.ok(srcAssignIdx > 0, 'videoEl.src=d.url; not found');
  const afterAssign = src.slice(srcAssignIdx);
  assert.match(afterAssign, /videoEl\.load\(\);/);
});

test('openRecording(): canplay/errorリスナーを登録し、canplay後にplay()する', () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /videoEl\.addEventListener\('canplay',onCanPlay\);/);
  assert.match(src, /videoEl\.addEventListener\('error',onPlaybackError\);/);
  assert.match(src, /function onCanPlay\(\)\{/);
  assert.match(src, /playPromise=videoEl\.play\(\);/);
});

test("openRecording(): error時に「保存した動画を再生できませんでした。」を表示する", () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /function onPlaybackError\(\)\{/);
  assert.match(src, /notice\('保存した動画を再生できませんでした。'\);/);
});

test('openRecording(): Preview診断にhistory playback error / contentType / error codeを記録する', () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /diagnostic\(\s*'history playback error: code='\+code\+\s*' \/ contentType='\+\(d\.contentType\|\|'unknown'\)\s*\);/);
  assert.match(src, /var code=videoEl\.error&&videoEl\.error\.code\s*\?videoEl\.error\.code\s*:'unknown';/);
  assert.match(src, /diagnostic\(\s*'history playback ready: contentType='\+\s*\(d\.contentType\|\|'unknown'\)\s*\);/);
});

test('openRecording(): canplay/error発火は一度だけ処理し、リスナーを解除する(多重発火ガード)', () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /var playbackSettled=false;/);
  assert.match(src, /if\(playbackSettled\)return;\s*playbackSettled=true;\s*cleanupPlaybackListeners\(\);/);
  assert.match(src, /function cleanupPlaybackListeners\(\)\{\s*videoEl\.removeEventListener\('canplay',onCanPlay\);\s*videoEl\.removeEventListener\('error',onPlaybackError\);\s*\}/);
});

test('openRecording(): 自動再生拒否(play()のcatch)はファイル破損と区別し「再生ボタンを押してください。」を表示', () => {
  const src = extractOpenRecordingSource();
  const canPlayIdx = src.indexOf('function onCanPlay(){');
  const nextFnIdx = src.indexOf('videoEl.addEventListener');
  const canPlayBlock = src.slice(canPlayIdx, nextFnIdx);
  assert.match(canPlayBlock, /playPromise\.catch\(function\(\)\{/);
  assert.match(canPlayBlock, /notice\('再生ボタンを押してください。'\);/);
  assert.doesNotMatch(canPlayBlock, /保存した動画を再生できませんでした。/);
});

test('openRecording(): download=trueの既存保存処理(署名URLへの直接リンクダウンロード)は無変更', () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /if\(download\)\{/);
  assert.match(src, /a\.href=d\.url;/);
  assert.match(src, /a\.download=d\.filename\|\|\('h3-director-'\+id\);/);
  assert.match(src, /a\.target='_blank';/);
  assert.match(src, /a\.rel='noopener';/);
  assert.match(src, /document\.body\.appendChild\(a\);/);
  assert.match(src, /a\.click\(\);/);
  assert.match(src, /a\.remove\(\);/);
  assert.match(src, /return;/);
});

test('openRecording(): live中は再生せず既存メッセージのみ表示する(ratio切替・video要素操作より前にreturn)', () => {
  const src = extractOpenRecordingSource();
  const liveIdx = src.indexOf('if(live){');
  const videoElIdx = src.indexOf('var videoEl=$(\'video\');');
  assert.ok(liveIdx > 0 && videoElIdx > liveIdx, 'live check must precede video element handling');
  assert.match(src, /if\(live\)\{\s*notice\('ライブ終了後に履歴を再生できます。'\);\s*return;\s*\}/);
});

test('openRecording(): API呼び出し自体(recording-url)は無変更', () => {
  const src = extractOpenRecordingSource();
  assert.match(src, /api\(\s*'\/api\/h3-director\/recording-url\?sessionId='\+encodeURIComponent\(id\),\s*\{method:'GET'\}\s*\);/);
});
