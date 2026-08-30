'use strict';

const SEEDANCE_25_MODELS = new Set([
  'bytedance/seedance-2.5',
  'bytedance/seedance-2.5-standard'
]);
const SEEDANCE_25_AUDIO_GUARD_MARKER = '[Pina Studio audio requirements]';
const SEEDANCE_25_AUDIO_GUARD = `${SEEDANCE_25_AUDIO_GUARD_MARKER}
Audio must contain only the user's requested original spoken dialogue, natural ambience, and non-musical foley or sound effects. Do not add background music, songs, melodies, humming, or audio resembling any existing work. Preserve the user's exact dialogue text, speaker assignment, language, timing, and emotion.`;
const SEEDANCE_25_SINGING_AUDIO_GUIDANCE = `${SEEDANCE_25_AUDIO_GUARD_MARKER}
Use @audio1 as the supplied soundtrack and vocal performance. Preserve its lyrics, melody, vocals, language, timing, and arrangement. Synchronize the performer's lip movements, expressions, and stage actions to @audio1. Do not compose, replace, or add another song.`;
const SEEDANCE_25_RHYTHM_AUDIO_GUIDANCE = `${SEEDANCE_25_AUDIO_GUARD_MARKER}
Use @audio1 as the master timing, rhythm, and mood reference for the entire video.
Synchronize the subject's major body movements, gestures, performance accents,
lighting changes, camera movements, and scene transitions to the clearly audible
beats, strong downbeats, musical accents, and section changes in @audio1.
The visual pacing must follow @audio1 continuously.
Do not create movements, cuts, or camera timing that follow an unrelated rhythm.
Keep motion natural and continuous between musical accents.
If a singer is visible, synchronize lip movements, breathing, expressions,
and performance intensity to the vocal phrases in @audio1.
Do not compose or add a different song.`;

function buildProviderPrompt({ model, prompt, generateAudio = true, hasReferenceAudio = false, referenceAudioSyncMode = 'singing' }) {
  const originalPrompt = String(prompt || '').trim();
  if (!SEEDANCE_25_MODELS.has(model) || !generateAudio || originalPrompt.includes(SEEDANCE_25_AUDIO_GUARD_MARKER)) {
    return originalPrompt;
  }
  const referenceAudioGuidance = referenceAudioSyncMode === 'rhythm'
    ? SEEDANCE_25_RHYTHM_AUDIO_GUIDANCE
    : SEEDANCE_25_SINGING_AUDIO_GUIDANCE;
  return `${originalPrompt}\n\n${hasReferenceAudio ? referenceAudioGuidance : SEEDANCE_25_AUDIO_GUARD}`;
}

module.exports = {
  buildProviderPrompt,
  SEEDANCE_25_AUDIO_GUARD_MARKER
};
