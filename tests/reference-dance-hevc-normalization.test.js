'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReferenceDanceProbe } = require('../watermark-server/reference-dance-inspection.js');
const probe = (changes = {}) => ({ format: { format_name: 'mov,mp4', duration: '4' }, streams: [{ codec_type: 'video', codec_name: 'hevc', profile: 'Main', pix_fmt: 'yuv420p', width: 3840, height: 2160, r_frame_rate: '60/1', avg_frame_rate: '60/1', ...changes }] });
const validate = p => validateReferenceDanceProbe(p, { allowHevcInput: true });
test('HEVC input opt-in accepts only bounded SDR, approved remains H264-only', () => {
  assert.equal(validate(probe()).videoCodec, 'hevc');
  assert.throws(() => validateReferenceDanceProbe(probe()), { publicCode: 'VIDEO_CODEC_UNSUPPORTED' });
  assert.throws(() => validateReferenceDanceProbe(probe(), { allowHevcInput: true, requireNoAudio: true }), { publicCode: 'VIDEO_CODEC_UNSUPPORTED' });
  assert.throws(() => validate(probe({ codec_name: 'vp9' })), { publicCode: 'VIDEO_CODEC_UNSUPPORTED' });
});
test('HEVC fps rejects absent, zero, malformed, infinite and excessive values instead of fallback', () => {
  for (const rate of ['0/0', '61/1', '120/1', '1/0', '-24', 'abc', '0.5', '1/2']) {
    assert.throws(() => validate(probe({ r_frame_rate: rate })), { publicCode: 'VIDEO_FRAMERATE_INVALID' });
    assert.throws(() => validate(probe({ avg_frame_rate: rate })), { publicCode: 'VIDEO_FRAMERATE_INVALID' });
  }
  assert.throws(() => validate(probe({ r_frame_rate: undefined, avg_frame_rate: undefined })), { publicCode: 'VIDEO_FRAMERATE_INVALID' });
  assert.equal(validate(probe({ r_frame_rate: '60000/1001', avg_frame_rate: '60000/1001' })).fps, 60000/1001);
});
test('HEVC decoded source area and dimensions are bounded before transcoding', () => {
  for (const fields of [{ width: 4096, height: 4096 }, { coded_width: 4096, coded_height: 4096 }, { coded_width: 8192 }, { width: 4097 }, { coded_width: 100 }, { coded_width: 'invalid' }]) {
    assert.throws(() => validate(probe(fields)), { publicCode: 'VIDEO_DIMENSIONS_INVALID' });
  }
  assert.equal(validate(probe({ width: 2160, height: 3840 })).width, 2160);
});
test('HDR/wide-gamut and unsupported profiles fail closed without silent color conversion', () => {
  for (const fields of [{ color_transfer: 'smpte2084' }, { color_transfer: 'arib-std-b67' }, { color_primaries: 'bt2020' }, { color_space: 'bt2020nc' }, { color_transfer: 'unrecognized' }, { side_data_list: [{ side_data_type: 'DOVI configuration record' }] }]) {
    assert.throws(() => validate(probe(fields)), { publicCode: 'VIDEO_HDR_UNSUPPORTED' });
  }
  for (const fields of [{ profile: 'Main 10' }, { pix_fmt: 'yuv420p10le' }, { bits_per_raw_sample: '10' }, { pix_fmt: 'yuv444p' }]) {
    assert.throws(() => validate(probe(fields)), { publicCode: 'VIDEO_PROFILE_UNSUPPORTED' });
  }
});
test('existing H264 probe acceptance and metadata are unchanged', () => {
  assert.equal(validate(probe({ codec_name: 'h264', width: 4096, height: 4096, r_frame_rate: '120/1' })).videoCodec, 'h264');
  assert.equal(validate(probe({ codec_name: 'h264', r_frame_rate: 'invalid' })).fps, 24);
});

test('HEVC rejects anamorphic or malformed SAR instead of distorting display aspect', () => {
  for (const sar of ['4:3', '16:15', '0:0', '1:0', 'invalid', '', '1/1']) {
    assert.throws(() => validate(probe({ sample_aspect_ratio: sar })), { publicCode: 'VIDEO_PROFILE_UNSUPPORTED' });
  }
  for (const sar of ['1:1', '2:2', 'N/A', '0:1', undefined]) {
    assert.equal(validate(probe({ sample_aspect_ratio: sar })).videoCodec, 'hevc');
  }
});
