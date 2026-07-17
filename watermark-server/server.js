const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ffmpeg-static is not used; system ffmpeg is used via Dockerfile
// ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
app.use(express.json({ limit: '10mb' }));

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
let activeJobs = 0;
let activeEditJobs = 0;
const jobQueue = []; // { type: 'watermark' | 'edit', resolve }

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
      activeJobs++;
      if (item.type === 'edit') activeEditJobs++;
      item.resolve();
      i--;
    }
  }
}

function acquireSlot(type = 'watermark') {
  if (canRunJob(type)) {
    activeJobs++;
    if (type === 'edit') activeEditJobs++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const item = { type, resolve };
    if (type === 'watermark') {
      // Jump ahead of any queued /edit jobs, but stay behind other queued
      // /watermark jobs (FIFO within the same priority).
      let idx = jobQueue.findIndex((q) => q.type === 'edit');
      if (idx === -1) idx = jobQueue.length;
      jobQueue.splice(idx, 0, item);
    } else {
      jobQueue.push(item);
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
      })
      .run();
  });
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
  const uid = uuidv4();
  const inputFile = path.join('/tmp', `in_${uid}.mp4`);
  const outputFile = path.join('/tmp', `out_${uid}.mp4`);

  try {
    const response = await fetch(videoUrl, { timeout: 120000 });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = await response.buffer();
    fs.writeFileSync(inputFile, buffer);

    await runFfmpeg(() =>
      ffmpeg(inputFile)
        .outputOptions([
          '-vf', "drawtext=text=FlowVid:fontsize=28:fontcolor=white@0.85:x=w-tw-20:y=h-th-20:shadowcolor=black@0.8:shadowx=2:shadowy=2",
          '-c:a', 'copy',
          '-movflags', '+faststart'
        ])
        .output(outputFile)
    );

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const fileBuffer = fs.readFileSync(outputFile);
    const storagePath = `watermarked/${uid}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from('reference-images')
      .upload(storagePath, fileBuffer, { contentType: 'video/mp4', upsert: false });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage
      .from('reference-images')
      .getPublicUrl(storagePath);

    return { ok: true, watermarkedUrl: urlData.publicUrl };
  } catch (err) {
    console.error('[watermark] error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    try { if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile); } catch (_) {}
    try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch (_) {}
    releaseSlot('watermark');
  }
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'FlowVid Watermark Server', version: '1.0.0' });
});

app.post('/watermark', async (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (WATERMARK_SECRET && auth !== WATERMARK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const { videoUrl } = req.body;
  if (!videoUrl) return res.status(400).json({ ok: false, error: 'videoUrl is required' });

  let jobPromise = inFlightWatermarks.get(videoUrl);
  if (!jobPromise) {
    jobPromise = runWatermarkJob(videoUrl).finally(() => inFlightWatermarks.delete(videoUrl));
    inFlightWatermarks.set(videoUrl, jobPromise);
  }

  const result = await jobPromise;
  return res.status(result.ok ? 200 : 500).json(result);
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
  if (typeof raw !== 'string') return false;
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

function editProbe(file, deadline) {
  const timeoutMs = Math.max(1000, Math.min(EDIT_FFPROBE_TIMEOUT_MS, remainingMs(deadline)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ffprobe timed out')), timeoutMs);
    ffmpeg.ffprobe(file, (err, data) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function editParseFps(rFrameRate) {
  if (!rFrameRate) return 24;
  const parts = String(rFrameRate).split('/').map(Number);
  const fps = parts.length === 2 && parts[1] ? parts[0] / parts[1] : Number(parts[0]);
  return Number.isFinite(fps) && fps > 0 && fps <= 120 ? fps : 24;
}

async function editDownload(url, filePath, deadline) {
  const timeoutMs = Math.max(1000, Math.min(EDIT_DOWNLOAD_TIMEOUT_MS, remainingMs(deadline)));
  // redirect: 'manual' means a 3xx response is returned as-is (not
  // followed) instead of being validated against the host allowlist again,
  // so it simply fails the !response.ok check below rather than letting a
  // clip source redirect us to an arbitrary off-allowlist host.
  const response = await fetch(url, { timeout: timeoutMs, redirect: 'manual' });
  if (!response.ok) throw editError('CLIP_DOWNLOAD_FAILED', `Download failed: ${response.status}`);

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > EDIT_MAX_DOWNLOAD_BYTES) {
    throw editError('CLIP_TOO_LARGE', `clip content-length ${contentLength} exceeds ${EDIT_MAX_DOWNLOAD_BYTES}`);
  }

  await new Promise((resolve, reject) => {
    let total = 0;
    let rejected = false;
    const dest = fs.createWriteStream(filePath);
    const fail = (err) => {
      if (rejected) return;
      rejected = true;
      try { dest.destroy(); } catch (_) {}
      try { response.body.destroy(); } catch (_) {}
      reject(err);
    };
    response.body.on('data', (chunk) => {
      total += chunk.length;
      if (total > EDIT_MAX_DOWNLOAD_BYTES) {
        fail(editError('CLIP_TOO_LARGE', `clip body exceeded ${EDIT_MAX_DOWNLOAD_BYTES} bytes`));
      }
    });
    response.body.on('error', fail);
    dest.on('error', fail);
    dest.on('finish', () => {
      if (!rejected) resolve();
    });
    response.body.pipe(dest);
  });
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

async function runEditJob({ clips, transition, transitionDuration, ownerSegment }) {
  // Single deadline for the whole request, created before any work starts.
  const deadline = Date.now() + EDIT_REQUEST_TIMEOUT_MS;
  const uid = uuidv4();
  const tempFiles = [];
  const makeTmp = (name) => {
    const p = path.join('/tmp', `${name}_${uid}.mp4`);
    tempFiles.push(p);
    return p;
  };

  try {
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
        throw editError('CLIP_UNREADABLE', `probe failed: ${err.message}`);
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

    // 6) Supabase Storage にアップロード（ユーザー/ジョブ単位でパスを分離）
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const fileBuffer = fs.readFileSync(finalFile);
    const storagePath = `edited/${ownerSegment}/${uid}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from(EDIT_BUCKET)
      .upload(storagePath, fileBuffer, { contentType: 'video/mp4', upsert: false });
    if (uploadError) throw editError('UPLOAD_FAILED', `Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from(EDIT_BUCKET).getPublicUrl(storagePath);

    const totalDuration =
      transition === 'crossfade' && plans.length > 1
        ? plans.reduce((s, p) => s + p.tdur, 0) - fd * (plans.length - 1)
        : plans.reduce((s, p) => s + p.tdur, 0);

    return {
      ok: true,
      editedUrl: urlData.publicUrl,
      duration: Number(totalDuration.toFixed(2)),
      transition,
    };
  } catch (err) {
    console.error('[edit] error:', err.publicCode || 'UNKNOWN', err.message);
    return { ok: false, error: safeEditErrorMessage(err) };
  } finally {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (_) {}
    }
  }
}

app.post('/edit', async (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (WATERMARK_SECRET && auth !== WATERMARK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { clips, transition = 'cut', transitionDuration, userId } = req.body || {};

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

  const ownerSegment = typeof userId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(userId) ? userId : 'unassigned';

  await acquireSlot('edit');
  let result;
  try {
    result = await runEditJob({ clips, transition, transitionDuration, ownerSegment });
  } finally {
    releaseSlot('edit');
  }

  return res.status(result.ok ? 200 : 500).json(result);
});

app.listen(PORT, () => {
  console.log(`FlowVid Watermark Server listening on port ${PORT}`);
});
