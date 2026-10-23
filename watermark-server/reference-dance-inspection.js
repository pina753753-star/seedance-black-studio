'use strict';

const MIN_SECONDS = 4;
const MAX_SECONDS = 15;

function inspectionError(code) {
  return Object.assign(new Error(code), { publicCode: code });
}

function parseFps(value) {
  if (!value) return 24;
  const parts = String(value).split('/').map(Number);
  const fps = parts.length === 2 && parts[1] ? parts[0] / parts[1] : Number(parts[0]);
  return Number.isFinite(fps) && fps > 0 && fps <= 120 ? fps : 24;
}

function validateReferenceDanceProbe(probe, { requireNoAudio = false, allowHevcInput = false } = {}) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (!video) throw inspectionError('VIDEO_STREAM_MISSING');
  if (requireNoAudio && streams.some((stream) => stream?.codec_type === 'audio')) {
    throw inspectionError('VIDEO_AUDIO_STRIP_FAILED');
  }
  const formatName = String(probe?.format?.format_name || '').toLowerCase();
  if (!formatName.split(',').includes('mp4')) throw inspectionError('VIDEO_CONTAINER_INVALID');
  const codec = String(video.codec_name || '').toLowerCase();
  if (codec !== 'h264' && !(allowHevcInput && !requireNoAudio && codec === 'hevc')) {
    throw inspectionError('VIDEO_CODEC_UNSUPPORTED');
  }

  const durationSeconds = Number(probe?.format?.duration || video.duration || 0);
  // Never round a fractional millisecond down across a billable-second
  // boundary: provider pricing rounds the exact source duration upward.
  const durationMs = Math.ceil(durationSeconds * 1000);
  if (!Number.isSafeInteger(durationMs) || durationSeconds < MIN_SECONDS || durationSeconds > MAX_SECONDS) {
    throw inspectionError('VIDEO_DURATION_INVALID');
  }
  const width = Number(video.width || 0);
  const height = Number(video.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw inspectionError('VIDEO_DIMENSIONS_INVALID');
  }
  let fps = parseFps(video.r_frame_rate || video.avg_frame_rate);
  if (codec === 'hevc') {
    // Bound source decoding, not merely the scaled output. Compressed byte
    // size and duration alone do not bound decoded frame memory or work.
    const codedWidth = Number(video.coded_width || width);
    const codedHeight = Number(video.coded_height || height);
    if (width * height > 3840 * 2160 || !Number.isInteger(codedWidth) || !Number.isInteger(codedHeight)
      || codedWidth < width || codedHeight < height || codedWidth > 4096 || codedHeight > 4096
      || codedWidth * codedHeight > 3840 * 2160) throw inspectionError('VIDEO_DIMENSIONS_INVALID');
    const rates = [video.r_frame_rate, video.avg_frame_rate].filter(value => value !== undefined);
    if (!rates.length) throw inspectionError('VIDEO_FRAMERATE_INVALID');
    const parsedRates = rates.map(value => {
      const match = /^(\d+)(?:\/(\d+))?$/.exec(String(value));
      if (!match) return NaN;
      return Number(match[1]) / (match[2] === undefined ? 1 : Number(match[2]));
    });
    if (parsedRates.some(rate => !Number.isFinite(rate) || rate < 1 || rate > 60)) {
      throw inspectionError('VIDEO_FRAMERATE_INVALID');
    }
    fps = parsedRates[0];
    const transfer = String(video.color_transfer || '').toLowerCase();
    const primaries = String(video.color_primaries || '').toLowerCase();
    const colorSpace = String(video.color_space || '').toLowerCase();
    const sdrTransfers = ['', 'unknown', 'unspecified', 'bt709', 'smpte170m', 'gamma22', 'gamma28', 'bt470m', 'bt470bg'];
    const sdrPrimaries = ['', 'unknown', 'unspecified', 'bt709', 'smpte170m', 'bt470m', 'bt470bg'];
    const sdrSpaces = ['', 'unknown', 'unspecified', 'bt709', 'smpte170m', 'bt470bg'];
    if (!sdrTransfers.includes(transfer) || !sdrPrimaries.includes(primaries) || !sdrSpaces.includes(colorSpace)
      || (video.side_data_list || []).some(item => /mastering|content light|dovi|dolby/i.test(String(item.side_data_type || '')))) {
      throw inspectionError('VIDEO_HDR_UNSUPPORTED');
    }
    // The scale filter operates on pixel dimensions and emits square pixels.
    // Reject anamorphic sources instead of silently changing display shape.
    // Missing/N/A/0:1 denote unspecified SAR; FFmpeg treats those as square.
    const sar = video.sample_aspect_ratio;
    if (sar !== undefined && sar !== null && sar !== 'N/A' && sar !== '0:1') {
      const match = /^(\d+):(\d+)$/.exec(String(sar));
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1
        || Number(match[1]) !== Number(match[2])) throw inspectionError('VIDEO_PROFILE_UNSUPPORTED');
    }
    if (video.pix_fmt !== 'yuv420p' || video.profile !== 'Main'
      || (Number(video.bits_per_raw_sample || 8) !== 8)) throw inspectionError('VIDEO_PROFILE_UNSUPPORTED');
  }
  return Object.freeze({
    durationSeconds,
    durationMs,
    width,
    height,
    fps,
    videoCodec: codec
  });
}

function validateReferenceDanceDurationMatch(inputMetadata, approvedMetadata, maxDeltaMs = 250) {
  const inputMs = Number(inputMetadata?.durationMs);
  const approvedMs = Number(approvedMetadata?.durationMs);
  if (!Number.isSafeInteger(inputMs)
      || !Number.isSafeInteger(approvedMs)
      || Math.abs(inputMs - approvedMs) > maxDeltaMs) {
    throw inspectionError('VIDEO_DURATION_MISMATCH');
  }
  return true;
}

module.exports = { validateReferenceDanceProbe, validateReferenceDanceDurationMatch };
