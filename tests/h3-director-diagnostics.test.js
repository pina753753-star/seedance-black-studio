'use strict';

// H3 Max Live: heartbeat.js endReason diagnostics (why a live session ended:
// pina_expired / provider_not_alive / null-when-alive). Server-side only —
// no real Supabase, no real fal, no credits. Uses the same in-memory db mock
// shape as the existing heartbeat tests in
// tests/h3-director-preview-db-boundary.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.FAL_KEY = process.env.FAL_KEY || 'test-fal-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';

const repoRoot = path.join(__dirname, '..');
const confirmedAuthPath = path.join(repoRoot, 'api', '_lib', 'confirmed-auth.js');
const directorStorePath = path.join(repoRoot, 'api', '_lib', 'h3-director-store.js');
const directorConfigPath = path.join(repoRoot, 'api', '_lib', 'h3-director-config.js');
const directorFalPath = path.join(repoRoot, 'api', '_lib', 'h3-director-fal.js');
const heartbeatPath = path.join(repoRoot, 'api', 'h3-director', 'heartbeat.js');

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function makeSessionDb(initial) {
  let current = { ...initial };
  return {
    get current() { return current; },
    from(table) {
      assert.equal(table, 'h3_director_sessions');
      const filters = [];
      let update = null;
      const q = {
        select() { return q; },
        eq(col, val) { filters.push(['eq', col, val]); return q; },
        in(col, vals) { filters.push(['in', col, vals]); return q; },
        update(data) { update = data; return q; },
        async maybeSingle() {
          const matched = filters.every(([op, col, val]) => (op === 'eq' ? current[col] === val : val.includes(current[col])));
          if (!matched) return { data: null, error: null };
          if (update) Object.assign(current, update);
          return { data: { ...current }, error: null };
        },
        then(resolve, reject) {
          try {
            const matched = filters.every(([op, col, val]) => (op === 'eq' ? current[col] === val : val.includes(current[col])));
            if (matched && update) Object.assign(current, update);
            return Promise.resolve({ data: matched ? [{ ...current }] : [], error: null }).then(resolve, reject);
          } catch (e) { return Promise.reject(e).then(resolve, reject); }
        }
      };
      return q;
    }
  };
}

function loadHeartbeatWithMocks({ upstream }) {
  const fakeConfirmedAuth = {
    id: confirmedAuthPath, filename: confirmedAuthPath, loaded: true,
    exports: { requireConfirmedAuth: async (req) => req._auth }
  };
  const fakeDirectorStore = {
    id: directorStorePath, filename: directorStorePath, loaded: true,
    exports: {
      jsonBody: (req) => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})),
      isUuid: (v) => /^[0-9a-f-]{36}$/.test(String(v || '')),
      publicSession: (row) => ({ id: row.id, status: row.status }),
      checkDirectorEnabled: async () => ({ ok: true }),
      getDirectorEntitlement: async () => ({ ok: true, allowed: true, accountStatus: 'active' })
    }
  };
  const fakeDirectorFal = {
    id: directorFalPath, filename: directorFalPath, loaded: true,
    exports: { heartbeatDirectorSession: async () => upstream }
  };
  const fakeDirectorConfig = {
    id: directorConfigPath, filename: directorConfigPath, loaded: true,
    exports: { ALLOWED_PLANS: ['premium', 'scale', 'team', 'ultimate'] }
  };
  const prev = {
    confirmedAuth: require.cache[confirmedAuthPath],
    directorStore: require.cache[directorStorePath],
    directorFal: require.cache[directorFalPath],
    directorConfig: require.cache[directorConfigPath]
  };
  require.cache[confirmedAuthPath] = fakeConfirmedAuth;
  require.cache[directorStorePath] = fakeDirectorStore;
  require.cache[directorFalPath] = fakeDirectorFal;
  require.cache[directorConfigPath] = fakeDirectorConfig;
  delete require.cache[heartbeatPath];
  const handler = require(heartbeatPath);
  return {
    handler,
    restore() {
      require.cache[confirmedAuthPath] = prev.confirmedAuth;
      require.cache[directorStorePath] = prev.directorStore;
      require.cache[directorFalPath] = prev.directorFal;
      require.cache[directorConfigPath] = prev.directorConfig;
      delete require.cache[heartbeatPath];
    }
  };
}

