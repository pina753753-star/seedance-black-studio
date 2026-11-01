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


test('30s output: auto16, auto30, source45->30, shorter16, original remains untouched', {skip},()=>{
 const crypto=require('node:crypto');
 for(const sec of [16,30,45]){const f=synth(`thirty-${sec}.mp4`,{seconds:sec,size:'640x360',rate:30,audio:true});const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');const before=hash();const a=inspect(f);assert.equal(a.approved.durationMs,Math.min(sec,30)*1000);assert.equal(a.billable*19,Math.min(sec,30)*19);if(sec===45){const b=inspect(f,16);assert.equal(b.approved.durationMs,16000);assert.equal(b.billable*19,304);}assert.equal(hash(),before);}
});
test('30s bounds: source60 permitted; source60+ rejected; no extending or over30',()=>{
 const f=synth('thirty-16.mp4',{seconds:16,size:'640x360',rate:30,audio:true});const p=probe(f);p.format.duration='60';p.streams.find(s=>s.codec_type==='video').duration='60';assert.equal(validateReferenceDanceProbe(p,{motion:true}).durationMs,60000);p.format.duration='60.001';assert.throws(()=>validateReferenceDanceProbe(p,{motion:true}),code('VIDEO_DURATION_INVALID'));
 assert.equal(planMotionOutput({sourceDurationSeconds:45}).frames,900);assert.throws(()=>planMotionOutput({sourceDurationSeconds:16,useSeconds:17}),code('MOTION_USE_EXCEEDS_SOURCE'));assert.throws(()=>planMotionOutput({sourceDurationSeconds:45,useSeconds:31}),code('MOTION_USE_SECONDS_INVALID'));assert.throws(()=>validateMotionOutput(planMotionOutput({sourceDurationSeconds:45}),{durationMs:30001}),code('VIDEO_DURATION_MISMATCH'));
});
