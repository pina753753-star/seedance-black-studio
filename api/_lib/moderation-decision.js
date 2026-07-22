'use strict';

const {
  classifyFictionalAction,
  shouldRunFictionalActionClassifier
} = require('./fictional-action-classifier.js');

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
