const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { execFile } = require('child_process');
const { isAllowedWatermarkUrl, downloadWatermarkVideo } = require('./watermark-download.js');
const { uploadStorageFile, withStorageDeadline } = require('./worker-storage.js');
const { probeVideoFile } = require('./worker-probe.js');
const {
  validateReferenceDanceProbe,
  validateReferenceDanceDurationMatch
} = require('./reference-dance-inspection.js');

// ffmpeg-static is not used; system ffmpeg is used via Dockerfile
// ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
// Requests contain URLs/IDs, never media bytes; six long clip URLs fit this cap.
app.use(express.json({ limit: '64kb' }));

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WATERMARK_SECRET = process.env.WATERMARK_SECRET || '';
const PORT = process.env.PORT || 3000;

// ---- concurrency guard shared by /watermark and /edit ----
// Without a limit, overlapping requests (e.g. a client retrying every ~10s
// while a previous attempt is still stuck/slow) each spawn their own ffmpeg
// process, multiplying peak memory/CPU and starving whatever is already
// running — this matched what production logs showed for the SIGKILL
// incidents (repeated /watermark calls piling up for the same job).
// MAX_CONCURRENT_JOBS bounds how many jobs (of either kind) run at once;
// anything beyond that waits in a queue instead of running in parallel.
// /edit is additionally capped by MAX_CONCURRENT_EDIT_JOBS so it can never
// occupy every slot — at least one slot always stays available for
// /watermark, and queued /watermark requests are dispatched ahead of queued
// /edit requests so /watermark's responsiveness doesn't degrade because of
// /edit traffic sharing this container.
const MAX_CONCURRENT_JOBS = 2;
const MAX_CONCURRENT_EDIT_JOBS = 1;
const MAX_QUEUED_JOBS = 8;
const JOB_QUEUE_TIMEOUT_MS = 20000;
const MAX_WATERMARK_REQUESTS = 16;
let activeWatermarkRequests = 0;

function queueError(code) {
  return Object.assign(new Error(code), { publicCode: code, httpStatus: 429 });
}

function replyQueueError(res, error) {
  if (error?.httpStatus === 429) {
    res.set('Retry-After', String(Math.ceil(JOB_QUEUE_TIMEOUT_MS / 1000)));
    return res.status(429).json({ ok: false, error: error.publicCode });
  }
  return res.status(500).json({ ok: false, error: 'PROCESSING_FAILED' });
}
let activeJobs = 0;
let activeEditJobs = 0;
const jobQueue = []; // { type: 'watermark' | 'edit', resolve, reject?, timer?, settled? }

function canRunJob(type) {
  if (activeJobs >= MAX_CONCURRENT_JOBS) return false;
  if (type === 'edit' && activeEditJobs >= MAX_CONCURRENT_EDIT_JOBS) return false;
  return true;
}

function pumpQueue() {
  for (let i = 0; i < jobQueue.length; i++) {
    const item = jobQueue[i];
    if (canRunJob(item.type)) {
      jobQueue.splice(i, 1);
      if (item.settled) { i--; continue; }
      item.settled = true;
      if (item.timer) clearTimeout(item.timer);
      activeJobs++;
      if (item.type === 'edit') activeEditJobs++;
      item.resolve();
      i--;
    }
  }
}

function acquireSlot(type = 'watermark', timeoutMs = JOB_QUEUE_TIMEOUT_MS) {
  if (canRunJob(type)) {
    activeJobs++;
    if (type === 'edit') activeEditJobs++;
    return Promise.resolve();
  }
  if (jobQueue.length >= MAX_QUEUED_JOBS) {
    return Promise.reject(queueError('WORKER_BUSY'));
  }
  return new Promise((resolve, reject) => {
    const item = { type, resolve, reject, timer: null, settled: false };
    if (type === 'watermark') {
      // Jump ahead of any queued /edit jobs, but stay behind other queued
      // /watermark jobs (FIFO within the same priority).
      let idx = jobQueue.findIndex((q) => q.type === 'edit');
      if (idx === -1) idx = jobQueue.length;
      jobQueue.splice(idx, 0, item);
    } else {
      jobQueue.push(item);
    }
    if (timeoutMs > 0) {
      item.timer = setTimeout(() => {
        if (item.settled) return;
        item.settled = true;
        const index = jobQueue.indexOf(item);
        if (index !== -1) jobQueue.splice(index, 1);
        reject(queueError('WORKER_QUEUE_TIMEOUT'));
      }, timeoutMs);
    }
  });
}

function releaseSlot(type = 'watermark') {
  activeJobs--;
  if (type === 'edit') activeEditJobs--;
  pumpQueue();
}

// Hard cap on how long a single ffmpeg run may take. Without this, a stuck
// ffmpeg process (bad input, resource contention) holds its concurrency slot
// and downloaded buffer forever, and the client's poll-driven retries just
// keep queuing more requests behind it.
const FFMPEG_TIMEOUT_MS = 90000;

function runFfmpeg(build, timeoutMs = FFMPEG_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('ffmpeg timed out before start'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const command = build();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { command.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    command
      .on('start', () => {
        // fluent-ffmpeg can finish asynchronous preparation after our timer.
        if (settled) { try { command.kill('SIGKILL'); } catch (_) {} }
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      })
      .on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    try { command.run(); } catch (error) {
      settled = true;
      clearTimeout(timer);
      try { command.kill('SIGKILL'); } catch (_) {}
      reject(error);
    }
  });
}

