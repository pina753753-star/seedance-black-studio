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

// ---- concurrency guard for /watermark ----
// Without a limit, overlapping requests (e.g. a client retrying every ~10s
// while a previous attempt is still stuck/slow) each spawn their own ffmpeg
// process, multiplying peak memory/CPU and starving whatever is already
// running — this matched what production logs showed for the SIGKILL
// incidents (repeated /watermark calls piling up for the same job).
// MAX_CONCURRENT_JOBS bounds how many /watermark jobs run at once; anything
// beyond that waits in a FIFO queue instead of running in parallel.
// NOTE: /edit does not use this guard yet — it has no production traffic
// (nothing calls it), so it's out of scope for this fix. Wire /edit into the
// same guard before it goes live, since both endpoints share this container.
const MAX_CONCURRENT_JOBS = 2;
let activeJobs = 0;
const jobQueue = [];

function acquireSlot() {
  if (activeJobs < MAX_CONCURRENT_JOBS) {
    activeJobs++;
    return Promise.resolve();
  }
  return new Promise((resolve) => jobQueue.push(resolve));
}

function releaseSlot() {
  const next = jobQueue.shift();
  if (next) {
    next();
  } else {
    activeJobs--;
  }
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
  await acquireSlot();
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
    releaseSlot();
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
// 既存の /watermark には一切影響しない追加機能
// ================================================================

const EDIT_MAX_CLIPS = 6;
const EDIT_BUCKET = 'reference-images';

function editProbe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function editParseFps(rFrameRate) {
  if (!rFrameRate) return 24;
  const parts = String(rFrameRate).split('/').map(Number);
  const fps = parts.length === 2 && parts[1] ? parts[0] / parts[1] : Number(parts[0]);
  return Number.isFinite(fps) && fps > 0 && fps <= 120 ? fps : 24;
}

async function editDownload(url, filePath) {
  const response = await fetch(url, { timeout: 120000 });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = await response.buffer();
  fs.writeFileSync(filePath, buffer);
}

app.post('/edit', async (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (WATERMARK_SECRET && auth !== WATERMARK_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const { clips, transition = 'cut', transitionDuration } = req.body || {};

  if (!Array.isArray(clips) || clips.length < 1 || clips.length > EDIT_MAX_CLIPS) {
    return res.status(400).json({ ok: false, error: `clips must be an array of 1-${EDIT_MAX_CLIPS} items` });
  }
  if (!['cut', 'crossfade', 'fade'].includes(transition)) {
    return res.status(400).json({ ok: false, error: 'transition must be one of: cut, crossfade, fade' });
  }
  for (const clip of clips) {
    if (!clip || typeof clip.videoUrl !== 'string' || !/^https?:\/\//.test(clip.videoUrl)) {
      return res.status(400).json({ ok: false, error: 'each clip requires a valid videoUrl' });
    }
  }

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
      const f = makeTmp(`edit_in_${i}`);
      await editDownload(clips[i].videoUrl, f);
      inputFiles.push(f);
    }

    // 2) メタデータ取得
    const metas = [];
    for (const f of inputFiles) {
      const data = await editProbe(f);
      const v = (data.streams || []).find((s) => s.codec_type === 'video');
      const a = (data.streams || []).find((s) => s.codec_type === 'audio');
      if (!v) throw new Error('No video stream found in input');
      metas.push({
        duration: Number(data.format && data.format.duration) || 0,
        width: v.width,
        height: v.height,
        fps: editParseFps(v.r_frame_rate),
        hasAudio: !!a,
      });
    }

    // 出力解像度・fpsは1本目のクリップに合わせる
    const W = metas[0].width;
    const H = metas[0].height;
    const FPS = metas[0].fps;

    // 3) トリミング範囲を確定
    const plans = clips.map((clip, i) => {
      const dur = metas[i].duration;
      if (!Number.isFinite(dur) || dur <= 0) {
        throw new Error(`clip ${i}: could not determine video duration`);
      }
      let start = Number(clip.start);
      if (!Number.isFinite(start)) start = 0;
      if (start < 0) start = 0;
      if (start >= dur) {
        throw new Error(`clip ${i}: trim start (${start}s) is at or beyond video duration (${dur}s) — specify a start within the video`);
      }
      let end = clip.end != null ? Number(clip.end) : dur;
      if (!Number.isFinite(end)) end = dur;
      if (end > dur) end = dur;
      if (end <= start) {
        throw new Error(`clip ${i}: trim end (${end}s) must be greater than start (${start}s)`);
      }
      const tdur = end - start;
      if (tdur < 0.2) throw new Error(`clip ${i}: trim range too short (${tdur.toFixed(3)}s, minimum 0.2s)`);
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

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputFiles[i]).inputOptions(['-ss', String(p.start)]);

        if (!metas[i].hasAudio) {
          cmd = cmd
            .input('anullsrc=channel_layout=stereo:sample_rate=48000')
            .inputFormat('lavfi')
            .outputOptions(['-map', '0:v:0', '-map', '1:a:0', '-shortest']);
        }

        cmd
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
          .output(outFile)
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`ffmpeg normalize clip ${i}: ${err.message}`)))
          .run();
      });
      normFiles.push(outFile);
    }

    // 5) 結合
    const finalFile = makeTmp('edit_final');

    if (normFiles.length === 1) {
      // トリミングのみ: remuxしてfaststartを付ける
      await new Promise((resolve, reject) => {
        ffmpeg(normFiles[0])
          .outputOptions(['-c', 'copy', '-movflags', '+faststart'])
          .output(finalFile)
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`ffmpeg remux: ${err.message}`)))
          .run();
      });
    } else if (transition === 'crossfade') {
      const n = normFiles.length;
      let cmd = ffmpeg();
      normFiles.forEach((f) => {
        cmd = cmd.input(f);
      });

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

      await new Promise((resolve, reject) => {
        cmd
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
          .output(finalFile)
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`ffmpeg crossfade: ${err.message}`)))
          .run();
      });
    } else {
      // cut / fade: 単純連結（fadeは正規化時にフェード適用済み）
      const n = normFiles.length;
      let cmd = ffmpeg();
      normFiles.forEach((f) => {
        cmd = cmd.input(f);
      });
      const labels = [];
      for (let i = 0; i < n; i++) labels.push(`[${i}:v][${i}:a]`);
      const graph = `${labels.join('')}concat=n=${n}:v=1:a=1[vout][aout]`;

      await new Promise((resolve, reject) => {
        cmd
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
          .output(finalFile)
          .on('end', resolve)
          .on('error', (err) => reject(new Error(`ffmpeg concat: ${err.message}`)))
          .run();
      });
    }

    // 6) Supabase Storage にアップロード
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const fileBuffer = fs.readFileSync(finalFile);
    const storagePath = `edited/${uid}.mp4`;

    const { error: uploadError } = await supabase.storage
      .from(EDIT_BUCKET)
      .upload(storagePath, fileBuffer, { contentType: 'video/mp4', upsert: false });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data: urlData } = supabase.storage.from(EDIT_BUCKET).getPublicUrl(storagePath);

    const totalDuration =
      transition === 'crossfade' && plans.length > 1
        ? plans.reduce((s, p) => s + p.tdur, 0) - fd * (plans.length - 1)
        : plans.reduce((s, p) => s + p.tdur, 0);

    return res.json({
      ok: true,
      editedUrl: urlData.publicUrl,
      duration: Number(totalDuration.toFixed(2)),
      transition,
    });
  } catch (err) {
    console.error('[edit] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (_) {}
    }
  }
});

app.listen(PORT, () => {
  console.log(`FlowVid Watermark Server listening on port ${PORT}`);
});
