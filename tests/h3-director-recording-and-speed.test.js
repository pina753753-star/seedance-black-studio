'use strict';

// H3 Max Live:
// A) Recording no longer starts on WebRTC `ontrack`/live-start — it starts on
//    the first `chunk` server message, so the saved recording no longer
//    includes the pre-generation freeze frame.
// B) directorPrompt() appends a natural-real-time-speed hint to prompts that
//    don't already specify a speed, applied only to the WebRTC `configure`/
//    `prompt` messages sent to fal — never to the raw text sent to
//    /api/h3-director/approve-prompt, shown via log(), or in the placeholder.
//
// Purely static-source checks on h3-director.html (same style as
// tests/h3-director.test.js) plus a standalone evaluation of directorPrompt's
// logic extracted from the file. No server call, no Supabase, no fal, no
// credits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const page = fs.readFileSync(path.join(__dirname, '..', 'h3-director.html'), 'utf8');

function extractFunctionSource(src, startIndex) {
  const braceStart = src.indexOf('{', startIndex);
  assert.ok(braceStart > startIndex, 'opening brace not found');
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(startIndex, i + 1);
    }
  }
  throw new Error('unbalanced braces while extracting function source');
}

function loadDirectorPrompt() {
  const startIndex = page.indexOf('function directorPrompt(text)');
  assert.ok(startIndex > 0, 'directorPrompt() not found in h3-director.html');
  const source = extractFunctionSource(page, startIndex);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.directorPrompt = directorPrompt;`, sandbox);
  return sandbox.directorPrompt;
}

// ---------------------------------------------------------------
// A. Recording starts on first chunk, not on track/live-start
// ---------------------------------------------------------------

test('pc.ontrackからmaybeStartRecording()が削除されている（映像表示のみ維持、firstVideoTrackAt診断は追加）', () => {
  const idx = page.indexOf('pc.ontrack=function(event){');
  assert.ok(idx > 0, 'pc.ontrack not found');
  const chunk = page.slice(idx, page.indexOf('pc.onconnectionstatechange='));
  assert.match(chunk, /remoteStream\.addTrack\(event\.track\);\$\('empty'\)\.style\.display='none';\$\('video'\)\.play\(\)\.catch\(function\(\)\{notice\('映像をタップすると音声付きで再生できます。'\)\}\)/);
  assert.doesNotMatch(chunk, /maybeStartRecording/);
});

test('Live開始成功直後からmaybeStartRecording()が削除されている（state(\'LIVE\')は維持）', () => {
  const idx = page.indexOf("live=true;starting=false;heartbeatFailures=0;document.body.classList.add('live-mode');");
  assert.ok(idx > 0, 'live start success line not found');
  const chunk = page.slice(idx, idx + 400);
  assert.match(chunk, /state\('LIVE'\);/);
  assert.doesNotMatch(chunk, /state\('LIVE'\);maybeStartRecording\(\)/);
});

test("msg.type==='chunk'でmaybeStartRecording()が呼ばれる", () => {
  // chunk handling now also records Preview-only diagnostics, but
  // maybeStartRecording() is still called for every chunk message.
  const chunkBlock = page.slice(page.indexOf("if(msg.type==='chunk'){"), page.indexOf("if(msg.type==='error')"));
  assert.match(chunkBlock, /maybeStartRecording\(\);/);
});

test('maybeStartRecording()自体の多重開始ガード(recorder存在チェック)は無変更', () => {
  assert.match(
    page,
    /function maybeStartRecording\(\)\{clearTimeout\(recordStartTimer\);recordStartTimer=setTimeout\(function\(\)\{if\(!live\|\|recorder\|\|!remoteStream\|\|!remoteStream\.getVideoTracks\(\)\.length\)return;/
  );
});

// ---------------------------------------------------------------
// B. directorPrompt() natural-speed hint
// ---------------------------------------------------------------

test('directorPrompt: 速度未指定のpromptには自然な実時間速度の補助が付く', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('ジャンプする'), 'ジャンプする 動きは自然な実時間の速度。スローモーションにしない。');
});

test('directorPrompt: 「ゆっくり」を含む場合は補助を追加しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('ゆっくり歩く'), 'ゆっくり歩く');
});

test('directorPrompt: "slow motion" を含む場合は補助を追加しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('cat walking in slow motion'), 'cat walking in slow motion');
});

test('directorPrompt: 「高速」を含む場合は補助を追加しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('高速で走る'), '高速で走る');
});

test('directorPrompt: 「普通の速度」「通常速度」「実時間」を含む場合も補助を追加しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('普通の速度で歩く'), '普通の速度で歩く');
  assert.equal(directorPrompt('通常速度で走る'), '通常速度で走る');
  assert.equal(directorPrompt('実時間で動く'), '実時間で動く');
});

test('directorPrompt: 空文字・空白のみは補助文だけのtrim済み文字列になる', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt(''), ' 動きは自然な実時間の速度。スローモーションにしない。');
  assert.equal(directorPrompt('   '), ' 動きは自然な実時間の速度。スローモーションにしない。');
});

test('初期configureメッセージはdirectorPrompt(prompt)を使用する', () => {
  assert.match(
    page,
    /var outgoingPrompt=directorPrompt\(prompt\);\s*var configureMsg=\{type:'configure',protocol_version:1,prompt_version:1,prompt:outgoingPrompt,resolution:'768p',aspect_ratio:aspectRatio,memory:12\};/
  );
});

test('Live中の追加promptはdirectorPrompt(approved.prompt)を使用する', () => {
  assert.match(
    page,
    /sendControl\(\{\s*type:'prompt',\s*prompt_version:approved\.promptVersion,\s*prompt:directorPrompt\(approved\.prompt\),\s*replan:true\s*\}\);/
  );
});

test('approve-promptへ送る元promptはユーザー入力のまま変更なし', () => {
  assert.match(
    page,
    /api\('\/api\/h3-director\/approve-prompt',\{\s*method:'POST',\s*body:JSON\.stringify\(\{\s*sessionId:sessionId,\s*prompt:prompt\s*\}\)\s*\}\);/
  );
});

test("log(prompt,'user')は元のユーザー入力のまま維持されている(directorPromptの補助文を表示しない)", () => {
  const idx = page.indexOf('async function sendPrompt(){');
  assert.ok(idx > 0, 'sendPrompt() not found');
  const endIdx = page.indexOf('async function openRecording(');
  assert.ok(endIdx > idx, 'openRecording() not found after sendPrompt()');
  const chunk = page.slice(idx, endIdx);
  const sendControlIdx = chunk.indexOf("sendControl({");
  const logIdx = chunk.indexOf("log(prompt,'user');");
  assert.ok(sendControlIdx > 0 && logIdx > sendControlIdx, "log(prompt,'user') must come after sendControl() of the directorPrompt-wrapped message");
});

test('memory:12は無変更', () => {
  assert.match(page, /memory:12/);
});

test('placeholderから「ゆっくり」を誘導する文言が削除されている', () => {
  const textareaMatch = page.match(/<textarea id="prompt"[^>]*placeholder="([^"]*)"/);
  assert.ok(textareaMatch, 'prompt textarea placeholder not found');
  assert.doesNotMatch(textareaMatch[1], /ゆっくり/);
});

test('acceleration / chunk_duration などの未公開パラメータをClientメッセージへ送信していない（受信診断としての参照のみ許可）', () => {
  // configure/prompt messages sent to fal must not gain new fields.
  assert.match(
    page,
    /var outgoingPrompt=directorPrompt\(prompt\);\s*var configureMsg=\{type:'configure',protocol_version:1,prompt_version:1,prompt:outgoingPrompt,resolution:'768p',aspect_ratio:aspectRatio,memory:12\};/
  );
  assert.match(
    page,
    /sendControl\(\{\s*type:'prompt',\s*prompt_version:approved\.promptVersion,\s*prompt:directorPrompt\(approved\.prompt\),\s*replan:true\s*\}\);/
  );
  // acceleration/chunk_duration appear ONLY as read-only diagnostic() output
  // sourced from server messages (msg.acceleration / msg.chunk_duration),
  // never as a property being written into an outgoing message object.
  assert.doesNotMatch(page, /acceleration:/i);
  assert.doesNotMatch(page, /chunk_duration:/i);
});

// ---------------------------------------------------------------
// C. sendPrompt() 二重送信防止 + 送信中の次入力保持
//    (追加プロンプト送信中の approve-prompt 並行実行と、送信中に書き始めた
//    次の指示が消える問題への対応。API側prompt_version機構には触れない。)
// ---------------------------------------------------------------

function extractSendPromptSource(src) {
  const startIndex = src.indexOf('async function sendPrompt(){');
  assert.ok(startIndex > 0, 'sendPrompt() not found in h3-director.html');
  return extractFunctionSource(src, startIndex + 'async '.length);
}

test('promptSendingが状態変数として宣言されている(初期値false)', () => {
  assert.match(
    page,
    /var expiresAt=0,live=false,starting=false,blocked=false,heartbeatFailures=0,authToken='',promptSending=false;/
  );
});

test('sendPrompt(): promptSending中はearly returnし、approve-promptを再実行しない', () => {
  const src = extractSendPromptSource(page);
  assert.match(src, /if\(!prompt\|\|!live\|\|!sessionId\|\|promptSending\)return;/);
});

test('sendPrompt(): 呼び出し直後にpromptSending=trueとaction無効化を行う', () => {
  const src = extractSendPromptSource(page);
  const guardIdx = src.indexOf('if(!prompt||!live||!sessionId||promptSending)return;');
  const setTrueIdx = src.indexOf('promptSending=true;');
  const disableIdx = src.indexOf("$('action').disabled=true;");
  assert.ok(guardIdx > 0 && setTrueIdx > guardIdx && disableIdx > setTrueIdx, 'promptSending=true and action disable must happen right after the guard');
});

test('sendPrompt(): 送信開始時と同じ内容が残っている場合だけtextareaを空にする', () => {
  const src = extractSendPromptSource(page);
  assert.match(src, /if\(\$\('prompt'\)\.value\.trim\(\)===prompt\)\{\s*\$\('prompt'\)\.value='';\s*\}/);
});

test('sendPrompt(): finally節で必ずpromptSending=falseへ戻し、action有効/無効を再評価する', () => {
  const src = extractSendPromptSource(page);
  const finallyIdx = src.indexOf('}finally{');
  assert.ok(finallyIdx > 0, 'finally not found');
  const finallyBlock = src.slice(finallyIdx);
  assert.match(finallyBlock, /promptSending=false;/);
  assert.match(finallyBlock, /\$\('action'\)\.disabled=\s*blocked\|\|\s*starting\|\|\s*imageUploading\|\|\s*!live\|\|\s*!\$\('prompt'\)\.value\.trim\(\);/);
  assert.match(finallyBlock, /\$\('action'\)\.textContent=live\?'追加指示を送る':'ライブ生成を開始';/);
});

test('sendPrompt(): APIエラー時もfinallyでpromptSending=falseへ戻る(catch/finally両方を通る構造)', () => {
  const src = extractSendPromptSource(page);
  const catchIdx = src.indexOf('}catch(e){');
  const finallyIdx = src.indexOf('}finally{');
  assert.ok(catchIdx > 0 && finallyIdx > catchIdx, 'catch must precede finally');
  const catchBlock = src.slice(catchIdx, finallyIdx);
  assert.match(catchBlock, /notice\(e\.message\);/);
  assert.match(catchBlock, /log\('指示を送信できませんでした。'\);/);
  // finally always runs after catch, restoring promptSending regardless of
  // success/failure — verified by the finally-block test above.
});

test("input listener: promptSending中は文字入力してもaction buttonを再有効化しない", () => {
  const idx = page.indexOf("$('prompt').addEventListener('input',function(){");
  assert.ok(idx > 0, 'prompt input listener not found');
  const chunk = page.slice(idx, idx + 250);
  assert.match(chunk, /blocked\|\|\s*starting\|\|\s*imageUploading\|\|\s*promptSending\|\|\s*!this\.value\.trim\(\)/);
});

test('cleanup(): promptSending=falseを設定する(Live終了・接続失敗後に送信中状態を残さない)', () => {
  const idx = page.indexOf('function cleanup(){stopVideoDiagnostics();');
  assert.ok(idx > 0, 'cleanup() not found');
  const chunk = page.slice(idx, idx + 150);
  assert.match(chunk, /function cleanup\(\)\{stopVideoDiagnostics\(\);live=false;starting=false;promptSending=false;document\.body\.classList\.remove\('live-mode'\);/);
});

test('approve-prompt APIルート自体は変更していない(呼び出しシグネチャのみ確認、ファイルは触っていない)', () => {
  const src = extractSendPromptSource(page);
  assert.match(src, /api\('\/api\/h3-director\/approve-prompt',\{/);
  assert.match(src, /method:'POST',/);
  assert.match(src, /sessionId:sessionId,/);
  assert.match(src, /prompt:prompt/);
});