const WATERMARK_MAX_OUTPUT_BYTES = 200 * 1024 * 1024;
const WATERMARK_PROBE_TIMEOUT_MS = 15000;

function watermarkError(code) {
  return Object.assign(new Error(code), { publicCode: code });
}

function validateWatermarkProbe(probe) {
  const video = (Array.isArray(probe?.streams) ? probe.streams : [])
    .find((stream) => stream?.codec_type === 'video' && !stream.disposition?.attached_pic);
  const formats = String(probe?.format?.format_name || '').split(',');
  // Callers persist MP4/MOV/WebM; image/playlist inputs are not generation videos.
  if (!video || !formats.some((format) => ['mp4', 'mov', 'webm', 'matroska'].includes(format))) {
    throw watermarkError('VIDEO_FORMAT_INVALID');
  }
  const streamIndex = Number(video.index);
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) throw watermarkError('VIDEO_FORMAT_INVALID');
  const duration = Number(probe?.format?.duration || video.duration || 0);
  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180
      || !Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || height < 1 || width > 4096 || height > 4096) {
    throw watermarkError('VIDEO_LIMIT_EXCEEDED');
  }
  return { duration, width, height, streamIndex };
}

async function probeWatermarkVideo(filePath) {
  try {
    const probe = await probeVideoFile({ filePath, timeoutMs: WATERMARK_PROBE_TIMEOUT_MS, execFileImpl: execFile });
    return validateWatermarkProbe(probe);
  } catch (error) {
    if (error.publicCode === 'PROBE_TIMEOUT') throw watermarkError('VIDEO_PROBE_TIMEOUT');
    if (error.publicCode === 'PROBE_FAILED') throw watermarkError('VIDEO_UNREADABLE');
    throw error;
  }
}

// ---- /watermark de-duplication ----
// The client polls /api/seedance-status every ~10-12s and retries the
// watermark step on each poll until it succeeds or the grace period expires.
// Without this map, each poll for the same not-yet-watermarked video started
// its own independent download+ffmpeg+upload cycle, so a single slow/stuck
// job could have several duplicate jobs for the exact same video queued
// behind it at once. Concurrent requests for the same videoUrl now share one
// in-flight job instead of each starting a new one.
const inFlightWatermarks = new Map(); // videoUrl -> Promise<{ok, watermarkedUrl?, error?}>

async function runWatermarkJob(videoUrl) {
  await acquireSlot('watermark');
  let jobDirectory;
  try {
    // Own a fresh directory, never delete/overwrite another request's files.
    jobDirectory = fs.mkdtempSync('/tmp/pina-watermark-');
    const uid = uuidv4();
    const inputFile = path.join(jobDirectory, 'input.mp4');
    const outputFile = path.join(jobDirectory, 'output.mp4');
    await downloadWatermarkVideo({ url: videoUrl, supabaseUrl: SUPABASE_URL, filePath: inputFile, fetchImpl: fetch });
    const video = await probeWatermarkVideo(inputFile);

    await runFfmpeg(() =>
      ffmpeg(inputFile)
        .inputOptions('-protocol_whitelist', 'file,pipe')
        // Passed as separate arguments (not a single array) so fluent-ffmpeg
        // does not re-split any option value on internal spaces (it only
        // applies that space-splitting heuristic to array-form calls, and
        // "Pina Studio" contains exactly one space, which previously got
        // split into two separate argv tokens and broke -vf's value).
        .outputOptions(
          // Encode only the stream we validated, not FFmpeg's automatic choice.
          '-map', `0:${video.streamIndex}`,
          '-map', '0:a:0?',
          '-vf', "drawtext=text='Pina Studio':fontsize=28:fontcolor=white@0.85:x=w-tw-20:y=h-th-20:shadowcolor=black@0.8:shadowx=2:shadowy=2",
          '-c:a', 'copy',
          '-movflags', '+faststart',
          '-fs', String(WATERMARK_MAX_OUTPUT_BYTES)
        )
        .output(outputFile)
    );

    // FFmpeg may slightly exceed -fs; never upload a capped or empty result.
    const outputBytes = fs.statSync(outputFile).size;
    if (!outputBytes || outputBytes >= WATERMARK_MAX_OUTPUT_BYTES) throw watermarkError('VIDEO_OUTPUT_TOO_LARGE');
    const { publicUrl } = await uploadStorageFile({
      createClient, fetchImpl: fetch, supabaseUrl: SUPABASE_URL, key: SUPABASE_SERVICE_KEY,
      bucket: 'reference-images', objectPath: `watermarked/${uid}.mp4`, filePath: outputFile,
      contentType: 'video/mp4', upsert: false, timeoutMs: 60000
    });
    return { ok: true, watermarkedUrl: publicUrl };
  } catch (err) {
    console.error('[watermark] error:', err.publicCode || 'PROCESSING_FAILED');
    return { ok: false, error: err.publicCode || 'PROCESSING_FAILED' };
  } finally {
    try { if (jobDirectory) fs.rmSync(jobDirectory, { recursive: true, force: true }); } catch (_) {}
    releaseSlot('watermark');
  }
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'Pina Studio Watermark Server', version: '1.0.0' });
});

