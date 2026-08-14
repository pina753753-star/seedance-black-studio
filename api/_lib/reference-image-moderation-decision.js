'use strict';

// Child-protection-focused moderation decision for reference image uploads
// (api/reference-image-confirm-upload.js).
//
// Deliberately independent from api/_lib/moderation-decision.js (used by
// api/_lib/seedance-start.js at generation time): that decision path runs a
// secondary "fictional action" classifier (api/_lib/fictional-action-classifier.js)
// when the only flagged category is `violence`. That classifier has been
// observed to over-block ordinary anime action prompts. This endpoint
// intentionally does NOT run that secondary classifier at all — decided
// 2026-08-14 to avoid the same over-blocking risk for reference image
// uploads, and because reference images are moderated again anyway at
// generation time via seedance-start.js.
//
// Policy (decided 2026-08-14): only the `sexual/minors` category blocks a
// reference image upload. This is the OpenAI omni-moderation category most
// directly tied to CSAM/child-protection risk. General `sexual` and all
// other categories (violence, hate, harassment, self-harm, etc.) are
// intentionally NOT blocked here — ordinary character/swimsuit/action
// reference images should not be rejected at upload time. Those categories
// remain covered by the existing generation-time check in
// api/_lib/seedance-start.js.
const CHILD_PROTECTION_CATEGORIES = new Set(['sexual/minors']);

// moderation is the return value of api/_lib/openai-moderation.js's
// moderateContent(). Returns:
//   { ok:false, allow:false, status:503, reason:'moderation_unavailable' }
//     — the moderation call itself failed (network/API error/etc.); the
//       caller must fail closed and must not promote the image.
//   { ok:true,  allow:true,  status:200, reason:'moderation_clear' }
//     — not flagged at all.
//   { ok:true,  allow:true,  status:200, reason:'moderation_flagged_outside_scope' }
//     — flagged, but only for categories outside this endpoint's scope
//       (e.g. violence, general sexual content). Allowed by design — see
//       the policy note above.
//   { ok:true,  allow:false, status:422, reason:'child_protection_category_flagged', matchedCategories }
//     — flagged for at least one category in CHILD_PROTECTION_CATEGORIES.
function resolveReferenceImageModerationDecision(moderation) {
  if (!moderation || moderation.ok !== true) {
    return { ok: false, allow: false, status: 503, reason: 'moderation_unavailable' };
  }

  if (moderation.flagged !== true) {
    return { ok: true, allow: true, status: 200, reason: 'moderation_clear' };
  }

  const categories = Array.isArray(moderation.categories) ? moderation.categories : [];
  const matchedCategories = categories.filter((category) => CHILD_PROTECTION_CATEGORIES.has(category));

  if (matchedCategories.length === 0) {
    return { ok: true, allow: true, status: 200, reason: 'moderation_flagged_outside_scope' };
  }

  return {
    ok: true,
    allow: false,
    status: 422,
    reason: 'child_protection_category_flagged',
    matchedCategories
  };
}

module.exports = {
  resolveReferenceImageModerationDecision,
  CHILD_PROTECTION_CATEGORIES
};
