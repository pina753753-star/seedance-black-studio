'use strict';

const SEEDANCE_25_MODEL = 'bytedance/seedance-2.5';
const SEEDANCE_25_AUDIO_GUARD_MARKER = '[Pina Studio audio requirements]';
const SEEDANCE_25_AUDIO_GUARD = `${SEEDANCE_25_AUDIO_GUARD_MARKER}
Audio must contain only the user's requested original spoken dialogue, natural ambience, and non-musical foley or sound effects. Do not add background music, songs, melodies, humming, or audio resembling any existing work. Preserve the user's exact dialogue text, speaker assignment, language, timing, and emotion.`;

function buildProviderPrompt({ model, prompt, generateAudio = true }) {
  const originalPrompt = String(prompt || '').trim();
  if (model !== SEEDANCE_25_MODEL || !generateAudio || originalPrompt.includes(SEEDANCE_25_AUDIO_GUARD_MARKER)) {
    return originalPrompt;
  }
  return `${originalPrompt}\n\n${SEEDANCE_25_AUDIO_GUARD}`;
}

module.exports = {
  buildProviderPrompt,
  SEEDANCE_25_AUDIO_GUARD_MARKER
};
