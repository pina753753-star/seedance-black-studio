'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateReferenceDanceProbe: validate, planMotionOutput, motionOutputOptions, validateMotionOutput } = require('../watermark-server/reference-dance-inspection');
const fixture = (extra = {}) => ({ format: { format_name: 'mov,mp4', duration: '8' }, streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080, duration: '8', r_frame_rate: '600/1', avg_frame_rate: '60000/1001', ...extra }] });
const input = { motion: true, allowHevcInput: true };
test('VFR nominal base rate does not reject a bounded 59.94 average; legacy HEVC remains strict', () => {
  assert.equal(validate(fixture(), input).fps, 60000 / 1001);
  assert.throws(() => validate(fixture({ codec_name: 'hevc', profile: 'Main' }), { allowHevcInput: true }), { publicCode: 'VIDEO_FRAMERATE_INVALID' });
});
test('motion HFR requires bounded average, pixel workload and sample count', () => {
  assert.equal(validate(fixture({ avg_frame_rate: '120/1', r_frame_rate: '120/1' }), input).fps, 120);
  for (const avg_frame_rate of [undefined, '0/0', 'bad', '1/0', '121/1', '0/1']) assert.throws(() => validate(fixture({ avg_frame_rate }), input), { publicCode: 'VIDEO_FRAMERATE_INVALID' });
  for (const extra of [{ width: 3840, height: 2160, avg_frame_rate: '120/1' }, { nb_frames: '7201' }, { nb_frames: '2000' }, { nb_frames: '-1' }]) assert.throws(() => validate(fixture(extra), input), { publicCode: 'VIDEO_FRAMERATE_INVALID' });
  assert.throws(() => validate(fixture(), { motion: true, requireNoAudio: true }), { publicCode: 'VIDEO_FRAMERATE_INVALID' });
});
test('real VFR screen-recording and HFR normalize to CFR30; cuts, billing and original hash remain correct', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-fps-'));
  const run = args => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 90000, stdio: 'pipe' });
  const probe = f => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], { timeout: 15000 }));
  const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  try {
    for (const vfr of [true, false]) {
      const source = path.join(dir, vfr ? 'screen.mov' : '120fps.mov');
      run(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=120:duration=32.2', ...(vfr ? ['-vf', "select='if(lt(mod(n,120),60),not(mod(n,2)),not(mod(n,3)))'", '-fps_mode', 'vfr'] : []), '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', source]);
      const originalHash = hash(source), p = probe(source), meta = validate(p, input);
      assert.ok(Number(p.streams[0].r_frame_rate.split('/')[0]) >= 120);
      if (vfr) assert.ok(meta.fps < 60);
      for (const useSeconds of [null, 16, 4]) {
        const plan = planMotionOutput({ sourceDurationSeconds: Number(p.streams[0].duration), useSeconds });
        const output = path.join(dir, `out-${vfr}-${useSeconds}.mp4`);
        run(['-protocol_whitelist', 'file,pipe', '-threads', '1', '-i', source, ...motionOutputOptions(plan, 50 * 1024 * 1024), output]);
        const result = probe(output), approved = validate(result, { motion: true, requireNoAudio: true });
        validateMotionOutput(plan, approved);
        assert.equal(approved.durationMs, (useSeconds || 30) * 1000);
        assert.equal(Math.ceil(approved.durationMs / 1000) * 19, (useSeconds || 30) * 19);
        assert.equal(result.streams[0].r_frame_rate, '30/1');
        assert.equal(result.streams[0].avg_frame_rate, '30/1');
        assert.equal(result.streams[0].pix_fmt, 'yuv420p');
        assert.equal(result.streams[0].codec_name, 'h264');
        assert.equal(hash(source), originalHash);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
