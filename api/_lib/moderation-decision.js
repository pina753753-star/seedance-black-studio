'use strict';

const {
  classifyFictionalAction,
  shouldRunFictionalActionClassifier
} = require('./fictional-action-classifier.js');

function buildSecondaryClassifierDiagnostic(classification) {
  const value = classification && typeof classification === 'object'
    ? classification
    : {};

  return {
    fictional_setting: value.fictional_setting === true,
    adult_or_nonhuman_only: value.adult_or_nonhuman_only === true,
    real_person_target: value.real_person_target === true,
    minor_harm: value.minor_harm === true,
    graphic_injury: value.graphic_injury === true,
    lethal_or_maiming_action: value.lethal_or_maiming_action === true,
    torture_or_execution: value.torture_or_execution === true,
    sexual_violence: value.sexual_violence === true,
    weapon_instruction: value.weapon_instruction === true,
    effects_hide_serious_harm: value.effects_hide_serious_harm === true,
    non_graphic_action: value.non_graphic_action === true,
    decision: ['allow', 'block', 'uncertain'].includes(value.decision)
      ? value.decision
      : 'unknown'
  };
}

async function resolveModerationDecision(prompt, moderation, options = {}) {
  if (!moderation || moderation.ok !== true) {
    return {
      ok: false,
      allow: false,
      status: 503,
      reason: 'moderation_unavailable'
    };
  }

  if (moderation.flagged !== true) {
    return {
      ok: true,
      allow: true,
      status: 200,
      reason: 'moderation_clear'
    };
  }

  const eligibility = shouldRunFictionalActionClassifier(moderation);
  if (!eligibility.run) {
    return {
      ok: true,
      allow: false,
      status: 422,
      reason: eligibility.reason
    };
  }

  const classification = await classifyFictionalAction(prompt, options);

  if (!classification.ok) {
    return {
      ok: false,
      allow: false,
      status: 503,
      reason: 'secondary_classifier_unavailable',
      errorCode: classification.errorCode || 'unknown'
    };
  }

  if (classification.allow !== true) {
    try {
      const logger = options.logger || console;

      logger.warn?.(
        '[moderation-decision] secondary classifier blocked request',
        buildSecondaryClassifierDiagnostic(classification.classification)
      );
    } catch (_) {
      // Diagnostic logging must never change the moderation decision.
    }
  }

  return {
    ok: true,
    allow: classification.allow === true,
    status: classification.allow === true ? 200 : 422,
    reason: classification.reason,
    classification: classification.classification
  };
}

module.exports = {
  resolveModerationDecision
};
