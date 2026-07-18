'use strict';

// Fixed two-tier pricing for video editing stage 1 (trim + cut concatenation).
// Confirmed pricing (see task description, not derived/guessed):
//   - 1-3 clips AND total trimmed duration <= 30s: 10 credits
//   - 4-6 clips OR total trimmed duration > 30s:   15 credits
// Subtitles/BGM are out of scope for this stage (planned +5/+5 later, cap 25).

const BASE_CREDITS = 10;
const SURCHARGE_CREDITS = 15;
const CLIP_COUNT_THRESHOLD = 3; // >3 clips triggers the surcharge tier
const DURATION_THRESHOLD_SECONDS = 30; // >30s total triggers the surcharge tier

function calculateVideoEditCreditCost({ clipCount, totalDurationSeconds }) {
  const count = Number(clipCount);
  const duration = Number(totalDurationSeconds);

  if (!Number.isFinite(count) || count < 1) {
    const error = new Error('clipCount must be a positive integer.');
    error.code = 'invalid_clip_count';
    throw error;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    const error = new Error('totalDurationSeconds must be a positive number.');
    error.code = 'invalid_duration';
    throw error;
  }

  const surcharge = count > CLIP_COUNT_THRESHOLD || duration > DURATION_THRESHOLD_SECONDS;
  return surcharge ? SURCHARGE_CREDITS : BASE_CREDITS;
}

module.exports = {
  BASE_CREDITS,
  SURCHARGE_CREDITS,
  CLIP_COUNT_THRESHOLD,
  DURATION_THRESHOLD_SECONDS,
  calculateVideoEditCreditCost
};