function heartbeatReqRes(db) {
  const req = {
    method: 'POST', headers: {}, body: JSON.stringify({ sessionId: SESSION_ID }),
    _auth: { ok: true, user: { id: USER_ID }, supabase: db }
  };
  const res = {
    statusCode: 0, payload: null, setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(v) { this.payload = v; return this; }
  };
  return { req, res };
}

test('heartbeat: Pina期限切れ(expiresMs超過) → expired=true / endReason=pina_expired / remainingSeconds=0', async () => {
  const db = makeSessionDb({
    id: SESSION_ID, user_id: USER_ID, status: 'live', provider_session_id: 'fal-1',
    expires_at: new Date(Date.now() - 5000).toISOString(), heartbeat_count: 0
  });
  const { handler, restore } = loadHeartbeatWithMocks({ upstream: { ok: true, alive: true } });
  try {
    const { req, res } = heartbeatReqRes(db);
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.alive, false);
    assert.equal(res.payload.expired, true);
    assert.equal(res.payload.endReason, 'pina_expired');
    assert.equal(res.payload.remainingSeconds, 0);
  } finally { restore(); }
});

test('heartbeat: providerがalive=false → expired=false / endReason=provider_not_alive / remainingSecondsを返す', async () => {
  const db = makeSessionDb({
    id: SESSION_ID, user_id: USER_ID, status: 'live', provider_session_id: 'fal-1',
    expires_at: new Date(Date.now() + 30000).toISOString(), heartbeat_count: 0
  });
  const { handler, restore } = loadHeartbeatWithMocks({ upstream: { ok: true, alive: false } });
  try {
    const { req, res } = heartbeatReqRes(db);
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.alive, false);
    assert.equal(res.payload.expired, false);
    assert.equal(res.payload.endReason, 'provider_not_alive');
    assert.ok(res.payload.remainingSeconds > 0);
  } finally { restore(); }
});

test('heartbeat: alive=true → endReason=null（既存フィールドは維持）', async () => {
  const db = makeSessionDb({
    id: SESSION_ID, user_id: USER_ID, status: 'live', provider_session_id: 'fal-1',
    expires_at: new Date(Date.now() + 30000).toISOString(), heartbeat_count: 0
  });
  const { handler, restore } = loadHeartbeatWithMocks({ upstream: { ok: true, alive: true } });
  try {
    const { req, res } = heartbeatReqRes(db);
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.alive, true);
    assert.equal(res.payload.endReason, null);
    assert.ok(res.payload.remainingSeconds > 0);
    assert.ok(res.payload.session);
  } finally { restore(); }
});

test('heartbeat: DB更新条件(status/ended_at/finished_at)は既存のまま', () => {
  const fs = require('fs');
  const src = fs.readFileSync(heartbeatPath, 'utf8');
  assert.match(src, /status: 'completed', ended_at: ended, finished_at: ended, updated_at: ended/);
  assert.match(src, /status: 'live',\s*last_heartbeat_at: now\.toISOString\(\),\s*heartbeat_count: Number\(session\.heartbeat_count \|\| 0\) \+ 1,/);
});

// ---------------------------------------------------------------
// h3-director.html: stream_exhausted / chunk_metrics / session_metrics /
// browser heartbeat() diagnostics, and WebRTC/DataChannel state diagnostics.
// Static-source checks only (same style as tests/h3-director-preview-diagnostics.test.js).
// ---------------------------------------------------------------

const fs = require('fs');
const page = fs.readFileSync(path.join(repoRoot, 'h3-director.html'), 'utf8');

