'use strict';

const SEEDANCE_25_MODEL = 'bytedance/seedance-2.5';
const SEEDANCE_25_AUDIO_GUARD_MARKER = '[Pina Studio audio requirements]';
const SEEDANCE_25_AUDIO_GUARD = `${SEEDANCE_25_AUDIO_GUARD_MARKER}
Audio must contain only the user's requested original spoken dialogue, natural ambience, and non-musical foley or sound effects. Do not add background music, songs, melodies, humming, or audio resembling any existing work. Preserve the user's exact dialogue text, speaker assignment, language, timing, and emotion.`;
const SEEDANCE_25_REFERENCE_AUDIO_GUIDANCE = `${SEEDANCE_25_AUDIO_GUARD_MARKER}
Use @audio1 as the supplied soundtrack and vocal performance. Preserve its lyrics, melody, vocals, language, timing, and arrangement. Synchronize the performer's lip movements, expressions, and stage actions to @audio1. Do not compose, replace, or add another song.`;

function buildProviderPrompt({ model, prompt, generateAudio = true, hasReferenceAudio = false }) {
  const originalPrompt = String(prompt || '').trim();
  if (model !== SEEDANCE_25_MODEL || !generateAudio || originalPrompt.includes(SEEDANCE_25_AUDIO_GUARD_MARKER)) {
    return originalPrompt;
  }
  return `${originalPrompt}\n\n${hasReferenceAudio ? SEEDANCE_25_REFERENCE_AUDIO_GUIDANCE : SEEDANCE_25_AUDIO_GUARD}`;
}

module.exports = {
  buildProviderPrompt,
  SEEDANCE_25_AUDIO_GUARD_MARKER
};
