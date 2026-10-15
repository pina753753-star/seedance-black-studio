'use strict';

const MIN_SECONDS = 2;
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

function validateReferenceDanceProbe(probe, { requireNoAudio = false } = {}) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  if (!video) throw inspectionError('VIDEO_STREAM_MISSING');
  if (requireNoAudio && streams.some((stream) => stream?.codec_type === 'audio')) {
    throw inspectionError('VIDEO_AUDIO_STRIP_FAILED');
  }
  const formatName = String(probe?.format?.format_name || '').toLowerCase();
  if (!formatName.split(',').includes('mp4')) throw inspectionError('VIDEO_CONTAINER_INVALID');
  if (String(video.codec_name || '').toLowerCase() !== 'h264') throw inspectionError('VIDEO_CODEC_UNSUPPORTED');

  const durationSeconds = Number(probe?.format?.duration || video.duration || 0);
  const durationMs = Math.round(durationSeconds * 1000);
  if (!Number.isSafeInteger(durationMs) || durationSeconds < MIN_SECONDS || durationSeconds > MAX_SECONDS) {
    throw inspectionError('VIDEO_DURATION_INVALID');
  }
  const width = Number(video.width || 0);
  const height = Number(video.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw inspectionError('VIDEO_DIMENSIONS_INVALID');
  }
  return Object.freeze({
    durationSeconds,
    durationMs,
    width,
    height,
    fps: parseFps(video.r_frame_rate || video.avg_frame_rate),
    videoCodec: 'h264'
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
