'use strict';

const MIN_SECONDS = 4;
const MAX_SECONDS = 15;
const MAX_TRIMMABLE_INPUT_SECONDS = 60;
// Motion (Kling) profile: the source may be up to 60 s (well inside the existing 60 s
// trimmable-input precedent), but at most the first 30 s are ever transcoded or used.
const MOTION_MIN_USE_SECONDS = 4;
const MOTION_MAX_USE_SECONDS = 30;
const MOTION_MAX_SOURCE_SECONDS = 60;
const MOTION_FPS = 30;

function inspectionError(code) {
  return Object.assign(new Error(code), { publicCode: code });
}

// Fixed fields and enumerated values only: never log arbitrary stream tags,
// file paths, media contents, URLs or native FFmpeg error text.
function motionMediaDiagnostics(probe) {
  const v = probe?.streams?.find(s => s?.codec_type === 'video') || {};
  const pick = (value, allowed) => allowed.includes(value) ? value : 'unknown';
  const sar = /^(\d{1,5}):(\d{1,5})$/.test(String(v.sample_aspect_ratio)) ? v.sample_aspect_ratio : 'unknown';
  return {
    codec: pick(v.codec_name, ['h264', 'hevc']),
    pix_fmt: pick(v.pix_fmt, ['yuv420p', 'yuvj420p', 'yuv420p10le', 'yuv422p', 'yuv444p']),
    profile: pick(v.profile, ['Main', 'Main 10', 'High', 'High 10', 'Baseline', 'Constrained Baseline']),
    depth: pick(String(v.bits_per_raw_sample || ''), ['8', '10', '12']),
    sar,
    range: pick(v.color_range, ['pc', 'tv']),
    transfer: pick(v.color_transfer, ['bt709', 'smpte170m', 'smpte2084', 'arib-std-b67']),
    primaries: pick(v.color_primaries, ['bt709', 'smpte170m', 'bt2020']),
    space: pick(v.color_space, ['bt709', 'smpte170m', 'bt470bg', 'bt2020nc', 'bt2020c'])
  };
}

function parseFps(value) {
  if (!value) return 24;
  const parts = String(value).split('/').map(Number);
  const fps = parts.length === 2 && parts[1] ? parts[0] / parts[1] : Number(parts[0]);
  return Number.isFinite(fps) && fps > 0 && fps <= 120 ? fps : 24;
}

