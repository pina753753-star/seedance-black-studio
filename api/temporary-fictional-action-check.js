'use strict';

const {
  classifyFictionalAction
} = require('./_lib/fictional-action-classifier');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (process.env.VERCEL_ENV !== 'preview') {
    return res.status(404).json({
      ok: false,
      error: 'not_available'
    });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      error: 'method_not_allowed'
    });
  }

  const prompt = [
    'A clearly fictional anime scene.',
    'Two adult armored knights practice sparring with wooden swords in a training arena.',
    'No blood, no injury, no death, no minors, no real people, and no weapon instructions.',
    'The scene is lighthearted and non-graphic.'
  ].join(' ');

  const result = await classifyFictionalAction(prompt, {
    timeoutMs: 30000
  });

  const classification = result.classification || null;

  const success =
    result.ok === true &&
    result.allow === true &&
    result.reason === 'safe_fictional_non_graphic_action' &&
    classification &&
    classification.decision === 'allow' &&
    classification.fictional_setting === true &&
    classification.adult_or_nonhuman_only === true &&
    classification.real_person_target === false &&
    classification.minor_harm === false &&
    classification.graphic_injury === false &&
    classification.lethal_or_maiming_action === false &&
    classification.torture_or_execution === false &&
    classification.sexual_violence === false &&
    classification.weapon_instruction === false &&
    classification.effects_hide_serious_harm === false &&
    classification.non_graphic_action === true;

  return res.status(success ? 200 : 500).json({
    success,
    ok: result.ok === true,
    allow: result.allow === true,
    reason: result.reason || null,
    errorCode: result.errorCode || null,
    httpStatus: result.httpStatus || null,
    validationReason: result.validationReason || null,
    classification
  });
};
