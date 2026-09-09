'use strict';

// H3 Max Live: Preview-only chunk/timing diagnostics to numerically diagnose
// the "60 seconds live but ~46 seconds saved" / "video feels slow" reports —
// observation only. No 60-second timer, expiresAt, credits, recording-start
// condition, directorPrompt, configure schema, WebRTC, or API behavior is
// changed by this file's target code. Purely a static-source check on
// h3-director.html plus a standalone evaluation of isPreviewHost()/
// diagnostic() extracted from the file — no server call, no Supabase, no
// fal, no credits.

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

function loadIsPreviewHost(hostname) {
  const startIndex = page.indexOf('function isPreviewHost()');
  assert.ok(startIndex > 0, 'isPreviewHost() not found in h3-director.html');
  const source = extractFunctionSource(page, startIndex);
  const sandbox = { location: { hostname } };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\nthis.isPreviewHost = isPreviewHost;`, sandbox);
  return sandbox.isPreviewHost;
}

// ---------------------------------------------------------------
// isPreviewHost / diagnostic gating
// ---------------------------------------------------------------

test('isPreviewHost: 本番ホスト(flowvid-studio.vercel.app)はfalse', () => {
  const isPreviewHost = loadIsPreviewHost('flowvid-studio.vercel.app');
  assert.equal(isPreviewHost(), false);
});

test('isPreviewHost: Previewの*.vercel.appはtrue', () => {
  const isPreviewHost = loadIsPreviewHost('feat-h3-max-live-abc123.vercel.app');
  assert.equal(isPreviewHost(), true);
});

test('isPreviewHost: pinastudio.jp(カスタムドメイン本番)もfalse', () => {
  const isPreviewHost = loadIsPreviewHost('pinastudio.jp');
  assert.equal(isPreviewHost(), false);
});

test('isPreviewHost: localhostもfalse', () => {
  const isPreviewHost = loadIsPreviewHost('localhost');
  assert.equal(isPreviewHost(), false);
});

test('diagnostic()はisPreviewHost()がfalseなら何もしない(early return)', () => {
  assert.match(
    page,
    /function diagnostic\(text\)\{\s*if\(!isPreviewHost\(\)\)return;\s*log\('\[診断\] '\+text,'system'\);\s*\}/
  );
});

// ---------------------------------------------------------------
// state reset on start()
// ---------------------------------------------------------------

test('計測変数(liveStartRequestedAt/firstChunkAt/chunkPlaybackTotal/chunkRequestedTotal)が宣言されている', () => {
  assert.match(
    page,
    /var liveStartRequestedAt=0,firstChunkAt=0,chunkPlaybackTotal=0,chunkRequestedTotal=0,diagnosticSummaryShown=false;/
  );
});

test('start()の実処理直前で計測変数がリセットされる', () => {
  const idx = page.indexOf('liveStartRequestedAt=Date.now();');
  assert.ok(idx > 0, 'reset line not found');
  const chunk = page.slice(idx, idx + 200);
  assert.match(chunk, /liveStartRequestedAt=Date\.now\(\);firstChunkAt=0;chunkPlaybackTotal=0;chunkRequestedTotal=0;diagnosticSummaryShown=false;/);
  // Reset happens right before the actual "starting" flag flips — i.e. right
  // before the real live-start processing begins, not before validation.
  assert.match(chunk, /starting=true;/);
});

// ---------------------------------------------------------------
// session_info / configured diagnostics
// ---------------------------------------------------------------

test('session_infoメッセージからfps/chunk長/acceleration/continuationを診断表示する', () => {
  assert.match(
    page,
    /if\(msg\.type==='session_info'\)\{\s*diagnostic\(\s*'session: fps='\+msg\.fps\+\s*' \/ defaultChunk='\+msg\.default_chunk_duration\+'s'\+\s*' \/ min='\+msg\.min_chunk_duration\+'s'\+\s*' \/ max='\+msg\.max_chunk_duration\+'s'\+\s*' \/ acceleration='\+msg\.default_acceleration\+\s*' \/ continuation='\+msg\.continuation_playback_seconds\+'s'\s*\);\s*\}/
  );
});

test('configuredメッセージのchunk_duration/acceleration/memory/resolution/ratioを診断表示する（既存の初期画像確認は維持）', () => {
  const idx = page.indexOf("if(msg.type==='configured'){");
  assert.ok(idx > 0, 'configured handler not found');
  const chunk = page.slice(idx, idx + 700);
  assert.match(chunk, /if\(sessionExpectsImage&&msg\.has_initial_image!==true\)\{finish\('添付画像を開始フレームとして確認できなかったため停止しました。'\);return\}/);
  assert.match(
    chunk,
    /diagnostic\(\s*'configured: chunk='\+msg\.chunk_duration\+'s'\+\s*' \/ acceleration='\+msg\.acceleration\+\s*' \/ memory='\+msg\.memory\+\s*' \/ resolution='\+msg\.resolution\+\s*' \/ ratio='\+msg\.aspect_ratio\s*\);/
  );
});

// ---------------------------------------------------------------
// chunk diagnostics
// ---------------------------------------------------------------

test('初回chunkのみfirstChunkAtを記録し到着秒数を診断表示する', () => {
  assert.match(
    page,
    /if\(!firstChunkAt\)\{\s*firstChunkAt=Date\.now\(\);\s*diagnostic\(\s*'first chunk到着まで '\+\s*\(\(firstChunkAt-liveStartRequestedAt\)\/1000\)\.toFixed\(1\)\+\s*'秒'\s*\);\s*\}/
  );
});

test('chunkごとにrequested/playback累計を加算する', () => {
  assert.match(page, /chunkRequestedTotal\+=Number\(msg\.requested_duration_seconds\)\|\|0;/);
  assert.match(page, /chunkPlaybackTotal\+=Number\(msg\.playback_seconds\)\|\|0;/);
});

test('chunkごとにrequested/playback/generation/buffer/estimate/frames/routeを診断表示する', () => {
  assert.match(
    page,
    /diagnostic\(\s*'chunk #'\+msg\.chunk_index\+\s*': requested='\+msg\.requested_duration_seconds\+'s'\+\s*' \/ playback='\+Number\(msg\.playback_seconds\|\|0\)\.toFixed\(2\)\+'s'\+\s*' \/ generation='\+Number\(msg\.generation_seconds\|\|0\)\.toFixed\(2\)\+'s'\+\s*' \/ buffer='\+Number\(msg\.buffer_depth_seconds\|\|0\)\.toFixed\(2\)\+'s'\+\s*' \/ estimate='\+Number\(msg\.next_generation_estimate_seconds\|\|0\)\.toFixed\(2\)\+'s'\+\s*' \/ frames='\+msg\.generated_frame_count\+\s*' \/ route='\+msg\.route\s*\);/
  );
});

test('chunk受信のたびにrequested/playback累計を診断表示する', () => {
  assert.match(
    page,
    /diagnostic\(\s*'累計: requested='\+chunkRequestedTotal\.toFixed\(2\)\+'s'\+\s*' \/ playback='\+chunkPlaybackTotal\.toFixed\(2\)\+'s'\s*\);/
  );
});

// ---------------------------------------------------------------
// deadline_missed diagnostics
// ---------------------------------------------------------------

test('deadline_missedはchunk_index/late_by_seconds/behaviorを診断表示する（既存ユーザー向けメッセージは維持）', () => {
  const idx = page.indexOf("if(msg.type==='deadline_missed'){");
  assert.ok(idx > 0, 'deadline_missed handler not found');
  const chunk = page.slice(idx, idx + 400);
  assert.match(chunk, /log\('生成が追いつくまで映像を調整しています。'\);/);
  assert.match(
    chunk,
    /diagnostic\(\s*'deadline missed: chunk #'\+msg\.chunk_index\+\s*' \/ late='\+Number\(msg\.late_by_seconds\|\|0\)\.toFixed\(2\)\+'s'\+\s*' \/ behavior='\+msg\.behavior\s*\);/
  );
});

// ---------------------------------------------------------------
// summary on finish()
// ---------------------------------------------------------------

test('finish()はPreview限定・一度だけサマリーを表示する', () => {
  assert.match(
    page,
    /async function finish\(message\)\{if\(!live&&!starting\)return;if\(!diagnosticSummaryShown\)\{diagnosticSummaryShown=true;diagnostic\('summary: firstChunk='\+\(firstChunkAt\?\(\(firstChunkAt-liveStartRequestedAt\)\/1000\)\.toFixed\(1\):'なし'\)\+'s \/ requested='\+chunkRequestedTotal\.toFixed\(2\)\+'s \/ playback='\+chunkPlaybackTotal\.toFixed\(2\)\+'s'\)\}/
  );
});

// ---------------------------------------------------------------
// Untouched invariants (60s timer / expiresAt / credits / recording start / directorPrompt)
// ---------------------------------------------------------------

test('60秒タイマー・expiresAt処理は無変更', () => {
  assert.match(page, /id="timer">60秒<\/span>/);
  assert.match(page, /function updateTimer\(\)\{var left=Math\.max\(0,Math\.ceil\(\(expiresAt-Date\.now\(\)\)\/1000\)\);/);
  assert.match(page, /if\(left<=0&&live\)finish\('60秒のライブが終了しました。'\)/);
});

test('440クレジット表示・directorPromptロジックは無変更', () => {
  assert.match(page, /60秒 \/ 768p \/ 440クレジット/);
  assert.match(page, /function directorPrompt\(text\)\{/);
});

test('録画開始条件(最初のchunkでmaybeStartRecording)は本タスクでも維持', () => {
  assert.match(page, /if\(msg\.type==='chunk'\)\{/);
  const idx = page.indexOf("if(msg.type==='chunk'){");
  const chunk = page.slice(idx, page.indexOf("if(msg.type==='error')"));
  assert.match(chunk, /maybeStartRecording\(\);/);
});
