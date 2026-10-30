'use strict';
// Synthetic iPhone-style MOV files through the worker's real probe, validation and the same ffmpeg arguments it uses
// (copy path for H.264, transcode path for SDR HEVC). Everything is generated locally; nothing is uploaded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { probeVideoFile } = require('../watermark-server/worker-probe.js');
const { validateReferenceDanceProbe } = require('../watermark-server/reference-dance-inspection.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mov-worker-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 60000 });
const code = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// portrait 886x1920 screen-recording look: 60 fps, AAC audio, QuickTime container
function makeMov(name, { seconds = 6, codec = 'libx264', fps = 60, audio = true, size = '886x1920' } = {}) {
  const file = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${fps}:d=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:d=${seconds}`);
  args.push('-c:v', codec, '-pix_fmt', 'yuv420p');
  if (codec === 'libx265') args.push('-tag:v', 'hvc1', '-x265-params', 'log-level=error');
  if (audio) args.push('-c:a', 'aac');
  args.push('-f', 'mov', file);
  run(args);
  return file;
}

async function inspect(file) {
  const probe = await probeVideoFile({ filePath: file, timeoutMs: 20000 });
  const input = validateReferenceDanceProbe(probe, { allowHevcInput: true });
  const out = file + '.approved.mp4';
  const args = ['-i', file, '-map', '0:v:0'];
  if (input.videoCodec === 'hevc') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-vf', "scale=w='min(iw,if(gte(iw,ih),1280,720))':h='min(ih,if(gte(iw,ih),720,1280))'", '-pix_fmt', 'yuv420p');
  } else args.push('-c:v', 'copy');
  args.push('-an', '-t', '15', '-movflags', '+faststart', out);
  run(args);
  const sealed = validateReferenceDanceProbe(await probeVideoFile({ filePath: out, timeoutMs: 20000 }), { requireNoAudio: true });
  return { input, sealed, out, probe };
}

test('iPhone-style H.264 MOV (60 fps, AAC audio): accepted, audio removed, sealed as MP4 with the measured length', async () => {
  const mov = makeMov('rec-h264.mov');
  const { probe, input, sealed } = await inspect(mov);
  assert.match(probe.format.format_name, /mov/);
  assert.equal(input.videoCodec, 'h264');
  assert.ok(sealed.durationMs >= 5900 && sealed.durationMs <= 6200, String(sealed.durationMs));
  assert.equal(sealed.durationMs >= 4000 && sealed.durationMs <= 10000, true, 'inside the 4-10 s motion window');
  const sealedProbe = await probeVideoFile({ filePath: mov + '.approved.mp4', timeoutMs: 20000 });
  assert.equal(sealedProbe.streams.some((s) => s.codec_type === 'audio'), false);
  assert.equal(sealedProbe.streams.find((s) => s.codec_type === 'video').codec_name, 'h264');
});

test('SDR HEVC MOV is normalized to H.264 MP4 within the portrait bounds', async () => {
  const mov = makeMov('rec-hevc.mov', { codec: 'libx265', seconds: 5 });
  const { input, sealed, out } = await inspect(mov);
  assert.equal(input.videoCodec, 'hevc');
  assert.equal(sealed.videoCodec, 'h264');
  assert.ok(sealed.width <= 720 && sealed.height <= 1280, `${sealed.width}x${sealed.height}`);
  const sealedProbe = await probeVideoFile({ filePath: out, timeoutMs: 20000 });
  assert.equal(sealedProbe.streams.some((s) => s.codec_type === 'audio'), false);
});

test('length rules are unchanged for MOV: too short and too long are refused (4-15 s admission, 4-10 s motion)', async () => {
  const short = await probeVideoFile({ filePath: makeMov('short.mov', { seconds: 1 }), timeoutMs: 20000 });
  assert.equal(code(() => validateReferenceDanceProbe(short, { allowHevcInput: true })), 'VIDEO_DURATION_INVALID');
  const long = await probeVideoFile({ filePath: makeMov('long.mov', { seconds: 20, size: '320x568', fps: 30 }), timeoutMs: 20000 });
  assert.equal(code(() => validateReferenceDanceProbe(long, { allowHevcInput: true })), 'VIDEO_DURATION_INVALID');
  // the motion window (4-10 s, billed 19 cr/s) is enforced by the API on the sealed length
  const klingDance = require('../api/_lib/reference-dance.js').klingDance;
  assert.equal(klingDance.validateKlingDanceDuration({ durationMs: 6000, billableSeconds: 6 }), 6);
  assert.throws(() => klingDance.validateKlingDanceDuration({ durationMs: 10001, billableSeconds: 11 }), /kling_dance_duration_unsupported/);
  assert.throws(() => klingDance.validateKlingDanceDuration({ durationMs: 3999, billableSeconds: 4 }), /kling_dance_duration_unsupported/);
  assert.equal(klingDance.klingDanceCredits(6, 19), 114, '19 cr per second');
});

test('files that are not real videos are refused regardless of name or declared type', async () => {
  const fake = path.join(dir, 'fake.mov');
  fs.writeFileSync(fake, 'this is just text pretending to be a video');
  await assert.rejects(probeVideoFile({ filePath: fake, timeoutMs: 20000 }));
  const audioOnly = path.join(dir, 'audio.mov');
  run(['-f', 'lavfi', '-i', 'sine=frequency=440:d=6', '-c:a', 'aac', '-f', 'mov', audioOnly]);
  const probe = await probeVideoFile({ filePath: audioOnly, timeoutMs: 20000 });
  assert.equal(code(() => validateReferenceDanceProbe(probe, { allowHevcInput: true })), 'VIDEO_STREAM_MISSING');
});
