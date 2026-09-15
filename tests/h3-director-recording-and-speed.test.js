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

test('directorPrompt: アクションpromptには即時の高速動作補助が付く', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(
    directorPrompt('ジャンプする'),
    'ジャンプする 開始直後から実時間の高速動作。静止、溜め、長いポーズ、全編スローモーションを入れず、連続動作を即座に実行する。'
  );
});

test('directorPrompt: 「ゆっくり」を含む場合は補助を追加しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('ゆっくり歩く'), 'ゆっくり歩く');
});

test('directorPrompt: "slow motion" を含む場合は補助を追加しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('cat walking in slow motion'), 'cat walking in slow motion');
});

test('directorPrompt: 一部スローの後に高速へ戻る指示はスロー区間を限定する', () => {
  const directorPrompt = loadDirectorPrompt();
  const built = directorPrompt('5〜7秒だけスローモーション。その後すぐ高速戦闘へ戻る');
  assert.match(built, /スローモーションは明示した区間だけに限定/);
  assert.match(built, /その直後から指定どおり実時間または高速動作へ戻す/);
  assert.match(built, /指定区間以外をスローにしない/);
});

test('directorPrompt: 一部スローの後に通常速度へ戻る指示もスロー区間を限定する', () => {
  const directorPrompt = loadDirectorPrompt();
  const built = directorPrompt('2秒だけスロー、その後は通常速度へ戻る');
  assert.match(built, /スローモーションは明示した区間だけに限定/);
  assert.match(built, /指定区間以外をスローにしない/);
});

test('directorPrompt: 「高速」を含む場合も高速動作補助を追加する', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.match(directorPrompt('高速で走る'), /開始直後から実時間の高速動作/);
  assert.match(directorPrompt('高速で走る'), /全編スローモーションを入れず/);
});

test('directorPrompt: スロー禁止はスロー要求として誤判定しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.match(directorPrompt('高速で戦う。スローモーションにしない。'), /開始直後から実時間の高速動作/);
});

test('directorPrompt: 「普通の速度」「通常速度」「実時間」を含む場合も補助を追加しない', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt('普通の速度で歩く'), '普通の速度で歩く');
  assert.equal(directorPrompt('通常速度で走る'), '通常速度で走る');
  assert.equal(directorPrompt('実時間で動く'), '実時間で動く');
});

test('directorPrompt: 空文字・空白のみは空文字のまま', () => {
  const directorPrompt = loadDirectorPrompt();
  assert.equal(directorPrompt(''), '');
  assert.equal(directorPrompt('   '), '');
});

test('初期configureメッセージはサーバー固定済みpromptを優先してdirectorPromptへ渡す', () => {
  assert.match(
    page,
    /var outgoingPrompt=directorPrompt\(initialProviderPromptForConfigure\|\|prompt\);\s*var configureMsg=\{type:'configure',protocol_version:1,prompt_version:1,prompt:outgoingPrompt,resolution:'768p',aspect_ratio:aspectRatio,memory:12\};/
  );
});

test('Live中の追加promptはサーバー固定済みpromptを優先し旧API応答へも対応する', () => {
  assert.match(
    page,
    /sendControl\(\{\s*type:'prompt',\s*prompt_version:approved\.promptVersion,\s*prompt:directorPrompt\(approved\.providerPrompt\|\|approved\.prompt\),\s*replan:true\s*\}\);/
  );
});

