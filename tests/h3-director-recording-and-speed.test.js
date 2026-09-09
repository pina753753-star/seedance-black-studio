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

test('pc.ontrackからmaybeStartRecording()が削除されている（映像表示のみ維持）', () => {
  assert.match(
    page,
    /pc\.ontrack=function\(event\)\{remoteStream\.addTrack\(event\.track\);\$\('empty'\)\.style\.display='none';\$\('video'\)\.play\(\)\.catch\(function\(\)\{notice\('映像をタップすると音声付きで再生できます。'\)\}\)\};/
  );
  assert.doesNotMatch(
    page,
    /pc\.ontrack=function\(event\)\{[^}]*maybeStartRecording/
  );
});

test('Live開始成功直後からmaybeStartRecording()が削除されている（state(\'LIVE\')は維持）', () => {
  const idx = page.indexOf("live=true;starting=false;heartbeatFailures=0;document.body.classList.add('live-mode');");
  assert.ok(idx > 0, 'live start success line not found');
  const chunk = page.slice(idx, idx + 400);
  assert.match(chunk, /state\('LIVE'\);/);
  assert.doesNotMatch(chunk, /state\('LIVE'\);maybeStartRecording\(\)/);
});

test("msg.type==='chunk'でmaybeStartRecording()が呼ばれる", () => {
  assert.match(page, /if\(msg\.type==='chunk'\)maybeStartRecording\(\);/);
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
    /var configureMsg=\{type:'configure',protocol_version:1,prompt_version:1,prompt:directorPrompt\(prompt\),resolution:'768p',aspect_ratio:aspectRatio,memory:12\};/
  );
});

test('Live中の追加promptはdirectorPrompt(approved.prompt)を使用する', () => {
  assert.match(
    page,
    /sendControl\(\{type:'prompt',prompt_version:approved\.promptVersion,prompt:directorPrompt\(approved\.prompt\),replan:true\}\);/
  );
});

test('approve-promptへ送る元promptはユーザー入力のまま変更なし', () => {
  assert.match(
    page,
    /api\('\/api\/h3-director\/approve-prompt',\{method:'POST',body:JSON\.stringify\(\{sessionId:sessionId,prompt:prompt\}\)\}\)/
  );
});

test("log(prompt,'user')は元のユーザー入力のまま維持されている(directorPromptの補助文を表示しない)", () => {
  assert.match(
    page,
    /sendControl\(\{type:'prompt',prompt_version:approved\.promptVersion,prompt:directorPrompt\(approved\.prompt\),replan:true\}\);log\(prompt,'user'\);/
  );
});

test('memory:12は無変更', () => {
  assert.match(page, /memory:12/);
});

test('placeholderから「ゆっくり」を誘導する文言が削除されている', () => {
  const textareaMatch = page.match(/<textarea id="prompt"[^>]*placeholder="([^"]*)"/);
  assert.ok(textareaMatch, 'prompt textarea placeholder not found');
  assert.doesNotMatch(textareaMatch[1], /ゆっくり/);
});

test('acceleration / chunk_duration などの未公開パラメータを追加していない', () => {
  assert.doesNotMatch(page, /acceleration/i);
  assert.doesNotMatch(page, /chunk_duration/i);
});