app.post('/watermark', async (req, res) => {
  if (!WATERMARK_SECRET) return res.status(503).json({ ok: false, error: 'SERVICE_NOT_CONFIGURED' });
  const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (auth !== WATERMARK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const { videoUrl } = req.body || {};
  if (!videoUrl) return res.status(400).json({ ok: false, error: 'videoUrl is required' });
  if (!isAllowedWatermarkUrl(videoUrl, SUPABASE_URL)) {
    return res.status(400).json({ ok: false, error: 'VIDEO_URL_INVALID' });
  }
  // Bound waiting HTTP responses too: duplicate requests share a job but still
  // consume request/socket memory. Keep same-video de-duplication within this cap.
  if (activeWatermarkRequests >= MAX_WATERMARK_REQUESTS) return replyQueueError(res, queueError('WORKER_BUSY'));
  activeWatermarkRequests++;
  const sourceUrl = new URL(videoUrl).href;
  try {
    let jobPromise = inFlightWatermarks.get(sourceUrl);
    if (!jobPromise) {
      jobPromise = runWatermarkJob(sourceUrl).finally(() => inFlightWatermarks.delete(sourceUrl));
      inFlightWatermarks.set(sourceUrl, jobPromise);
    }
    const result = await jobPromise;
    return res.status(result.ok ? 200 : 500).json(result);
  } catch (error) {
    return replyQueueError(res, error);
  } finally {
    activeWatermarkRequests--;
  }
});

// ================================================================
// VIDEO EDIT ENDPOINT (trim / concat / transitions)
// ================================================================

const EDIT_MAX_CLIPS = 6;
const EDIT_BUCKET = 'reference-images';

// SSRF guard: only Supabase Storage public URLs on this project's own
// Supabase host are allowed as clip sources. Arbitrary external URLs are
// rejected outright.
function getAllowedVideoHost() {
  try {
    return new URL(SUPABASE_URL).host || null;
  } catch (_) {
    return null;
  }
}
const EDIT_ALLOWED_VIDEO_HOST = getAllowedVideoHost();

// Only the reference-images bucket (the one /edit itself uploads outputs to)
// is allowed as a clip source — narrower than "any public Supabase Storage
// bucket on this host" to keep the SSRF allowlist as tight as possible.
const EDIT_ALLOWED_VIDEO_PATH_PREFIX = '/storage/v1/object/public/reference-images/';

function isAllowedEditVideoUrl(raw) {
  if (!isAllowedWatermarkUrl(raw, SUPABASE_URL)) return false;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (!EDIT_ALLOWED_VIDEO_HOST || u.host !== EDIT_ALLOWED_VIDEO_HOST) return false;
  if (!u.pathname.startsWith(EDIT_ALLOWED_VIDEO_PATH_PREFIX)) return false;
  return true;
}

// Per-clip download cap. Generated clips are short (seconds to low minutes)
// so this comfortably covers legitimate use while bounding worst-case
// memory/disk from a single request.
const EDIT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200MB
const EDIT_DOWNLOAD_TIMEOUT_MS = 60000;

// Duration limits, checked after ffprobe.
// Generated clips are short-form (typically up to ~15s each), so these
// caps are sized for combining SNS-style short clips, not long-form video.
const EDIT_MAX_CLIP_DURATION_SEC = 30; // 30s per clip
const EDIT_MAX_TOTAL_DURATION_SEC = 180; // 3 min combined

// A single deadline for the *entire* /edit request — download, probe, and
// all ffmpeg steps share it. Without one shared deadline, per-phase caps
// stack (max 6 clips x 60s download + 6 x 15s probe + 5min ffmpeg budget
// could add up to ~12.5 minutes worst case); a single deadline created
// before the first download keeps total wall-clock time for one request
// bounded regardless of which phase is slow.
const EDIT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for the whole request
const EDIT_FFPROBE_TIMEOUT_MS = 15000;

function remainingMs(deadline) {
  return deadline - Date.now();
}

function assertDeadlineNotPassed(deadline, stage) {
  if (remainingMs(deadline) <= 0) {
    throw editError('PROCESSING_TIMEOUT', `edit processing exceeded its time budget (${stage})`);
  }
}

async function editProbe(file, deadline) {
  assertDeadlineNotPassed(deadline, 'probe');
  const timeoutMs = Math.min(EDIT_FFPROBE_TIMEOUT_MS, remainingMs(deadline));
  if (timeoutMs <= 0) throw editError('PROCESSING_TIMEOUT');
  try {
    return await probeVideoFile({ filePath: file, timeoutMs, execFileImpl: execFile });
  } catch (error) {
    throw editError(error.publicCode === 'PROBE_TIMEOUT' ? 'PROCESSING_TIMEOUT' : 'CLIP_UNREADABLE');
  }
}

function editParseFps(rFrameRate) {
  if (!rFrameRate) return 24;
  const parts = String(rFrameRate).split('/').map(Number);
  const fps = parts.length === 2 && parts[1] ? parts[0] / parts[1] : Number(parts[0]);
  return Number.isFinite(fps) && fps > 0 && fps <= 120 ? fps : 24;
}

async function editDownload(url, filePath, deadline) {
  assertDeadlineNotPassed(deadline, 'download');
  const timeoutMs = Math.min(EDIT_DOWNLOAD_TIMEOUT_MS, remainingMs(deadline));
  if (timeoutMs <= 0) throw editError('PROCESSING_TIMEOUT');
  // Preserve /edit's narrower reference-images bucket contract while reusing
  // the proven streamed byte cap and header+body cancellation lifecycle.
  if (!isAllowedEditVideoUrl(url)) throw editError('CLIP_DOWNLOAD_FAILED');
  try {
    return await downloadWatermarkVideo({
      url, supabaseUrl: SUPABASE_URL, filePath, fetchImpl: fetch,
      maxBytes: EDIT_MAX_DOWNLOAD_BYTES, timeoutMs
    });
  } catch (error) {
    if (error.publicCode === 'DOWNLOAD_TIMEOUT') throw editError('PROCESSING_TIMEOUT');
    if (error.publicCode === 'DOWNLOAD_TOO_LARGE') throw editError('CLIP_TOO_LARGE');
    throw editError('CLIP_DOWNLOAD_FAILED');
  }
}

// ---- allowlist-based public error messages ----
// Every message returned to the client must come from this fixed map, keyed
// by an explicit `publicCode` attached to the thrown error. Anything without
// a recognized code (ffmpeg internals, Supabase SDK errors, unexpected
// exceptions, etc.) falls through to the generic PROCESSING_FAILED message.
// Full error detail is always logged server-side via console.error, never
// forwarded to the client.
const EDIT_PUBLIC_ERRORS = {
  CLIP_DOWNLOAD_FAILED: 'Failed to download one of the clips',
  CLIP_TOO_LARGE: 'One of the clips exceeds the maximum allowed file size',
  CLIP_UNREADABLE: 'One of the clips could not be read',
  CLIP_NO_VIDEO_STREAM: 'One of the clips has no readable video stream',
  CLIP_TOO_LONG: 'One of the clips exceeds the maximum allowed duration',
  TOTAL_TOO_LONG: 'Combined clip duration exceeds the maximum allowed length',
  CLIP_TRIM_INVALID: 'One of the clips has an invalid trim range',
  PROCESSING_TIMEOUT: 'Video processing exceeded its time limit',
  UPLOAD_FAILED: 'Failed to store the edited video',
  PROCESSING_FAILED: 'Video processing failed',
};

function editError(code, detail) {
  return Object.assign(new Error(detail || code), { publicCode: code });
}

function ffmpegStageError(err, stageLabel) {
  const code = /timed out/i.test(err.message) ? 'PROCESSING_TIMEOUT' : 'PROCESSING_FAILED';
  return editError(code, `${stageLabel}: ${err.message}`);
}

function safeEditErrorMessage(err) {
  const code = err && err.publicCode;
  return EDIT_PUBLIC_ERRORS[code] || EDIT_PUBLIC_ERRORS.PROCESSING_FAILED;
}

async function runEditJob({ clips, transition, transitionDuration, ownerSegment, outputId }) {
  // Single deadline for the whole request, created before any work starts.
  const deadline = Date.now() + EDIT_REQUEST_TIMEOUT_MS;
  // Scratch paths belong exclusively to this request. Storage paths remain
  // deterministic (ownerSegment/outputId) for the existing caller's recovery.
  let jobDirectory;
  const makeTmp = (name) => path.join(jobDirectory, `${name}.mp4`);

  try {
    jobDirectory = fs.mkdtempSync('/tmp/pina-edit-');
    // 1) ダウンロード
    const inputFiles = [];
    for (let i = 0; i < clips.length; i++) {
      assertDeadlineNotPassed(deadline, `download clip ${i}`);
      const f = makeTmp(`edit_in_${i}`);
      await editDownload(clips[i].videoUrl, f, deadline);
      inputFiles.push(f);
    }

    // 2) メタデータ取得 + 長さ検証
    const metas = [];
    for (const f of inputFiles) {
      assertDeadlineNotPassed(deadline, 'probe');
      let data;
      try {
        data = await editProbe(f, deadline);
      } catch (err) {
        if (err.publicCode === 'PROCESSING_TIMEOUT') throw err;
        throw editError('CLIP_UNREADABLE');
      }
      const v = (data.streams || []).find((s) => s.codec_type === 'video');
      const a = (data.streams || []).find((s) => s.codec_type === 'audio');
      if (!v) throw editError('CLIP_NO_VIDEO_STREAM', 'No video stream found in input');
      const duration = Number(data.format && data.format.duration) || 0;
      if (duration > EDIT_MAX_CLIP_DURATION_SEC) {
        throw editError('CLIP_TOO_LONG', `clip duration (${duration.toFixed(1)}s) exceeds maximum allowed (${EDIT_MAX_CLIP_DURATION_SEC}s)`);
      }
      metas.push({
        duration,
        width: v.width,
        height: v.height,
        fps: editParseFps(v.r_frame_rate),
        hasAudio: !!a,
      });
    }

    const totalInputDuration = metas.reduce((s, m) => s + m.duration, 0);
    if (totalInputDuration > EDIT_MAX_TOTAL_DURATION_SEC) {
      throw editError('TOTAL_TOO_LONG', `total clip duration (${totalInputDuration.toFixed(1)}s) exceeds maximum allowed (${EDIT_MAX_TOTAL_DURATION_SEC}s)`);
    }

    // 出力解像度・fpsは1本目のクリップに合わせる
    const W = metas[0].width;
    const H = metas[0].height;
    const FPS = metas[0].fps;

    // 3) トリミング範囲を確定
    const plans = clips.map((clip, i) => {
      const dur = metas[i].duration;
      if (!Number.isFinite(dur) || dur <= 0) {
        throw editError('CLIP_TRIM_INVALID', `clip ${i}: could not determine video duration`);
      }
      let start = Number(clip.start);
      if (!Number.isFinite(start)) start = 0;
      if (start < 0) start = 0;
      if (start >= dur) {
        throw editError('CLIP_TRIM_INVALID', `clip ${i}: trim start (${start}s) is at or beyond video duration (${dur}s)`);
      }
      let end = clip.end != null ? Number(clip.end) : dur;
      if (!Number.isFinite(end)) end = dur;
      if (end > dur) end = dur;
      if (end <= start) {
        throw editError('CLIP_TRIM_INVALID', `clip ${i}: trim end (${end}s) must be greater than start (${start}s)`);
      }
      const tdur = end - start;
      if (tdur < 0.2) throw editError('CLIP_TRIM_INVALID', `clip ${i}: trim range too short (${tdur.toFixed(3)}s, minimum 0.2s)`);
      return { start, end, tdur };
    });

    // トランジション長（最短クリップの半分を超えないよう制限）
    let fd = Number(transitionDuration);
    if (!Number.isFinite(fd)) fd = 0.5;
    fd = Math.min(Math.max(fd, 0.1), 2);
    const minTdur = Math.min(...plans.map((p) => p.tdur));
    fd = Math.min(fd, minTdur / 2);
    fd = Number(fd.toFixed(3));

    // 4) 各クリップを正規化（トリム + 解像度/fps統一 + 音声統一）
    const normFiles = [];
    for (let i = 0; i < inputFiles.length; i++) {
      assertDeadlineNotPassed(deadline, `normalize clip ${i}`);
      const outFile = makeTmp(`edit_norm_${i}`);
      const p = plans[i];

      let vf =
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},format=yuv420p,setsar=1`;
      let af = 'aresample=48000,aformat=channel_layouts=stereo';

      if (transition === 'fade' && clips.length > 1) {
        const vParts = [];
        const aParts = [];
        if (i > 0) {
          vParts.push(`fade=t=in:st=0:d=${fd}`);
          aParts.push(`afade=t=in:st=0:d=${fd}`);
        }
        if (i < inputFiles.length - 1) {
          const st = (p.tdur - fd).toFixed(3);
          vParts.push(`fade=t=out:st=${st}:d=${fd}`);
          aParts.push(`afade=t=out:st=${st}:d=${fd}`);
        }
        if (vParts.length) vf += ',' + vParts.join(',');
        if (aParts.length) af += ',' + aParts.join(',');
      }

      const buildNormalizeCmd = () => {
        let cmd = ffmpeg(inputFiles[i]).inputOptions(['-ss', String(p.start)]);

        if (!metas[i].hasAudio) {
          cmd = cmd
            .input('anullsrc=channel_layout=stereo:sample_rate=48000')
            .inputFormat('lavfi')
            .outputOptions(['-map', '0:v:0', '-map', '1:a:0', '-shortest']);
        }

        return cmd
          .outputOptions([
            '-t', String(p.tdur),
            '-vf', vf,
            '-af', af,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-c:a', 'aac',
            '-b:a', '128k',
          ])
          .output(outFile);
      };

      try {
        await runFfmpeg(buildNormalizeCmd, remainingMs(deadline));
      } catch (err) {
        throw ffmpegStageError(err, `normalize clip ${i}`);
      }
      normFiles.push(outFile);
    }

    // 5) 結合
    assertDeadlineNotPassed(deadline, 'combine');
    const finalFile = makeTmp('edit_final');

    if (normFiles.length === 1) {
      // トリミングのみ: remuxしてfaststartを付ける
      try {
        await runFfmpeg(
          () => ffmpeg(normFiles[0]).outputOptions(['-c', 'copy', '-movflags', '+faststart']).output(finalFile),
          remainingMs(deadline)
        );
      } catch (err) {
        throw ffmpegStageError(err, 'remux');
      }
    } else if (transition === 'crossfade') {
      const n = normFiles.length;

      const filters = [];
      let vPrev = '[0:v]';
      let aPrev = '[0:a]';
      let cumulative = plans[0].tdur;
      for (let i = 1; i < n; i++) {
        const vOut = i === n - 1 ? '[vout]' : `[vx${i}]`;
        const aOut = i === n - 1 ? '[aout]' : `[ax${i}]`;
        const offset = (cumulative - fd).toFixed(3);
        filters.push(`${vPrev}[${i}:v]xfade=transition=fade:duration=${fd}:offset=${offset}${vOut}`);
        filters.push(`${aPrev}[${i}:a]acrossfade=d=${fd}${aOut}`);
        vPrev = vOut;
        aPrev = aOut;
        cumulative = cumulative + plans[i].tdur - fd;
      }

      const buildCrossfadeCmd = () => {
        let cmd = ffmpeg();
        normFiles.forEach((f) => {
          cmd = cmd.input(f);
        });
        return cmd
          .complexFilter(filters.join(';'))
          .outputOptions([
            '-map', '[vout]',
            '-map', '[aout]',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
          ])
          .output(finalFile);
      };

      try {
        await runFfmpeg(buildCrossfadeCmd, remainingMs(deadline));
      } catch (err) {
        throw ffmpegStageError(err, 'crossfade');
      }
    } else {
      // cut / fade: 単純連結（fadeは正規化時にフェード適用済み）
      const n = normFiles.length;
      const labels = [];
      for (let i = 0; i < n; i++) labels.push(`[${i}:v][${i}:a]`);
      const graph = `${labels.join('')}concat=n=${n}:v=1:a=1[vout][aout]`;

      const buildConcatCmd = () => {
        let cmd = ffmpeg();
        normFiles.forEach((f) => {
          cmd = cmd.input(f);
        });
        return cmd
          .complexFilter(graph)
          .outputOptions([
            '-map', '[vout]',
            '-map', '[aout]',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '18',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
          ])
          .output(finalFile);
      };

      try {
        await runFfmpeg(buildConcatCmd, remainingMs(deadline));
      } catch (err) {
        throw ffmpegStageError(err, 'concat');
      }
    }

    // 6) Stream the completed file with a real abort signal and the remaining
    // shared request budget. No whole-output readFileSync buffer is retained.
    assertDeadlineNotPassed(deadline, 'upload');
    const timeoutMs = Math.min(60000, remainingMs(deadline));
    if (timeoutMs <= 0) throw editError('PROCESSING_TIMEOUT');
    let publicUrl;
    try {
      ({ publicUrl } = await uploadStorageFile({
        createClient, fetchImpl: fetch, supabaseUrl: SUPABASE_URL, key: SUPABASE_SERVICE_KEY,
        bucket: EDIT_BUCKET, objectPath: `edited/${ownerSegment}/${outputId}.mp4`, filePath: finalFile,
        contentType: 'video/mp4', upsert: false, timeoutMs
      }));
    } catch (error) {
      throw editError(error.publicCode === 'UPLOAD_TIMEOUT' ? 'PROCESSING_TIMEOUT' : 'UPLOAD_FAILED');
    }

    const totalDuration =
      transition === 'crossfade' && plans.length > 1
        ? plans.reduce((s, p) => s + p.tdur, 0) - fd * (plans.length - 1)
        : plans.reduce((s, p) => s + p.tdur, 0);

    return {
      ok: true,
      editedUrl: publicUrl,
      duration: Number(totalDuration.toFixed(2)),
      transition,
    };
  } catch (err) {
    console.error('[edit] error:', err.publicCode || 'UNKNOWN', err.message);
    return { ok: false, error: safeEditErrorMessage(err) };
  } finally {
    try { if (jobDirectory) fs.rmSync(jobDirectory, { recursive: true, force: true }); } catch (_) {}
  }
}

app.post('/edit', async (req, res) => {
  if (!WATERMARK_SECRET) return res.status(503).json({ ok: false, error: 'SERVICE_NOT_CONFIGURED' });
  const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (auth !== WATERMARK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { clips, transition = 'cut', transitionDuration, userId, taskId } = req.body || {};

  if (!Array.isArray(clips) || clips.length < 1 || clips.length > EDIT_MAX_CLIPS) {
    return res.status(400).json({ ok: false, error: `clips must be an array of 1-${EDIT_MAX_CLIPS} items` });
  }
  if (!['cut', 'crossfade', 'fade'].includes(transition)) {
    return res.status(400).json({ ok: false, error: 'transition must be one of: cut, crossfade, fade' });
  }
  for (const clip of clips) {
    if (!clip || !isAllowedEditVideoUrl(clip.videoUrl)) {
      return res.status(400).json({ ok: false, error: 'each clip requires a valid videoUrl from Supabase Storage' });
    }
  }

  // taskId is required and must be a UUID: it becomes the Storage output
  // filename (edited/<ownerSegment>/<taskId>.mp4), which the caller
  // (api/video-edit.js) predicts up front from its own video_edit_tasks row
  // id so it can recover the result later even if the original HTTP request
  // to this endpoint never completed (timeout, dropped connection). No
  // fallback to a random id: an un-parented output file that nothing can
  // ever look up defeats the whole point of this path being deterministic.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof taskId !== 'string' || !UUID_RE.test(taskId)) {
    return res.status(400).json({ ok: false, error: 'taskId is required and must be a UUID' });
  }
  const outputId = taskId;

  const ownerSegment = typeof userId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(userId) ? userId : 'unassigned';

  let acquired = false;
  let result;
  try {
    await acquireSlot('edit');
    acquired = true;
    result = await runEditJob({ clips, transition, transitionDuration, ownerSegment, outputId });
  } catch (error) {
    return replyQueueError(res, error);
  } finally {
    if (acquired) releaseSlot('edit');
  }

  return res.status(result.ok ? 200 : 500).json(result);
});

// ================================================================
// CLOSED SEEDANCE 2.5 REFERENCE-DANCE INSPECTION
// ================================================================

const REFERENCE_DANCE_BUCKET = 'seedance-reference-video';
const REFERENCE_DANCE_MAX_BYTES = 50 * 1024 * 1024;
const REFERENCE_DANCE_MAX_SECONDS = 15;
const REFERENCE_DANCE_PROBE_TIMEOUT_MS = 15000;
const REFERENCE_DANCE_QUEUE_TIMEOUT_MS = 20000;
const REFERENCE_DANCE_PROCESS_TIMEOUT_MS = 90000;
const REFERENCE_DANCE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function referenceDancePath(kind, userId, assetId) {
  if (kind === 'staging') return `staging/${userId}/${assetId}.mp4`;
  if (kind === 'approved') return `approved/${userId}/${assetId}.mp4`;
  return '';
}

function referenceDanceError(code, detail) {
  return Object.assign(new Error(detail || code), { publicCode: code });
}

function referenceDanceRemainingMs(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw referenceDanceError('VIDEO_CHECK_TIMEOUT');
  return remaining;
}

async function referenceDanceProbe(file, timeoutMs = REFERENCE_DANCE_PROBE_TIMEOUT_MS) {
  if (timeoutMs <= 0) throw referenceDanceError('VIDEO_CHECK_TIMEOUT');
  try {
    return await probeVideoFile({ filePath: file,
      timeoutMs: Math.min(REFERENCE_DANCE_PROBE_TIMEOUT_MS, timeoutMs), execFileImpl: execFile });
  } catch (error) {
    throw referenceDanceError(error.publicCode === 'PROBE_TIMEOUT' ? 'VIDEO_CHECK_TIMEOUT' : 'VIDEO_UNREADABLE');
  }
}

async function referenceDanceWithinDeadline(operation, deadline, maxResponseBytes = 1024 * 1024) {
  try {
    return await withStorageDeadline({
      createClient, fetchImpl: fetch, supabaseUrl: SUPABASE_URL, key: SUPABASE_SERVICE_KEY,
      timeoutMs: referenceDanceRemainingMs(deadline), maxResponseBytes,
      operation: (client) => operation(client.storage.from(REFERENCE_DANCE_BUCKET))
    });
  } catch (error) {
    if (error.publicCode === 'STORAGE_TIMEOUT') throw referenceDanceError('VIDEO_CHECK_TIMEOUT');
    throw error;
  }
}

async function storageBlobBuffer(objectPath, deadline) {
  // The private SDK download and Blob conversion share the same abortable
  // deadline. This never uses or broadens the public video URL allowlist.
  const { data, error } = await referenceDanceWithinDeadline(async (storage) => {
    const result = await storage.download(objectPath);
    if (result.error || !result.data) return result;
    return { ...result, data: await result.data.arrayBuffer() };
  }, deadline, REFERENCE_DANCE_MAX_BYTES);
  if (error) {
    const status = Number(error.statusCode || error.status || 0);
    const message = String(error.message || '').toLowerCase();
    if (status === 404 || message.includes('object not found') || message === 'not found') return null;
    throw referenceDanceError('STORAGE_DOWNLOAD_FAILED');
  }
  if (!data) throw referenceDanceError('STORAGE_DOWNLOAD_FAILED');
  const buffer = Buffer.from(data);
  if (!buffer.length || buffer.length > REFERENCE_DANCE_MAX_BYTES) throw referenceDanceError('VIDEO_SIZE_INVALID');
  return buffer;
}

async function referenceDanceUpload(filePath, objectPath, contentType, deadline, errorCode) {
  try {
    await uploadStorageFile({
      createClient, fetchImpl: fetch, supabaseUrl: SUPABASE_URL, key: SUPABASE_SERVICE_KEY,
      bucket: REFERENCE_DANCE_BUCKET, objectPath, filePath, contentType, upsert: true,
      timeoutMs: referenceDanceRemainingMs(deadline)
    });
  } catch (error) {
    if (error.publicCode === 'UPLOAD_TIMEOUT' || error.publicCode === 'VIDEO_CHECK_TIMEOUT') {
      throw referenceDanceError('VIDEO_CHECK_TIMEOUT');
    }
    throw referenceDanceError(errorCode);
  }
}

async function runReferenceDanceInspection({ userId, assetId, stagingPath }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw referenceDanceError('SERVICE_NOT_CONFIGURED');
  if (!REFERENCE_DANCE_UUID_RE.test(userId) || !REFERENCE_DANCE_UUID_RE.test(assetId)) {
    throw referenceDanceError('INVALID_REQUEST');
  }
  if (stagingPath !== referenceDancePath('staging', userId, assetId)) {
    throw referenceDanceError('INVALID_REQUEST');
  }

  const approvedPath = referenceDancePath('approved', userId, assetId);
  const reviewPaths = Array.from({ length: 5 }, (_, i) => `review/${userId}/${assetId}/frame-${i + 1}.jpg`);
  let jobDirectory;
  const processingDeadline = Date.now() + REFERENCE_DANCE_PROCESS_TIMEOUT_MS;

  try {
    jobDirectory = fs.mkdtempSync('/tmp/pina-reference-');
    const inputFile = path.join(jobDirectory, 'input.mp4');
    const approvedFile = path.join(jobDirectory, 'approved.mp4');
    const frameFiles = reviewPaths.map((_, i) => path.join(jobDirectory, `frame-${i + 1}.jpg`));
    // A retry after a lost response may find that staging was already removed.
    // In that case the deterministic, server-only approved object is the safe
    // recovery source; browser clients never receive an upload token for it.
    let sourceBuffer = await storageBlobBuffer(stagingPath, processingDeadline);
    if (!sourceBuffer) sourceBuffer = await storageBlobBuffer(approvedPath, processingDeadline);
    if (!sourceBuffer) throw referenceDanceError('VIDEO_NOT_FOUND');
    fs.writeFileSync(inputFile, sourceBuffer);

    const probe = await referenceDanceProbe(inputFile, referenceDanceRemainingMs(processingDeadline));
    const inputMetadata = validateReferenceDanceProbe(probe);

    // Strip audio and remux into a server-owned path. The provider receives
    // this sealed copy, never the browser-writable staging object.
    await runFfmpeg(
      () => ffmpeg(inputFile)
        .outputOptions('-map', '0:v:0', '-c:v', 'copy', '-an', '-t', String(REFERENCE_DANCE_MAX_SECONDS), '-movflags', '+faststart')
        .output(approvedFile),
      referenceDanceRemainingMs(processingDeadline)
    );

    // Re-probe the exact sealed file that will be moderated, billed, and sent
    // to the provider. Input container headers are not a billing authority.
    const approvedProbe = await referenceDanceProbe(approvedFile, referenceDanceRemainingMs(processingDeadline));
    const approvedMetadata = validateReferenceDanceProbe(approvedProbe, { requireNoAudio: true });
    validateReferenceDanceDurationMatch(inputMetadata, approvedMetadata);
    const { durationSeconds: approvedDuration, durationMs, width, height, fps } = approvedMetadata;

    const positions = [0.05, 0.25, 0.5, 0.75, 0.95].map((ratio) =>
      Math.min(Math.max(0, approvedDuration * ratio), Math.max(0, approvedDuration - 0.05))
    );
    for (let i = 0; i < positions.length; i++) {
      await runFfmpeg(
        () => ffmpeg(approvedFile)
          .seekInput(positions[i])
          .frames(1)
          .outputOptions('-q:v', '2')
          .output(frameFiles[i]),
        referenceDanceRemainingMs(processingDeadline)
      );
    }

    const approvedSize = fs.statSync(approvedFile).size;
    if (!approvedSize || approvedSize > REFERENCE_DANCE_MAX_BYTES) throw referenceDanceError('VIDEO_SIZE_INVALID');
    const approvedBuffer = fs.readFileSync(approvedFile);
    if (!approvedBuffer.length || approvedBuffer.length > REFERENCE_DANCE_MAX_BYTES) {
      throw referenceDanceError('VIDEO_SIZE_INVALID');
    }
    const sha256 = crypto.createHash('sha256').update(approvedBuffer).digest('hex');
    await referenceDanceUpload(approvedFile, approvedPath, 'video/mp4', processingDeadline, 'APPROVED_UPLOAD_FAILED');
    for (let i = 0; i < frameFiles.length; i++) {
      await referenceDanceUpload(frameFiles[i], reviewPaths[i], 'image/jpeg', processingDeadline, 'REVIEW_UPLOAD_FAILED');
    }
    const { error: stagingDeleteError } = await referenceDanceWithinDeadline(
      (storage) => storage.remove([stagingPath]), processingDeadline
    );
    if (stagingDeleteError) throw referenceDanceError('STAGING_DELETE_FAILED', stagingDeleteError.message);

    return {
      ok: true,
      approvedPath,
      reviewPaths,
      sizeBytes: approvedBuffer.length,
      durationMs,
      width,
      height,
      fps: Number(fps.toFixed(3)),
      videoCodec: 'h264',
      sha256
    };
  } finally {
    try { if (jobDirectory) fs.rmSync(jobDirectory, { recursive: true, force: true }); } catch (_) {}
  }
}

app.post('/reference-dance-inspect', async (req, res) => {
  // This endpoint also fails closed when the shared secret is missing;
  // it must never become public because it reads private
  // user uploads through the service role.
  if (!WATERMARK_SECRET) return res.status(503).json({ ok: false, error: 'SERVICE_NOT_CONFIGURED' });
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (auth !== WATERMARK_SECRET) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  const { userId, assetId, stagingPath } = req.body || {};
  let acquired = false;
  try {
    await acquireSlot('edit', REFERENCE_DANCE_QUEUE_TIMEOUT_MS);
    acquired = true;
    const result = await runReferenceDanceInspection({ userId, assetId, stagingPath });
    return res.status(200).json(result);
  } catch (error) {
    if (error?.httpStatus === 429) return replyQueueError(res, error);
    console.error('[reference-dance-inspect] failed', error?.publicCode || 'PROCESSING_FAILED', error?.message);
    return res.status(422).json({ ok: false, error: error?.publicCode || 'PROCESSING_FAILED' });
  } finally {
    if (acquired) releaseSlot('edit');
  }
});

app.listen(PORT, () => {
  console.log(`FlowVid Watermark Server listening on port ${PORT}`);
});