function referenceDanceDurationDiagnostics(probe) {
  const safe = value => {
    if (value === undefined || value === null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 86400 ? number : null;
  };
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const audio = streams.filter(stream => stream?.codec_type === 'audio').map(stream => safe(stream.duration)).filter(value => value !== null);
  return Object.freeze({
    containerSeconds: safe(probe?.format?.duration),
    videoSeconds: safe(streams.find(stream => stream?.codec_type === 'video')?.duration),
    audioSeconds: audio.length ? Math.max(...audio) : null
  });
}

function validateReferenceDanceProbe(probe, { requireNoAudio = false, allowHevcInput = false, allowBoundaryTrim = false, motion = false } = {}) {
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

  const containerDuration = Number(probe?.format?.duration || video.duration || 0);
  const videoDuration = video.duration === undefined || video.duration === null || video.duration === 'N/A'
    ? containerDuration : Number(video.duration);
  // Neither a short container nor a short video stream may conceal the other
  // exceeding the input ceiling. An audio/container tail is not a free bypass.
  const durationSeconds = Math.max(containerDuration, videoDuration);
  // Motion never uses the 15 s boundary-trim mechanism: it plans its own exact cut.
  const requiresBoundaryTrim = !motion && durationSeconds > MAX_SECONDS;
  const inputLimit = motion ? MOTION_MAX_SOURCE_SECONDS
    : (allowBoundaryTrim === true && !requireNoAudio ? MAX_TRIMMABLE_INPUT_SECONDS : MAX_SECONDS);
  // Never round a fractional millisecond down across a billable-second
  // boundary: provider pricing rounds the exact source duration upward.
  // Motion output durations are exact multiples of 1/30 s printed with 6 decimals; the epsilon only
  // removes binary-float noise (16.1 * 1000 = 16100.000000000002) and never rounds a real overshoot down.
  const durationMs = motion ? Math.ceil(durationSeconds * 1000 - 1e-6) : Math.ceil(durationSeconds * 1000);
  if (!Number.isSafeInteger(durationMs) || durationSeconds < MIN_SECONDS || durationSeconds > inputLimit) {
    throw Object.assign(inspectionError('VIDEO_DURATION_INVALID'), { durationDiagnostics: referenceDanceDurationDiagnostics(probe) });
  }
  const width = Number(video.width || 0);
  const height = Number(video.height || 0);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw inspectionError('VIDEO_DIMENSIONS_INVALID');
  }
  let fps = parseFps(video.r_frame_rate || video.avg_frame_rate);
  if (codec === 'hevc' || requiresBoundaryTrim || motion) {
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
    if (motion && !requireNoAudio) {
      // r_frame_rate is FFprobe's nominal/guessed base rate, not the decoded
      // average of a VFR screen recording. Its value can exceed 60 even when
      // the actual average is 59.94. Never use that value to size the output.
      const average = String(video.avg_frame_rate || '').match(/^(\d+)(?:\/(\d+))?$/);
      const averageFps = average ? Number(average[1]) / (average[2] === undefined ? 1 : Number(average[2])) : NaN;
      if (!Number.isFinite(averageFps) || averageFps < 1 || averageFps > 120
        || codedWidth * codedHeight * averageFps > 3840 * 2160 * 60) {
        throw inspectionError('VIDEO_FRAMERATE_INVALID');
      }
      // Check a declared sample count too, when present. Keep the original
      // 4K60 decoded-pixel budget, 60 s/50 MiB input and 90 s job deadline.
      if (video.nb_frames !== undefined && video.nb_frames !== 'N/A') {
        const count = Number(video.nb_frames);
        if (!Number.isSafeInteger(count) || count < 1 || count > 7200
          || count > videoDuration * 120 + 1) throw inspectionError('VIDEO_FRAMERATE_INVALID');
      }
      fps = averageFps;
    } else {
      if (parsedRates.some(rate => !Number.isFinite(rate) || rate < 1 || rate > 60)
        || (motion && parsedRates.some(rate => rate !== MOTION_FPS))) {
        throw inspectionError('VIDEO_FRAMERATE_INVALID');
      }
      fps = parsedRates[0];
    }
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
    // Motion inputs may have bounded anamorphic SAR, normalized using display
    // aspect by motionOutputOptions. Legacy and sealed outputs stay square.
    // Missing/N/A/0:1 denote unspecified SAR; FFmpeg treats those as square.
    const sar = video.sample_aspect_ratio;
    if (sar !== undefined && sar !== null && sar !== 'N/A' && sar !== '0:1') {
      const match = /^(\d+):(\d+)$/.exec(String(sar));
      if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) < 1
        || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1
        || (motion && !requireNoAudio
          ? Number(match[1]) / Number(match[2]) < 0.25 || Number(match[1]) / Number(match[2]) > 4
          : Number(match[1]) !== Number(match[2]))) throw inspectionError('VIDEO_PROFILE_UNSUPPORTED');
    }
    const supportedProfile = codec === 'hevc' ? video.profile === 'Main'
      : ['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(video.profile);
    const convertibleInput = motion && !requireNoAudio;
    if (!(convertibleInput ? ['yuv420p', 'yuvj420p'].includes(video.pix_fmt) : video.pix_fmt === 'yuv420p') || !supportedProfile
      || (Number(video.bits_per_raw_sample || 8) !== 8)) throw inspectionError('VIDEO_PROFILE_UNSUPPORTED');
  }
  if (motion && requireNoAudio && video.color_range !== 'tv') throw inspectionError('VIDEO_PROFILE_UNSUPPORTED');
  return Object.freeze({
    durationSeconds,
    durationMs,
    width,
    height,
    fps,
    videoCodec: codec,
    ...(motion && !requireNoAudio ? { inputRange: video.pix_fmt === 'yuvj420p' || video.color_range === 'pc' ? 'full' : video.color_range === 'tv' ? 'limited' : 'auto' } : {}),
    ...(requiresBoundaryTrim ? { requiresBoundaryTrim: true } : {})
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

// The video stream's own length: a muted output cannot be longer than its video, so the motion plan uses this
// (never the container/audio tail, which would ask for frames that do not exist).
function videoStreamSeconds(probe, fallbackSeconds) {
  const video = (Array.isArray(probe?.streams) ? probe.streams : []).find((stream) => stream?.codec_type === 'video');
  const n = Number(video?.duration);
  return Number.isFinite(n) && n > 0 ? Math.min(n, fallbackSeconds) : fallbackSeconds;
}

// Plans the exact frame count of the motion output. Frames are counted at a constant
// 30 fps so the sealed file's duration is frames / 30 and never exceeds the plan:
//  - useSeconds (integer 4..30, at most the measured source): exactly useSeconds * 30 frames;
//  - otherwise the whole source, floored to a whole frame, capped at the first 30 s.
// Nothing is extended, looped or padded.
function planMotionOutput({ sourceDurationSeconds, useSeconds = null } = {}) {
  const source = Number(sourceDurationSeconds);
  if (!Number.isFinite(source) || source < MOTION_MIN_USE_SECONDS) throw inspectionError('VIDEO_DURATION_INVALID');
  if (useSeconds !== null && useSeconds !== undefined) {
    if (!Number.isInteger(useSeconds) || useSeconds < MOTION_MIN_USE_SECONDS || useSeconds > MOTION_MAX_USE_SECONDS) {
      throw inspectionError('MOTION_USE_SECONDS_INVALID');
    }
    // A tiny tolerance absorbs container rounding (e.g. 15.999 s for a "16 s" clip is not >= 16).
    if (useSeconds > source + 0.0005) throw inspectionError('MOTION_USE_EXCEEDS_SOURCE');
    return Object.freeze({ mode: 'cut', frames: useSeconds * MOTION_FPS, useSeconds, capped: false });
  }
  const capped = source > MOTION_MAX_USE_SECONDS;
  const frames = capped ? MOTION_MAX_USE_SECONDS * MOTION_FPS : Math.floor((source + 1e-6) * MOTION_FPS);
  if (frames < MOTION_MIN_USE_SECONDS * MOTION_FPS) throw inspectionError('VIDEO_DURATION_INVALID');
  return Object.freeze({ mode: 'whole', frames, useSeconds: null, capped });
}

// The sealed file must be exactly what was planned: never longer than the plan, and at
// most one second shorter, so that ceil(duration) is the billed second count the plan implies.
function validateMotionOutput(plan, approvedMetadata) {
  const planMs = Math.ceil(plan.frames / MOTION_FPS * 1000 - 1e-6);
  const ms = Number(approvedMetadata?.durationMs);
  if (!Number.isSafeInteger(ms) || ms > planMs || ms <= planMs - 1000 || ms > MOTION_MAX_USE_SECONDS * 1000) {
    throw inspectionError('VIDEO_DURATION_MISMATCH');
  }
  return true;
}

// The exact FFmpeg output options of the motion transcode (also used by the real-FFmpeg tests).
function motionOutputOptions(plan, maxBytes, inputMetadata = {}) {
  const range = ['full', 'limited'].includes(inputMetadata.inputRange) ? inputMetadata.inputRange : 'auto';
  // Respect display aspect (including SAR after FFmpeg's automatic rotation),
  // then emit square pixels. Convert sample values, not just range tags.
  const factor = 'min(1,min(1280/max(iw*sar,ih),720/min(iw*sar,ih)))';
  return [
    '-map', '0:v:0', '-c:v', 'libx264', '-threads', '2', '-filter_threads', '1',
    '-preset', 'veryfast', '-crf', '23', '-maxrate', '6M', '-bufsize', '12M',
    '-vf', `fps=30,scale=w='max(2,trunc(iw*sar*${factor}/2)*2)':h='max(2,trunc(ih*${factor}/2)*2)':in_range=${range}:out_range=limited,setsar=1`,
    '-frames:v', String(plan.frames),
    '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-bsf:v', 'h264_metadata=video_full_range_flag=0', '-metadata:s:v:0', 'rotate=0',
    '-fs', String(maxBytes),
    '-an', '-movflags', '+faststart'
  ];
}

module.exports = {
  validateReferenceDanceProbe, validateReferenceDanceDurationMatch, referenceDanceDurationDiagnostics,
  planMotionOutput, validateMotionOutput, motionOutputOptions, videoStreamSeconds, motionMediaDiagnostics,
  MOTION_MIN_USE_SECONDS, MOTION_MAX_USE_SECONDS, MOTION_MAX_SOURCE_SECONDS, MOTION_FPS
};
