'use strict';
// Real FFmpeg/FFprobe run on local synthetic videos (nothing is uploaded or sent anywhere): the motion
// inspection profile cuts / keeps exactly what was planned, measured on the sealed output file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  validateReferenceDanceProbe, planMotionOutput, validateMotionOutput, motionOutputOptions, videoStreamSeconds
} = require('../watermark-server/reference-dance-inspection.js');

function have(bin) { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } }
const HAVE = have('ffmpeg') && have('ffprobe');
const skip = HAVE ? false : 'ffmpeg/ffprobe are not installed in this environment (motion transcode not verified here)';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-test-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });

function synth(name, { seconds, size = '1280x720', rate = 24, audio = false, codec = 'libx264', audioSeconds = null }) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return file;
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${audioSeconds || seconds}`);
  args.push('-c:v', codec, '-pix_fmt', 'yuv420p', ...(codec === 'libx265' ? ['-tag:v', 'hvc1'] : []));
  if (audio) args.push('-c:a', 'aac', ...(audioSeconds ? [] : ['-shortest']));
  args.push(file);
  execFileSync('ffmpeg', args);
  return file;
}
function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
}
// The same steps as runMotionReferenceInspection, minus storage.
function inspect(file, useSeconds = null) {
  const input = validateReferenceDanceProbe(probe(file), { allowHevcInput: true, motion: true });
  const plan = planMotionOutput({ sourceDurationSeconds: videoStreamSeconds(probe(file), input.durationSeconds), useSeconds });
  const out = path.join(dir, `out-${path.basename(file)}-${useSeconds}-${Math.random().toString(36).slice(2)}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', file, ...motionOutputOptions(plan, 50 * 1024 * 1024), out]);
  const outProbe = probe(out);
  const approved = validateReferenceDanceProbe(outProbe, { requireNoAudio: true, motion: true });
  validateMotionOutput(plan, approved);
  const frames = Number(outProbe.streams.find(s => s.codec_type === 'video').nb_frames);
  return { plan, input, approved, billable: Math.max(4, Math.ceil(approved.durationMs / 1000)), frames, hasAudio: outProbe.streams.some(s => s.codec_type === 'audio'), fps: approved.fps };
}
const code = (c) => (e) => e.publicCode === c;

test('whole source 16.2 s (24 fps, with audio): kept whole, 17 billed seconds, no audio, 30 fps', { skip }, () => {
  const r = inspect(synth('s16_2.mp4', { seconds: 16.2, audio: true }));
  assert.equal(r.plan.mode, 'whole');
  // The 24 fps synthetic source really contains 388 frames (16.167 s) although its container says 16.2 s: the output
  // keeps every frame it has (485 at 30 fps) and never pads. Either way it is billed as 17 seconds (323 cr).
  assert.ok(r.approved.durationMs >= 16100 && r.approved.durationMs <= 16200, String(r.approved.durationMs));
  assert.equal(r.billable, 17);
  assert.equal(r.billable * 19, 323);
  assert.ok(r.frames >= 484 && r.frames <= 486, String(r.frames));
  assert.equal(r.hasAudio, false);
  assert.equal(r.fps, 30);
});

test('16.2 s source, first 16 s chosen: exactly 16.000 s, 16 billed seconds (304 cr), not 17', { skip }, () => {
  const r = inspect(synth('s16_2.mp4', { seconds: 16.2, audio: true }), 16);
  assert.equal(r.approved.durationMs, 16000);
  assert.equal(r.billable, 16);
  assert.equal(r.billable * 19, 304);
});

test('15 s from a 16 s source: exactly 15.000 s, 285 cr; a 16.000 s source whole is 16 s (not 17)', { skip }, () => {
  const s16 = synth('s16.mp4', { seconds: 16, rate: 30 });
  const cut = inspect(s16, 15);
  assert.equal(cut.approved.durationMs, 15000);
  assert.equal(cut.billable * 19, 285);
  const whole = inspect(s16);
  assert.equal(whole.approved.durationMs, 16000);
  assert.equal(whole.billable, 16);
});

test('every integer choice 4..16 from a 16.2 s source is exactly that long (frame-boundary drift cannot add a second)', { skip }, () => {
  const src = synth('s16_2.mp4', { seconds: 16.2, audio: true });
  for (let n = 4; n <= 16; n++) {
    const r = inspect(src, n);
    assert.equal(r.approved.durationMs, n * 1000, `n=${n}`);
    assert.equal(r.billable, n, `n=${n}`);
  }
});