test('stream_exhausted: reason/chunksを診断し、reasonに応じたユーザー表示でfinish()する(session_limitはnatural:true)', () => {
  const idx = page.indexOf("if(msg.type==='stream_exhausted'){");
  assert.ok(idx > 0, 'stream_exhausted handler not found');
  const chunk = page.slice(idx, idx + 700);
  assert.match(chunk, /streamEndedReason=String\(msg\.reason\|\|'unknown'\);/);
  assert.match(chunk, /diagnostic\('stream exhausted: reason='\+streamEndedReason\+' \/ chunks='\+Number\(msg\.chunks\|\|0\)\);/);
  assert.match(chunk, /streamEndedReason==='session_limit'\s*\?'ライブ生成の上限に達しました。'\s*:'ライブ生成が終了しました。';/);
  assert.match(chunk, /if\(streamEndedReason==='session_limit'\)\{\s*finish\(exhaustedMessage,\{natural:true\}\);\s*\}else\{\s*finish\(exhaustedMessage\);\s*\}/);
});

test('chunk_metrics: Preview限定でready/interval/routeを診断する（phases_ms/gaugesは展開しない）', () => {
  const idx = page.indexOf("if(msg.type==='chunk_metrics'){");
  assert.ok(idx > 0, 'chunk_metrics handler not found');
  const chunk = page.slice(idx, idx + 300);
  assert.match(chunk, /diagnostic\(\s*'chunk metrics #'\+chunkMetricsCount\+\s*': ready='\+msg\.ready_ms\+'ms'\+\s*' \/ interval='\+msg\.interval_ms\+'ms'\+\s*' \/ route='\+msg\.route\s*\);/);
  assert.doesNotMatch(chunk, /phases_ms/);
  assert.doesNotMatch(chunk, /gauges/);
});

test('session_metrics: session_wall_msをlastSessionWallMsへ記録しfinal/history込みで診断する', () => {
  const idx = page.indexOf("if(msg.type==='session_metrics'){");
  assert.ok(idx > 0, 'session_metrics handler not found');
  const chunk = page.slice(idx, idx + 350);
  assert.match(chunk, /lastSessionWallMs=Number\(msg\.session_wall_ms\)\|\|0;/);
  assert.match(chunk, /' \/ final='\+\(msg\.final===true\)\+/);
  assert.match(chunk, /' \/ history='\+msg\.history_index\+'\/'\+msg\.history_count/);
});

test('browser heartbeat(): 成功ごとにheartbeatCount/lastHeartbeatAtを更新し、alive=falseでは必ずendReason診断を出す', () => {
  const idx = page.indexOf('async function heartbeat(){');
  assert.ok(idx > 0, 'heartbeat() not found');
  const chunk = page.slice(idx, page.indexOf('async function start('));
  assert.match(chunk, /heartbeatFailures=0;heartbeatCount\+\+;lastHeartbeatAt=Date\.now\(\);/);
  assert.match(chunk, /if\(!data\.alive\)\{diagnostic\('heartbeat end: reason='\+\(data\.endReason\|\|'unknown'\)\+' \/ expired='\+\(data\.expired===true\)\+' \/ remaining='\+\(data\.remainingSeconds!=null\?data\.remainingSeconds:'なし'\)\+' \/ \+'\+\(elapsedFromStart\(lastHeartbeatAt\)\|\|0\)\.toFixed\(1\)\+'s'\);await finish\('ライブセッションが終了しました。'\)\}/);
  assert.match(chunk, /else if\(heartbeatCount%2===0\)\{diagnostic\('heartbeat #'\+heartbeatCount\+': alive=true \/ remaining='\+data\.remainingSeconds\)\}/);
  assert.match(chunk, /diagnostic\('heartbeat error: code='\+\(e\.code\|\|'unknown'\)\+' \/ failures='\+heartbeatFailures\);/);
});

test('WebRTC/DataChannel: 全state transitionを診断し、既存failed/closed→finish挙動は変更していない', () => {
  const idx = page.indexOf('pc.onconnectionstatechange=function(){');
  assert.ok(idx > 0, 'onconnectionstatechange not found');
  const chunk = page.slice(idx, idx + 250);
  assert.match(chunk, /diagnostic\('webrtc state: '\+\(pc\?pc\.connectionState:'unknown'\)\);/);
  assert.match(chunk, /if\(\['failed','closed'\]\.includes\(pc\.connectionState\)&&live\)finish\('WebRTC接続が終了しました。自動再生成は行いません。'\)/);
});

