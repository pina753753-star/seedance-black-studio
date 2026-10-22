'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const workerRoot = process.env.PINA_TEST_WORKER_ROOT || path.resolve(__dirname, '../watermark-server');
const dependencyRoot = process.env.PINA_TEST_DEPENDENCY_ROOT || workerRoot;
const actualRequire = createRequire(path.resolve(dependencyRoot, 'package.json'));
const realExpress = actualRequire('express');
const realFetch = actualRequire('node-fetch');
const realSupabase = actualRequire('@supabase/supabase-js');
const source = fs.readFileSync(path.join(workerRoot, 'server.js'), 'utf8');
const download = require(path.join(workerRoot, 'watermark-download.js'));
const fixtureDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pina-integration-'));
const video = path.join(fixtureDir, 'synthetic.mp4');
const image = path.join(fixtureDir, 'synthetic.png');
const multistream = path.join(fixtureDir, 'synthetic-multistream.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video], { timeout: 15000 });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', image], { timeout: 15000 });
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=1:d=1', '-f', 'lavfi', '-i', 'color=c=red:s=4100x2:r=1:d=1', '-map', '0:v', '-map', '1:v', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-disposition:v:0', '0', '-disposition:v:1', 'default', multistream], { timeout: 15000 });
const referenceVideo = path.join(fixtureDir, 'synthetic-reference.mp4');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x240:r=24:d=4', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', referenceVideo], { timeout: 15000 });
const isOwnedTemp = (name) => ['pina-watermark-', 'pina-edit-', 'pina-reference-'].some((prefix) => name.startsWith(prefix));
const beforeTemp = new Set(fs.readdirSync('/tmp').filter(isOwnedTemp));
let uploadMode = 'normal';
let privateMode = 'normal';
let uploadTimeoutMs;
let downloadTimeoutMs;
let storageTimeoutMs;
let cancelledResponses = 0;
let privateDeletes = 0;
const savedUploads = new Map();
const ID = '11111111-1111-4111-8111-111111111111';
let sourceRequests = 0;
let redirectFollowed = 0;
let uploads = 0;
let uploadBody;
let server;
let fixtureServer;
let checks = 0;
const SECRET = 'synthetic-local-integration-secret';
const ORIGIN = 'https://unit-test.supabase.co';
const makeUrl = (name) => `${ORIGIN}/storage/v1/object/public/reference-images/nested/${name}`;
function listen(instance) { return new Promise((resolve) => instance.listen(0, '127.0.0.1', () => resolve(instance.address().port))); }
async function close(instance) { if (instance) await new Promise((resolve) => { instance.close(resolve); instance.closeAllConnections(); }); }
(async () => {
  try {
    fixtureServer = http.createServer((req, res) => {
      sourceRequests++;
      res.on('error', () => {});
      function stallBody(contentType, bytes = Buffer.from('{"Id":"')) {
        res.writeHead(200, { 'content-type': contentType }); res.write(bytes);
        res.on('close', () => { if (!res.writableFinished) cancelledResponses++; });
      }
      if (req.method === 'POST') {
        assert.match(req.url, /^\/storage\/v1\/object\/(reference-images\/(watermarked|edited)\/|seedance-reference-video\/(approved|review)\/)/);
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          uploads++;
          uploadBody = Buffer.concat(chunks);
          savedUploads.set(req.url, uploadBody);
          assert.equal(req.headers['content-length'], String(uploadBody.length));
          if (uploadMode === 'stall-headers') {
            res.on('close', () => { if (!res.writableFinished) cancelledResponses++; }); return;
          }
          if (uploadMode === 'stall-body') { stallBody('application/json'); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ Id: 'synthetic-upload-id', Key: req.url.slice('/storage/v1/object/'.length) }));
        });
        return;
      }
      if (req.method === 'DELETE') {
        assert.equal(req.url, '/storage/v1/object/seedance-reference-video');
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()).prefixes, [`staging/${ID}/${ID}.mp4`]);
          privateDeletes++;
          if (privateMode === 'delete-stall') { stallBody('application/json'); return; }
          res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]');
        });
        return;
      }
      if (req.url.includes('/seedance-reference-video/')) {
        assert.match(req.url, /\/(staging|approved)\//);
        if (privateMode === 'download-stall') { stallBody('video/mp4', Buffer.from('partial-video')); return; }
        if (privateMode === 'missing-staging' && req.url.includes('/staging/')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' })); return;
        }
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': fs.statSync(referenceVideo).size });
        fs.createReadStream(referenceVideo).pipe(res); return;
      }
      const name = req.url.split('/').pop();
      if (name === 'stalled.mp4') { stallBody('video/mp4', Buffer.from('partial-video')); return; }
      if (name === 'redirect.mp4') { res.writeHead(302, { location: '/forbidden' }); res.end(); return; }
      if (name === 'forbidden') { redirectFollowed++; res.writeHead(500); res.end(); return; }
      const file = name === 'multistream.mp4' ? multistream : name === 'image.mp4' || name === 'image.png' ? image : video;
      res.writeHead(200, { 'content-type': name === 'image.png' ? 'image/png' : 'video/mp4', 'content-length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    const fixturePort = await listen(fixtureServer);
    const localFixture = `http://127.0.0.1:${fixturePort}`;
    const app = realExpress();
    const express = () => app;
    express.json = realExpress.json;
    let ready;
    const readyPromise = new Promise((resolve) => { ready = resolve; });
    const originalListen = app.listen.bind(app);
    app.listen = (_, callback) => { server = originalListen(0, '127.0.0.1', () => { if (callback) callback(); ready(server.address().port); }); return server; };
    const context = vm.createContext({
      Buffer, URL, setTimeout, clearTimeout,
      process: { env: { SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-sdk-key-not-live', WATERMARK_SECRET: SECRET } },
      console: { log() {}, error() {} },
      require(name) {
        if (name === 'express') return express;
        if (name === 'ffmpeg-static') return '/unused';
        if (name === 'node-fetch') return async (url, options) => {
          const parsed = new URL(url);
          assert.equal(parsed.origin, ORIGIN);
          // Only the network destination is mocked. node-fetch and the actual
          // HTTP response/Readable body remain real, over loopback only.
          return realFetch(`${localFixture}${parsed.pathname}`, options);
        };
        if (name === '@supabase/supabase-js') return realSupabase;
        if (name === './worker-storage.js') {
          const realStorage = require(path.join(workerRoot, 'worker-storage.js'));
          return {
            uploadStorageFile: (args) => realStorage.uploadStorageFile({ ...args, timeoutMs: uploadTimeoutMs || args.timeoutMs }),
            withStorageDeadline: (args) => realStorage.withStorageDeadline({ ...args, timeoutMs: storageTimeoutMs || args.timeoutMs })
          };
        }
        if (name === './worker-probe.js') return require(path.join(workerRoot, 'worker-probe.js'));
        if (name === './watermark-download.js') return {
          ...download,
          downloadWatermarkVideo: (args) => download.downloadWatermarkVideo({ ...args, timeoutMs: downloadTimeoutMs || args.timeoutMs })
        };
        if (name === './reference-dance-inspection.js') return require(path.join(workerRoot, 'reference-dance-inspection.js'));
        return actualRequire(name);
      }
    });
    vm.runInContext(source, context, { timeout: 1000 });
    const port = await readyPromise;
    const base = `http://127.0.0.1:${port}`;
    async function post(route, body, token = SECRET) {
      const headers = { 'content-type': 'application/json' };
      if (token !== undefined && token !== null) headers.authorization = `Bearer ${token}`;
      const res = await realFetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    }
    async function expect(label, action, expectedStatus, expectedError) {
      const result = await action();
      assert.equal(result.status, expectedStatus, label);
      if (expectedError) assert.equal(result.body.error, expectedError, label);
      checks++; console.log(`PASS ${label}`);
      return result;
    }
    await expect('missing auth before processing', () => post('/watermark', { videoUrl: makeUrl('video.mp4') }, null), 401, 'Unauthorized');
    await expect('incorrect auth before processing', () => post('/watermark', { videoUrl: makeUrl('video.mp4') }, 'wrong'), 401, 'Unauthorized');
    await expect('correct auth retains validation', () => post('/watermark', {}), 400, 'videoUrl is required');
    await expect('foreign URL rejected before source transport', () => post('/watermark', { videoUrl: 'http://127.0.0.1/private' }), 400, 'VIDEO_URL_INVALID');
    assert.equal(sourceRequests, 0);
    const success = await expect('real MP4+AAC download/probe/watermark/SDK upload', () => post('/watermark', { videoUrl: makeUrl('video.mp4') }), 200);
    assert.equal(success.body.ok, true);
    assert.equal(uploads, 1);
    const output = path.join(fixtureDir, 'watermarked.mp4');
    fs.writeFileSync(output, uploadBody);
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8', timeout: 15000 }));
    assert.equal(metadata.streams.some((stream) => stream.codec_type === 'video' && stream.width === 320 && stream.height === 240), true);
    assert.equal(metadata.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'), true);
    checks++; console.log('PASS actual output has expected 320x240 video and retained AAC audio');
    await expect('HTTP redirect not followed', () => post('/watermark', { videoUrl: makeUrl('redirect.mp4') }), 500, 'DOWNLOAD_FAILED');
    assert.equal(redirectFollowed, 0);
    await expect('actual image MIME rejected before media parsing', () => post('/watermark', { videoUrl: makeUrl('image.png') }), 500, 'VIDEO_CONTENT_TYPE_INVALID');
    await expect('PNG disguised as video rejected by real ffprobe', () => post('/watermark', { videoUrl: makeUrl('image.mp4') }), 500, 'VIDEO_FORMAT_INVALID');
    assert.equal(uploads, 1);
    await expect('real multistream input encodes only validated video', () => post('/watermark', { videoUrl: makeUrl('multistream.mp4') }), 200);
    assert.equal(uploads, 2);
    const multiOutput = path.join(fixtureDir, 'watermarked-multistream.mp4');
    fs.writeFileSync(multiOutput, uploadBody);
    const multiMetadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', multiOutput], { encoding: 'utf8', timeout: 15000 }));
    assert.equal(multiMetadata.streams.length, 1);
    assert.equal(multiMetadata.streams[0].width, 64);
    assert.equal(multiMetadata.streams[0].height, 64);
    checks++; console.log('PASS unvalidated default4100x2 stream is not selected; output is64x64');
    await expect('edit retains authenticated empty-body validation', () => post('/edit', {}), 400);
    const editBody = { clips: [{ videoUrl: makeUrl('video.mp4'), start: 0.1, end: 0.9 }], taskId: ID, userId: ID };
    const checkSavedMedia = (label, filename, data, duration, audio) => {
      const out = path.join(fixtureDir, filename); fs.writeFileSync(out, data);
      const meta = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out], { encoding: 'utf8', timeout: 15000 }));
      assert.ok(Math.abs(Number(meta.format.duration) - duration) < 0.2, label);
      assert.equal(meta.streams.some((stream) => stream.codec_type === 'video' && stream.width === 320 && stream.height === 240), true);
      assert.equal(meta.streams.some((stream) => stream.codec_type === 'audio'), audio);
      checks++; console.log(`PASS ${label}`);
    };
    await expect('actual edit trim/streamed SDK upload', () => post('/edit', editBody), 200);
    checkSavedMedia('trimmed output retains video/audio and expected duration', 'edited-trim.mp4', uploadBody, 0.8, true);
    for (const transition of ['cut', 'fade', 'crossfade']) {
      await expect(`actual two-clip edit ${transition}`, () => post('/edit', { ...editBody, clips: [...editBody.clips, ...editBody.clips], transition, transitionDuration: 0.2 }), 200);
      checkSavedMedia(`${transition} output remains playable with expected duration`, `edited-${transition}.mp4`, uploadBody, transition === 'crossfade' ? 1.4 : 1.6, true);
    }
    downloadTimeoutMs = 100;
    const beforeStalledDownload = cancelledResponses;
    await expect('edit stalled response body is aborted under compressed test deadline', () => post('/edit', { ...editBody, clips: [{ videoUrl: makeUrl('stalled.mp4') }] }), 500, 'Video processing exceeded its time limit');
    downloadTimeoutMs = undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cancelledResponses, beforeStalledDownload + 1);
    checks++; console.log('PASS actual stalled download socket closed');
    for (const mode of ['stall-headers', 'stall-body']) {
      uploadMode = mode; uploadTimeoutMs = 100;
      const beforeAbort = cancelledResponses;
      await expect(`watermark upload ${mode} deadline`, () => post('/watermark', { videoUrl: makeUrl('video.mp4') }), 500, 'UPLOAD_TIMEOUT');
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(cancelledResponses, beforeAbort + 1);
      checks++; console.log(`PASS actual ${mode} upload socket closed`);
    }
    await expect('edit upload body timeout preserves safe processing error', () => post('/edit', editBody), 500, 'Video processing exceeded its time limit');
    uploadMode = 'normal'; uploadTimeoutMs = undefined;
    const referenceBody = { userId: ID, assetId: ID, stagingPath: `staging/${ID}/${ID}.mp4` };
    const reference = await expect('actual private reference download/probes/remux/frame uploads/delete', () => post('/reference-dance-inspect', referenceBody), 200);
    assert.equal(reference.body.approvedPath, `approved/${ID}/${ID}.mp4`);
    assert.equal(reference.body.reviewPaths.length, 5);
    assert.equal(privateDeletes, 1);
    checkSavedMedia('sealed approved reference retains four-second video without audio', 'approved-reference.mp4', savedUploads.get(`/storage/v1/object/seedance-reference-video/approved/${ID}/${ID}.mp4`), 4, false);
    for (let i = 1; i <= 5; i++) {
      const frame = savedUploads.get(`/storage/v1/object/seedance-reference-video/review/${ID}/${ID}/frame-${i}.jpg`);
      assert.ok(frame && frame[0] === 0xff && frame[1] === 0xd8);
    }
    checks++; console.log('PASS all five private review frames are real JPEG uploads');
    privateMode = 'missing-staging';
    await expect('actual reference 404 fallback retains approved recovery contract', () => post('/reference-dance-inspect', referenceBody), 200);
    privateMode = 'download-stall'; storageTimeoutMs = 100;
    const beforePrivateAbort = cancelledResponses;
    await expect('actual private reference body stall is cancelled before parsing', () => post('/reference-dance-inspect', referenceBody), 422, 'VIDEO_CHECK_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cancelledResponses, beforePrivateAbort + 1);
    checks++; console.log('PASS actual private download socket closed');
    privateMode = 'delete-stall';
    const beforeDelete = privateDeletes;
    await expect('actual staging-delete acknowledgement timeout does not repeat deletion', () => post('/reference-dance-inspect', referenceBody), 422, 'VIDEO_CHECK_TIMEOUT');
    assert.equal(privateDeletes, beforeDelete + 1);
    privateMode = 'normal'; storageTimeoutMs = undefined;
    const afterTemp = new Set(fs.readdirSync('/tmp').filter(isOwnedTemp));
    assert.deepEqual(afterTemp, beforeTemp);
    checks++; console.log('PASS all exclusively owned job temporary directories cleaned');
    assert.equal(vm.runInContext('activeJobs + activeEditJobs + activeWatermarkRequests + jobQueue.length + inFlightWatermarks.size', context), 0);
    checks++; console.log('PASS all slot/queue/request/dedup counters released');
    console.log(`RESULT ${checks}/${checks} checks passed; Node ${process.version}; Express ${actualRequire('express/package.json').version}; node-fetch ${actualRequire('node-fetch/package.json').version}; Supabase SDK ${actualRequire('@supabase/supabase-js/package.json').version}`);
    console.log(execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0]);
    console.log('Network boundary: actual HTTP only on 127.0.0.1. Storage service simulated locally; actual SDK, streamed request bodies, node-fetch transport and cancellation used. Timeout cases compress only helper deadline arguments to 100ms; production keeps 60s upload/download, edit5min and reference90s budgets. Synthetic media only. No live credentials or services. The runtime printed above identifies the tested environment.');
  } finally {
    await close(server); await close(fixtureServer);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