test('approve-promptへ送る元promptはユーザー入力のまま、commandIdを添えて送る', () => {
  assert.match(
    page,
    /api\('\/api\/h3-director\/approve-prompt',\{\s*method:'POST',\s*body:JSON\.stringify\(\{\s*sessionId:sessionId,\s*commandId:commandId,\s*prompt:prompt\s*\}\)\s*\}\);/
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
    /var outgoingPrompt=directorPrompt\(initialProviderPromptForConfigure\|\|prompt\);\s*var configureMsg=\{type:'configure',protocol_version:1,prompt_version:1,prompt:outgoingPrompt,resolution:'768p',aspect_ratio:aspectRatio,memory:12\};/
  );
  assert.match(
    page,
    /sendControl\(\{\s*type:'prompt',\s*prompt_version:approved\.promptVersion,\s*prompt:directorPrompt\(approved\.providerPrompt\|\|approved\.prompt\),\s*replan:true\s*\}\);/
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
    /var expiresAt=0,live=false,starting=false,blocked=false,heartbeatFailures=0,authToken='',promptSending=false,finishing=false;/
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
  // 「指示を送信できませんでした。」の一律表示から、拒否・置換済み(prompt_version
  // 競合)・セッション終了等を区別するdescribePromptSubmitError(e.code)へ変更。
  assert.match(catchBlock, /log\(describePromptSubmitError\(e\.code\)\);/);
  // finally always runs after catch, restoring promptSending regardless of
  // success/failure — verified by the finally-block test above.
});

// describePromptSubmitError(): approve-prompt.jsのエラーコードごとに、拒否・
// 置換済み・セッション終了等を区別した短い日本語文言を返す。実際にvm評価して
// 振る舞いを確認する(directorPromptと同じ抽出パターン)。
function loadDescribePromptSubmitError(){
  const startIndex = page.indexOf('function describePromptSubmitError(code)');
  assert.ok(startIndex > 0, 'describePromptSubmitError() not found in h3-director.html');
  const endIndex = page.indexOf('\n    }', startIndex) + 6;
  const source = page.slice(startIndex, endIndex);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.describePromptSubmitError = describePromptSubmitError;`, sandbox);
  return sandbox.describePromptSubmitError;
}

// approve-prompt.js側で定義されている6コードすべてを、table-drivenで確認する。
// prompt_version_conflictは「反映され、置き換えられた」という事実誤認を避け、
// 「先に受理されたため送信されなかった」という表現に変更済み。
const KNOWN_PROMPT_SUBMIT_ERRORS = [
  ['content_not_allowed', 'この指示はコンテンツポリシーにより拒否されました。'],
  ['prompt_version_conflict', '別の指示が先に受理されたため、この指示は送信されませんでした。内容を確認して再送してください。'],
  ['session_not_live', 'ライブがすでに終了しているため送信できませんでした。'],
  ['content_safety_unavailable', '安全確認ができないため送信できませんでした。'],
  ['identity_anchor_unavailable', '開始画像の人物固定情報を確認できないため、指示を送信しませんでした。'],
  ['account_restricted', 'アカウントの状態により送信できませんでした。'],
  ['access_revoked', '現在この機能を利用できません。']
];

for (const [code, expected] of KNOWN_PROMPT_SUBMIT_ERRORS) {
  test(`describePromptSubmitError: ${code} → 既定の文言`, () => {
    const fn = loadDescribePromptSubmitError();
    assert.equal(fn(code), expected);
  });
}

test('describePromptSubmitError: 未知のコード・undefinedは既定の送信失敗文言(fallback)', () => {
  const fn = loadDescribePromptSubmitError();
  assert.equal(fn('some_unknown_code'), '指示を送信できませんでした。');
  assert.equal(fn(undefined), '指示を送信できませんでした。');
});

test("input listener: promptSending中は文字入力してもaction buttonを再有効化しない", () => {
  const idx = page.indexOf("$('prompt').addEventListener('input',function(){");
  assert.ok(idx > 0, 'prompt input listener not found');
  const chunk = page.slice(idx, idx + 250);
  assert.match(chunk, /blocked\|\|\s*starting\|\|\s*imageUploading\|\|\s*promptSending\|\|\s*!this\.value\.trim\(\)/);
});

test('cleanup(): promptSending=false/finishing=falseを設定する(Live終了・接続失敗後に送信中・終了中状態を残さない)', () => {
  const idx = page.indexOf('function cleanup(){stopVideoDiagnostics();');
  assert.ok(idx > 0, 'cleanup() not found');
  const chunk = page.slice(idx, idx + 240);
  assert.match(chunk, /function cleanup\(\)\{stopVideoDiagnostics\(\);live=false;starting=false;promptSending=false;finishing=false;promptCommands=Object\.create\(null\);document\.body\.classList\.remove\('live-mode'\);/);
});

test('approve-prompt APIルート呼び出しはPOSTのまま維持する', () => {
  const src = extractSendPromptSource(page);
  assert.match(src, /api\('\/api\/h3-director\/approve-prompt',\{/);
  assert.match(src, /method:'POST',/);
  assert.match(src, /sessionId:sessionId,/);
  assert.match(src, /prompt:prompt/);
});

// ---------------------------------------------------------------
// D. 自然終了(natural:true)時だけ録画drain待ちを行う
//    (fal生成時間60秒・credits・API・DBは変更しない)
// ---------------------------------------------------------------

function extractFinishSource() {
  const startIndex = page.indexOf('async function finish(message,options){');
  assert.ok(startIndex > 0, 'finish() not found in h3-director.html');
  return extractFunctionSource(page, startIndex + 'async '.length);
}

function extractWaitForPlaybackDrainSource() {
  const startIndex = page.indexOf('async function waitForPlaybackDrain(){');
  assert.ok(startIndex > 0, 'waitForPlaybackDrain() not found in h3-director.html');
  return extractFunctionSource(page, startIndex + 'async '.length);
}

test('finishingが状態変数として宣言されている(初期値false)', () => {
  assert.match(
    page,
    /var expiresAt=0,live=false,starting=false,blocked=false,heartbeatFailures=0,authToken='',promptSending=false,finishing=false;/
  );
});

test('finish(): finishing中はearly returnし、二重実行を拒否する', () => {
  const src = extractFinishSource();
  assert.match(src, /if\(\(!live&&!starting\)\|\|finishing\)return;/);
  assert.match(src, /finishing=true;/);
});

test('cleanup(): finishing=falseへ戻す', () => {
  assert.match(page, /function cleanup\(\)\{stopVideoDiagnostics\(\);live=false;starting=false;promptSending=false;finishing=false;/);
});

test('waitForPlaybackDrain()が存在し、最大15秒でループを終える', () => {
  const src = extractWaitForPlaybackDrainSource();
  assert.match(src, /var startedAt=Date\.now\(\);/);
  assert.match(src, /while\(Date\.now\(\)-startedAt<15000\)\{/);
  assert.match(src, /diagnostic\(\s*'recording drain timeout: currentTime='\+/);
});

test('waitForPlaybackDrain(): video.currentTimeの進行を監視し、進んでいれば継続する', () => {
  const src = extractWaitForPlaybackDrainSource();
  assert.match(src, /var lastTime=Number\(videoEl\.currentTime\|\|0\);/);
  assert.match(src, /var current=Number\(videoEl\.currentTime\|\|0\);/);
  assert.match(src, /if\(current>lastTime\+0\.02\)\{\s*lastTime=current;\s*lastMovedAt=Date\.now\(\);\s*continue;\s*\}/);
});

test('waitForPlaybackDrain(): currentTimeが約2秒以上進まなければ「吐き切った」とみなして終了する', () => {
  const src = extractWaitForPlaybackDrainSource();
  assert.match(src, /if\(Date\.now\(\)-lastMovedAt>=2000\)\{/);
  assert.match(src, /diagnostic\(\s*'recording drain settled: currentTime='\+/);
  assert.match(src, /return;/);
});

test('waitForPlaybackDrain(): fal/API/DBへの新規リクエストを一切送っていない(currentTime監視のみ)', () => {
  const src = extractWaitForPlaybackDrainSource();
  assert.doesNotMatch(src, /api\(/);
  assert.doesNotMatch(src, /sendControl\(/);
  assert.doesNotMatch(src, /fetch\(/);
});

test("updateTimer()の60秒終了はfinish(...,{natural:true})を呼ぶ", () => {
  assert.match(page, /if\(left<=0&&live\)finish\('60秒のライブが終了しました。',\{natural:true\}\)/);
});

test('stream_exhausted: session_limitはnatural:trueを付け、それ以外は付けない', () => {
  const idx = page.indexOf("if(msg.type==='stream_exhausted'){");
  assert.ok(idx > 0, 'stream_exhausted handler not found');
  const chunk = page.slice(idx, idx + 700);
  assert.match(chunk, /if\(streamEndedReason==='session_limit'\)\{\s*finish\(exhaustedMessage,\{natural:true\}\);\s*\}else\{\s*finish\(exhaustedMessage\);\s*\}/);
});

test('手動停止ボタンはnatural:trueを付けない(即時終了のまま)', () => {
  assert.match(page, /\$\('stop'\)\.addEventListener\('click',function\(\)\{finish\('ライブを終了しました。'\)\}\);/);
});

test('WebRTC failed/closedはnatural:trueを付けない(即時終了のまま)', () => {
  const idx = page.indexOf('pc.onconnectionstatechange=function(){');
  assert.ok(idx > 0, 'onconnectionstatechange not found');
  const chunk = page.slice(idx, idx + 300);
  assert.match(chunk, /if\(\['failed','closed'\]\.includes\(pc\.connectionState\)&&live\)finish\('WebRTC接続が終了しました。自動再生成は行いません。'\)/);
  assert.doesNotMatch(chunk, /natural:true/);
});

test('heartbeat失敗(account_restricted/3回失敗)はnatural:trueを付けない(即時終了のまま)', () => {
  const idx = page.indexOf('async function heartbeat(){');
  assert.ok(idx > 0, 'heartbeat() not found');
  const chunk = page.slice(idx, page.indexOf('async function start('));
  assert.match(chunk, /await finish\('ライブセッションが終了しました。'\)/);
  assert.match(chunk, /await finish\('アカウント状態の変更によりライブを終了しました。'\)/);
  assert.match(chunk, /await finish\('接続を維持できなかったためライブを終了しました。自動再生成は行いません。'\)/);
  assert.doesNotMatch(chunk, /natural:true/);
});

test('finish(): natural:true(自然終了)の場合はdrain前にcontrol stopを送らない', () => {
  const src = extractFinishSource();
  const naturalIdx = src.indexOf('if(natural){');
  const elseIdx = src.indexOf('}else{');
  assert.ok(naturalIdx > 0 && elseIdx > naturalIdx, 'natural/else branches not found');
  const naturalBlock = src.slice(naturalIdx, elseIdx);
  assert.match(naturalBlock, /await waitForPlaybackDrain\(\);/);
  assert.doesNotMatch(naturalBlock, /control\.send/);
  assert.doesNotMatch(naturalBlock, /type:'stop'/);
});

test('finish(): natural:falseの即時終了では従来どおりcontrol stopを送る', () => {
  const src = extractFinishSource();
  const elseIdx = src.indexOf('}else{');
  const elseEndIdx = src.indexOf('live=false;', elseIdx);
  assert.ok(elseIdx > 0 && elseEndIdx > elseIdx, 'else branch not found');
  const elseBlock = src.slice(elseIdx, elseEndIdx);
  assert.match(elseBlock, /if\(control&&control\.readyState==='open'\)control\.send\(JSON\.stringify\(\{type:'stop'\}\)\)/);
});

test('finish(): MediaRecorder停止(stopRecording)・end-session・cleanup・saveRecording/loadHistoryの流れは維持されている', () => {
  const src = extractFinishSource();
  assert.match(src, /var recording=await stopRecording\(\);/);
  assert.match(src, /api\('\/api\/h3-director\/end-session',\{method:'POST',body:JSON\.stringify\(\{sessionId:endingSession\}\),keepalive:true\}\)/);
  assert.match(src, /cleanup\(\);/);
  assert.match(src, /if\(recording&&endingSession\)await saveRecording\(recording,endingSession\);else await loadHistory\(\)/);
});

test('finish(): fal生成時間・credits・DBへの新規呼び出しを追加していない(既存API呼び出しのみ)', () => {
  const src = extractFinishSource();
  // Only the pre-existing end-session call; no new fal/credits/DB calls added.
  const apiCalls = src.match(/api\('\/api\/[^']+'/g) || [];
  assert.deepEqual(apiCalls, ["api('/api/h3-director/end-session'"]);
});
