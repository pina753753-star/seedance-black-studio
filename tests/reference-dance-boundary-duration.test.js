'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReferenceDanceProbe, referenceDanceDurationDiagnostics } = require('../watermark-server/reference-dance-inspection.js');
function probe(duration = '15.08', changes = {}) {
  return { format: { format_name: 'mp4', duration }, streams: [{ codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', width: 1920, height: 1080, duration, r_frame_rate: '24/1', avg_frame_rate: '24/1', sample_aspect_ratio: '1:1', ...changes }] };
}
const opted = p => validateReferenceDanceProbe(p, { allowHevcInput: true, allowBoundaryTrim: true });
test('boundary tolerance requires exact boolean opt-in and applies to input only', () => {
  for (const value of [undefined, false, 'true', 1]) assert.throws(() => validateReferenceDanceProbe(probe(), { allowBoundaryTrim: value }), { publicCode: 'VIDEO_DURATION_INVALID' });
  assert.equal(opted(probe()).requiresBoundaryTrim, true);
  assert.throws(() => validateReferenceDanceProbe(probe(), { allowBoundaryTrim: true, requireNoAudio: true }), { publicCode: 'VIDEO_DURATION_INVALID' });
  assert.equal(opted(probe('15')).requiresBoundaryTrim, undefined);
  assert.equal(opted(probe('15.1')).durationMs, 15100);
  assert.equal(opted(probe('16')).requiresBoundaryTrim, true);
  assert.equal(opted(probe('60')).durationMs, 60000);
  for (const duration of ['60.000001', '60.01', '61', '3.99', 'NaN', 'Infinity']) assert.throws(() => opted(probe(duration)), { publicCode: 'VIDEO_DURATION_INVALID' });
});
test('container/audio tail cannot bypass source limit and longer video cannot hide behind shorter container', () => {
  assert.equal(opted(probe('15.08', { duration: '15' })).durationMs, 15080);
  assert.throws(() => opted(probe('60.01', { duration: '15' })), { publicCode: 'VIDEO_DURATION_INVALID' });
  assert.throws(() => opted(probe('15', { duration: '60.01' })), { publicCode: 'VIDEO_DURATION_INVALID' });
});
test('boundary H264 transcode uses same bounded SDR envelope as HEVC', () => {
  for (const [fields, publicCode] of [[{ r_frame_rate: '120/1' }, 'VIDEO_FRAMERATE_INVALID'], [{ width: 4096, height: 4096 }, 'VIDEO_DIMENSIONS_INVALID'], [{ color_transfer: 'smpte2084' }, 'VIDEO_HDR_UNSUPPORTED'], [{ profile: 'High 10', pix_fmt: 'yuv420p10le' }, 'VIDEO_PROFILE_UNSUPPORTED'], [{ sample_aspect_ratio: '4:3' }, 'VIDEO_PROFILE_UNSUPPORTED']]) {
    assert.throws(() => opted(probe('15.08', fields)), { publicCode });
  }
  assert.equal(opted(probe('15.08', { codec_name: 'hevc', profile: 'Main' })).requiresBoundaryTrim, true);
});
test('duration diagnostics contain only finite bounded numbers/null and no raw metadata', () => {
  assert.deepEqual(referenceDanceDurationDiagnostics({ format: { duration: '15.08', filename: 'SECRET' }, streams: [{ codec_type: 'video', duration: '15' }, { codec_type: 'audio', duration: '15.07' }, { codec_type: 'audio', duration: '15.08' }] }), { containerSeconds: 15.08, videoSeconds: 15, audioSeconds: 15.08 });
  for (const value of ['SECRET', 'Infinity', '-1', '86401', undefined, null, '']) {
    assert.deepEqual(referenceDanceDurationDiagnostics({ format: { duration: value }, streams: [{ codec_type: 'video', duration: value }, { codec_type: 'audio', duration: value }] }), { containerSeconds: null, videoSeconds: null, audioSeconds: null });
  }
});