test('25 s 60 fps 1080p source: whole use is capped at the first 20 s; cutting 10 and 20 is exact; downscaled to 720p', { skip }, () => {
  const src = synth('s25.mp4', { seconds: 25, size: '1920x1080', rate: 60, audio: true });
  const whole = inspect(src);
  assert.equal(whole.plan.capped, true);
  assert.equal(whole.approved.durationMs, 20000);
  assert.equal(whole.billable * 19, 380);
  assert.equal(whole.approved.height, 720);
  assert.equal(inspect(src, 10).approved.durationMs, 10000);
  assert.equal(inspect(src, 20).approved.durationMs, 20000);
});

test('boundaries around 10 s and 20 s of the original: 10.0 s whole = 10 (image setting), 20.0 s whole not capped, 20.02 s capped', { skip }, () => {
  const ten = inspect(synth('s10.mp4', { seconds: 10, rate: 30 }));
  assert.equal(ten.approved.durationMs, 10000);
  const twenty = inspect(synth('s20.mp4', { seconds: 20, rate: 30 }));
  assert.equal(twenty.plan.capped, false);
  assert.equal(twenty.approved.durationMs, 20000);
  const over = inspect(synth('s20_02.mp4', { seconds: 20.04, rate: 30 }));
  assert.equal(over.plan.capped, true);
  assert.equal(over.approved.durationMs, 20000);
});

test('HEVC source is accepted and sealed as H.264', { skip: skip || (have('ffmpeg') ? false : skip) }, () => {
  const r = inspect(synth('hevc17.mp4', { seconds: 17, codec: 'libx265' }), 12);
  assert.equal(r.approved.durationMs, 12000);
  assert.equal(r.approved.videoCodec, 'h264');
});

test('rejections: a longer choice than the source, out-of-range choices, too short, too long', { skip }, () => {
  const s4 = synth('s4.mp4', { seconds: 4, rate: 30 });
  assert.equal(inspect(s4).approved.durationMs, 4000);
  assert.equal(inspect(s4, 4).approved.durationMs, 4000);
  assert.throws(() => inspect(s4, 5), code('MOTION_USE_EXCEEDS_SOURCE'));
  const s16 = synth('s16.mp4', { seconds: 16, rate: 30 });
  assert.throws(() => inspect(s16, 3), code('MOTION_USE_SECONDS_INVALID'));
  assert.throws(() => inspect(s16, 21), code('MOTION_USE_SECONDS_INVALID'));
  assert.throws(() => inspect(s16, 12.5), code('MOTION_USE_SECONDS_INVALID'));
  assert.throws(() => inspect(synth('s3_5.mp4', { seconds: 3.5, rate: 30 })), code('VIDEO_DURATION_INVALID'));
  assert.throws(() => inspect(synth('s31.mp4', { seconds: 31, rate: 30 })), code('VIDEO_DURATION_INVALID'));
});

test('an audio tail longer than the video never asks for frames that do not exist: the whole-use plan follows the video stream', { skip }, () => {
  const r = inspect(synth('audio_tail.mp4', { seconds: 10, rate: 30, audio: true, audioSeconds: 12.5 }));
  assert.ok(r.approved.durationMs <= 10000 && r.approved.durationMs > 9000, String(r.approved.durationMs));
  assert.equal(r.billable, 10);
  assert.equal(r.hasAudio, false);
});

test('plan and output validation (no FFmpeg): never extends, never exceeds the plan, at most one second short', () => {
  assert.deepEqual({ ...planMotionOutput({ sourceDurationSeconds: 16.2 }) }, { mode: 'whole', frames: 486, useSeconds: null, capped: false });
  assert.deepEqual({ ...planMotionOutput({ sourceDurationSeconds: 16.2, useSeconds: 15 }) }, { mode: 'cut', frames: 450, useSeconds: 15, capped: false });
  assert.equal(planMotionOutput({ sourceDurationSeconds: 30 }).frames, 600);
  assert.throws(() => planMotionOutput({ sourceDurationSeconds: 16, useSeconds: 17 }), code('MOTION_USE_EXCEEDS_SOURCE'));
  const plan = { frames: 450 };
  assert.ok(validateMotionOutput(plan, { durationMs: 15000 }));
  assert.ok(validateMotionOutput(plan, { durationMs: 14034 }));
  assert.throws(() => validateMotionOutput(plan, { durationMs: 15001 }), code('VIDEO_DURATION_MISMATCH'));
  assert.throws(() => validateMotionOutput(plan, { durationMs: 14000 }), code('VIDEO_DURATION_MISMATCH'));
  assert.throws(() => validateMotionOutput({ frames: 700 }, { durationMs: 23333 }), code('VIDEO_DURATION_MISMATCH'));
});