test('DataChannel onclose/onerrorは診断のみでfinish()を呼ばない', () => {
  assert.match(page, /control\.onclose=function\(\)\{diagnostic\('datachannel closed: \+'\+\(elapsedFromStart\(Date\.now\(\)\)\|\|0\)\.toFixed\(1\)\+'s'\)\};/);
  assert.match(page, /control\.onerror=function\(\)\{diagnostic\('datachannel error: \+'\+\(elapsedFromStart\(Date\.now\(\)\)\|\|0\)\.toFixed\(1\)\+'s'\)\};/);
  assert.doesNotMatch(page, /control\.onclose=function\(\)\{[^}]*finish\(/);
  assert.doesNotMatch(page, /control\.onerror=function\(\)\{[^}]*finish\(/);
});

test('recorder開始/停止の壁時計診断: recorderStartedAt/recorderStoppedAt/blobBytes/stopEventDelay', () => {
  assert.match(page, /recorder\.start\(1000\);recorderStartedAt=Date\.now\(\);diagnostic\('recorder start: \+'\+\(elapsedFromStart\(recorderStartedAt\)\|\|0\)\.toFixed\(1\)\+'s \/ afterFirstChunk='\+\(firstChunkAt\?\(\(recorderStartedAt-firstChunkAt\)\/1000\)\.toFixed\(1\):'なし'\)\+'s'\);/);
  assert.match(page, /recorderStoppedAt=Date\.now\(\);var wall=recorderStartedAt\?\(recorderStoppedAt-recorderStartedAt\)\/1000:0;/);
  assert.match(page, /diagnostic\('recorder stop: wall='\+wall\.toFixed\(2\)\+'s \/ chunks='\+recordChunks\.length\+' \/ blobBytes='\+\(blob\?blob\.size:0\)\+' \/ stopEventDelay='\+\(recorderStoppedAt-stopRequestedAt\)\+'ms'\);/);
  // Explicitly documented as wall-clock, not accurate file duration metadata.
  assert.match(page, /NOT the accurate\s*\n\s*\/\/ in-file duration metadata/);
});

test('録画開始条件(first chunkから700ms後にmaybeStartRecording)は今回も変更していない', () => {
  assert.match(page, /if\(msg\.type==='chunk'\)\{/);
  assert.match(page, /recordStartTimer=setTimeout\(function\(\)\{if\(!live\|\|recorder\|\|!remoteStream\|\|!remoteStream\.getVideoTracks\(\)\.length\)return;/);
  assert.match(page, /\},700\)\}/);
});

test('configure/prompt messageへchunk_duration・accelerationを追加送信していない', () => {
  const configureLine = page.slice(
    page.indexOf('var outgoingPrompt=directorPrompt(prompt);'),
    page.indexOf('if(initialImageUrlForConfigure)configureMsg.image_url')
  );
  assert.doesNotMatch(configureLine, /chunk_duration:/);
  assert.doesNotMatch(configureLine, /acceleration:/);
  const promptSendLine = page.slice(
    page.indexOf("sendControl({type:'prompt',prompt_version:approved.promptVersion"),
    page.indexOf("sendControl({type:'prompt',prompt_version:approved.promptVersion") + 200
  );
  assert.doesNotMatch(promptSendLine, /chunk_duration:/);
  assert.doesNotMatch(promptSendLine, /acceleration:/);
});

test('60秒設定・DURATION_SECONDSは今回変更していない', () => {
  const configSrc = fs.readFileSync(path.join(repoRoot, 'api', '_lib', 'h3-director-config.js'), 'utf8');
  assert.match(configSrc, /const DURATION_SECONDS = 60;/);
  assert.match(page, /id="timer">60秒<\/span>/);
  assert.match(page, /if\(left<=0&&live\)finish\('60秒のライブが終了しました。',\{natural:true\}\)/);
});

// ---------------------------------------------------------------
// Speed-diagnosis: video clock (requestVideoFrameCallback) + WebRTC getStats
// + playbackRate. Static-source checks only — no real WebRTC/video element
// is created; requestVideoFrameCallback/getStats/performance.now are never
// invoked by this test file.
// ---------------------------------------------------------------

test('requestVideoFrameCallbackを使うコードが存在し、非対応時はunavailableを1回だけ診断する', () => {
  assert.match(page, /function startVideoClockDiagnostics\(myGeneration\)\{/);
  assert.match(page, /typeof videoEl\.requestVideoFrameCallback!=='function'/);
  assert.match(page, /diagnostic\('video clock unavailable'\);/);
  assert.match(page, /videoEl\.requestVideoFrameCallback\(onFrame\)/);
});

test('video clock: wall/media/ratio/presentationFpsを計算し5秒ごとに診断する', () => {
  const idx = page.indexOf('function startVideoClockDiagnostics(myGeneration){');
  assert.ok(idx > 0, 'startVideoClockDiagnostics not found');
  const chunk = page.slice(idx, page.indexOf('function startWebrtcStatsDiagnostics'));
  assert.match(chunk, /if\(nowWall-videoClockLastLogAt>=5000\)\{/);
  assert.match(chunk, /var mediaElapsed=\(metadata\.mediaTime!=null&&videoClockBaseMedia!=null\)\?\(metadata\.mediaTime-videoClockBaseMedia\):null;/);
  assert.match(chunk, /lastVideoClockRatio=\(mediaElapsed!=null&&wallElapsed>0\)\?\(mediaElapsed\/wallElapsed\):null;/);
  assert.match(chunk, /var presentationFps=\(metadata\.presentedFrames!=null&&videoClockBasePresentedFrames!=null&&wallElapsed>0\)/);
  assert.match(chunk, /'video clock: wall='\+wallElapsed\.toFixed\(2\)\+'s'\+/);
  assert.match(chunk, /' \/ media='\+/);
  assert.match(chunk, /' \/ ratio='\+/);
  assert.match(chunk, /' \/ presentedFrames='\+/);
  assert.match(chunk, /' \/ presentationFps='\+/);
  assert.match(chunk, /' \/ rtpTimestamp='\+/);
  // Never falls over when a field is missing.
  assert.match(chunk, /try\{/);
  assert.match(chunk, /\}catch\(e\)\{\}/);
});

test('video clock: mediaTime/presentedFrames/expectedDisplayTime/rtpTimestampが存在しなくても例外にならない(基準値の初回保存)', () => {
  const idx = page.indexOf('if(videoClockBaseWall===null){');
  assert.ok(idx > 0, 'baseline capture not found');
  const chunk = page.slice(idx, idx + 600);
  assert.match(chunk, /videoClockBaseWall=performance\.now\(\);/);
  assert.match(chunk, /videoClockBaseMedia=metadata\.mediaTime!=null\?metadata\.mediaTime:null;/);
  assert.match(chunk, /videoClockBasePresentedFrames=metadata\.presentedFrames!=null\?metadata\.presentedFrames:null;/);
  assert.match(chunk, /videoClockBaseExpectedDisplayTime=metadata\.expectedDisplayTime!=null\?metadata\.expectedDisplayTime:null;/);
  assert.match(chunk, /videoClockBaseRtpTimestamp=metadata\.rtpTimestamp!=null\?metadata\.rtpTimestamp:null;/);
  // First frame also seeds videoClockLastLogAt to the baseline wall time, so
  // the very first onFrame call cannot immediately satisfy the 5s log gate.
  assert.match(chunk, /videoClockLastLogAt=videoClockBaseWall;/);
});

test('video clock: baseline取得直後は5秒診断条件を満たさない構造になっている', () => {
  const idx = page.indexOf('function startVideoClockDiagnostics(myGeneration){');
  const chunk = page.slice(idx, page.indexOf('function startWebrtcStatsDiagnostics'));
  const baseIdx = chunk.indexOf('if(videoClockBaseWall===null){');
  const gateIdx = chunk.indexOf('if(nowWall-videoClockLastLogAt>=5000){');
  assert.ok(baseIdx > 0 && gateIdx > baseIdx, 'baseline capture must run before the 5s log gate check');
  assert.match(chunk, /videoClockLastLogAt=videoClockBaseWall;[\s\S]*if\(metadata\.presentedFrames!=null\)lastPresentedFrames=metadata\.presentedFrames;[\s\S]*var nowWall=performance\.now\(\);/);
});

test('getStats(): kind=video のinbound-rtpを探し、framesPerSecond/framesDecoded/framesDroppedを読む', () => {
  const idx = page.indexOf('function startWebrtcStatsDiagnostics(myGeneration){');
  assert.ok(idx > 0, 'startWebrtcStatsDiagnostics not found');
  const chunk = page.slice(idx, idx + 2600);
  assert.match(chunk, /report\.type!=='inbound-rtp'\|\|report\.kind!=='video'/);
  assert.match(chunk, /if\(inbound\.framesPerSecond!=null\)parts\.push\('fps='\+inbound\.framesPerSecond\);/);
  assert.match(chunk, /if\(inbound\.framesReceived!=null\)parts\.push\('received='\+inbound\.framesReceived\);/);
  assert.match(chunk, /if\(inbound\.framesDecoded!=null\)parts\.push\('decoded='\+inbound\.framesDecoded\);/);
  assert.match(chunk, /if\(inbound\.framesDropped!=null\)parts\.push\('dropped='\+inbound\.framesDropped\);/);
});

test('getStats(): remoteStreamのvideo track.idとreport.trackIdentifierが一致するreportを優先し、一致しない場合はframesDecoded最大のreportを採用する', () => {
  const idx = page.indexOf('function startWebrtcStatsDiagnostics(myGeneration){');
  const chunk = page.slice(idx, idx + 2600);
  assert.match(chunk, /var videoTrackId=\(remoteStream&&remoteStream\.getVideoTracks\(\)\[0\]\)\?remoteStream\.getVideoTracks\(\)\[0\]\.id:null;/);
  assert.match(chunk, /var inbound=null,byTrackId=null,byMaxFramesDecoded=null;/);
  assert.match(chunk, /if\(videoTrackId&&report\.trackIdentifier===videoTrackId\)byTrackId=report;/);
  assert.match(chunk, /if\(!byMaxFramesDecoded\|\|\(Number\(report\.framesDecoded\|\|0\)>Number\(byMaxFramesDecoded\.framesDecoded\|\|0\)\)\)byMaxFramesDecoded=report;/);
  assert.match(chunk, /inbound=byTrackId\|\|byMaxFramesDecoded;/);
  assert.match(chunk, /if\(!inbound\)return;/);
});

test('getStats(): jitterBufferDelay/jitterBufferEmittedCountからjitterBufferAvgを計算する(計算不能時は省略)', () => {
  const idx = page.indexOf('function startWebrtcStatsDiagnostics(myGeneration){');
  const chunk = page.slice(idx, idx + 2600);
  assert.match(chunk, /var jitterBufferAvgMs=\(inbound\.jitterBufferDelay!=null&&inbound\.jitterBufferEmittedCount\)\s*\n\s*\?\(inbound\.jitterBufferDelay\/inbound\.jitterBufferEmittedCount\*1000\):null;/);
  assert.match(chunk, /if\(jitterBufferAvgMs!=null\)parts\.push\('jitterBufferAvg='\+jitterBufferAvgMs\.toFixed\(1\)\+'ms'\);/);
  assert.match(chunk, /var interFrameAvgMs=\(inbound\.totalInterFrameDelay!=null&&inbound\.framesDecoded!=null\)\s*\n\s*\?\(inbound\.totalInterFrameDelay\/Math\.max\(inbound\.framesDecoded-1,1\)\*1000\):null;/);
});

test('getStats(): IPアドレス・candidate address・token・session IDをログしない', () => {
  const idx = page.indexOf('function startWebrtcStatsDiagnostics(myGeneration){');
  const statsBlock = page.slice(idx, idx + 2600);
  assert.doesNotMatch(statsBlock, /candidate/i);
  assert.doesNotMatch(statsBlock, /address/i);
  assert.doesNotMatch(statsBlock, /\btoken\b/i);
  assert.doesNotMatch(statsBlock, /sessionId/);
  // Only inbound-rtp (video) and its referenced codec report are read.
  assert.match(statsBlock, /report\.type!=='inbound-rtp'/);
  assert.doesNotMatch(statsBlock, /report\.type==='candidate-pair'/);
  assert.doesNotMatch(statsBlock, /report\.type==='local-candidate'/);
  assert.doesNotMatch(statsBlock, /report\.type==='remote-candidate'/);
});

test('getStats()の呼び出しはtry/catchで守られ、失敗してもLiveを終了させない', () => {
  const idx = page.indexOf('function startWebrtcStatsDiagnostics(myGeneration){');
  const chunk = page.slice(idx, idx + 2600);
  assert.match(chunk, /pc\.getStats\(\)\.then\(function\(stats\)\{/);
  assert.match(chunk, /\}\)\.catch\(function\(\)\{\}\);/);
  assert.doesNotMatch(chunk, /finish\(/);
});

test('playbackRate/defaultPlaybackRateは読むだけで、書き換えるコードがない', () => {
  assert.match(page, /diagnostic\('video playback: rate='\+\$\('video'\)\.playbackRate\+' \/ default='\+\$\('video'\)\.defaultPlaybackRate\);/);
  assert.doesNotMatch(page, /\$\('video'\)\.playbackRate=/);
  assert.doesNotMatch(page, /\$\('video'\)\.defaultPlaybackRate=/);
});

test('finish()/cleanup()で診断用interval・rVFCループを必ず停止する(generationトークンで古いcallbackをガード)', () => {
  assert.match(page, /function stopVideoDiagnostics\(\)\{\s*diagnosticsGeneration\+\+;\s*if\(statsIntervalTimer\)\{clearInterval\(statsIntervalTimer\);statsIntervalTimer=null\}\s*\}/);
  assert.match(page, /function cleanup\(\)\{stopVideoDiagnostics\(\);/);
  // Both loops re-check myGeneration===diagnosticsGeneration (and `live`)
  // before doing anything, so a session that already ended cannot keep
  // logging via a callback that was already in flight.
  assert.match(page, /if\(myGeneration!==diagnosticsGeneration\|\|!live\)return;/);
  assert.match(page, /if\(myGeneration!==diagnosticsGeneration\|\|!live\|\|!pc\)return;/);
});

test('診断の開始呼び出しは既存heartbeatとは独立し、7秒間隔のgetStatsは頻度を抑えている', () => {
  assert.match(page, /\},7000\);/);
  assert.match(page, /startVideoClockDiagnostics\(myGeneration\);startWebrtcStatsDiagnostics\(myGeneration\)/);
});

// ---------------------------------------------------------------
// 診断ログのチャットからの分離: Preview専用の折りたたみパネルへ移す。
// 通常チャット#logは影響を受けない。static-source checksのみ。
// ---------------------------------------------------------------

test('diagnosticsWrap/diagnosticsToggle/diagnosticsPanel/diagnosticsLogがaside内、#logの直後・composerの前に配置されている', () => {
  const logIdx = page.indexOf('<div class="log" id="log"></div>');
  assert.ok(logIdx > 0, '#log not found');
  const composerIdx = page.indexOf('<div class="composer">');
  assert.ok(composerIdx > logIdx, '.composer not found after #log');
  const between = page.slice(logIdx, composerIdx);
  assert.match(between, /<div class="diagnostics-wrap" id="diagnosticsWrap" hidden>/);
  assert.match(between, /<button[^>]*id="diagnosticsToggle"[^>]*aria-expanded="false"[^>]*aria-controls="diagnosticsPanel"[^>]*>診断を見る<\/button>/);
  assert.match(between, /<div class="diagnostics-panel" id="diagnosticsPanel" hidden>/);
  assert.match(between, /<div id="diagnosticsLog"><\/div>/);
});

test('diagnosticsWrapは初期状態でhidden属性を持つ(HTML上の初期状態)', () => {
  const idx = page.indexOf('<div class="diagnostics-wrap" id="diagnosticsWrap"');
  assert.ok(idx > 0, 'diagnosticsWrap not found');
  const tagEnd = page.indexOf('>', idx);
  const openingTag = page.slice(idx, tagEnd + 1);
  assert.match(openingTag, /hidden/);
});

test('diagnosticsPanelも初期状態でhidden属性を持つ(初期状態は閉じている)', () => {
  const idx = page.indexOf('<div class="diagnostics-panel" id="diagnosticsPanel"');
  assert.ok(idx > 0, 'diagnosticsPanel not found');
  const tagEnd = page.indexOf('>', idx);
  const openingTag = page.slice(idx, tagEnd + 1);
  assert.match(openingTag, /hidden/);
});

test('isPreviewHost()の場合のみdiagnosticsWrap.hiddenをfalseにする(本番はhiddenのまま)', () => {
  assert.match(page, /if\(isPreviewHost\(\)\)\$\('diagnosticsWrap'\)\.hidden=false;/);
});

test('diagnosticsToggleクリックでdiagnosticsPanel.hiddenを切替え、textContent/aria-expandedを更新する', () => {
  const idx = page.indexOf("$('diagnosticsToggle').addEventListener('click',");
  assert.ok(idx > 0, 'diagnosticsToggle click handler not found');
  const chunk = page.slice(idx, idx + 400);
  assert.match(chunk, /var open=\$\('diagnosticsPanel'\)\.hidden;/);
  assert.match(chunk, /\$\('diagnosticsPanel'\)\.hidden=!open;/);
  assert.match(chunk, /\$\('diagnosticsToggle'\)\.textContent=open\?'診断を閉じる':'診断を見る';/);
  assert.match(chunk, /\$\('diagnosticsToggle'\)\.setAttribute\('aria-expanded',open\?'true':'false'\)/);
});

test('Live開始時・終了時にdiagnosticsPanelを勝手に開閉するコードがない', () => {
  assert.doesNotMatch(page, /diagnosticsPanel'\)\.hidden=false/);
  assert.doesNotMatch(page, /diagnosticsPanel'\)\.hidden=true(?!;.*click)/);
});

test('diagnostic()は通常チャットlog()を一切呼ばず、#diagnosticsLogへtextContentのみで追記する(innerHTML禁止)', () => {
  const idx = page.indexOf('function diagnostic(text){');
  assert.ok(idx > 0, 'diagnostic() not found');
  const chunk = page.slice(idx, idx + 400);
  assert.match(chunk, /if\(!isPreviewHost\(\)\)return;/);
  assert.match(chunk, /var root=\$\('diagnosticsLog'\);/);
  assert.match(chunk, /if\(!root\)return;/);
  assert.match(chunk, /var row=document\.createElement\('div'\);/);
  assert.match(chunk, /row\.className='diagnostic-line';/);
  assert.match(chunk, /row\.textContent='\[診断\] '\+text;/);
  assert.match(chunk, /root\.appendChild\(row\);/);
  assert.match(chunk, /root\.scrollTop=root\.scrollHeight/);
  assert.doesNotMatch(chunk, /\blog\(/);
  assert.doesNotMatch(chunk, /innerHTML/);
});

test('通常のlog()関数自体は変更されておらず、#logへtextContentで書き込む既存動作を維持している', () => {
  assert.match(page, /function log\(text,kind\)\{var el=document\.createElement\('div'\);el\.className='msg '\+\(kind\|\|'system'\);el\.textContent=text;\$\('log'\)\.appendChild\(el\);\$\('log'\)\.scrollTop=\$\('log'\)\.scrollHeight\}/);
});

test('通常チャット処理(ユーザー入力ログ・追加指示反映・エラー・保存・Live終了メッセージ)は今回変更していない', () => {
  assert.match(page, /log\(prompt,'user'\);/);
  assert.match(page, /log\('H3 Max Liveへ初期指示を送信しました。'\)/);
  assert.match(page, /log\('リアルタイム生成を開始しました。映像は数秒ずつ連続して届きます。'\);/);
  assert.match(page, /log\('録画を履歴へ保存しました。'\);/);
  assert.match(page, /if\(message\)\{log\(message\);notice\(message\)\}/);
});
