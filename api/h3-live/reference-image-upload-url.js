'use strict';

// POST /api/h3-live/reference-image-upload-url
//
// Issue a one-shot signed upload URL for ONE slot (1-9) of an H3 Max
// "reference" or "storyboard" job's multi-image input. Independent of
// /api/h3-live/image-upload-url (the existing single-image endpoint) — this
// writes to public.h3_max_reference_uploads / the
// 'h3-max-reference-image-quarantine' bucket only. Moderation happens later,
// in /api/h3-live/start, before any charge.
//
// Headers:  Authorization: Bearer <Supabase JWT>   (required)
// Body:     { "contentType": "image/jpeg|image/png|image/webp",
//             "byteSize": <int>, "slot": <1..9>, "filename": "<optional>" }
//
// The browser is expected to have already resized the image to a max long
// edge of 1024px BEFORE calling this endpoint (see h3-max-beta.html) — the
// bytes uploaded here are exactly what gets moderated and sent to fal.ai.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, serviceClient, checkH3LiveEnabled } = require('../_lib/h3-live-store.js');
const { getH3LiveEntitlement } = require('../_lib/h3-live-entitlement.js');
const {
  createReferenceUploadSlot,
  sweepStaleUploads,
  isAllowedMime,
  isValidSlot,
  REFERENCE_MAX_BYTES
} = require('../_lib/h3-max-reference-image-store.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'POST only.' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  // Opportunistic cleanup of abandoned uploads (bounded, never throws).
  sweepStaleUploads(db).catch(() => {});

  // Kill switch — shared with text/image/H3 Max as a whole.
  const control = await checkH3LiveEnabled(db);
  if (!control.ok) {
    return res.status(503).json({
      ok: false,
      error: 'h3_live_disabled',
      message: 'H3 Max は現在利用できません。しばらくしてからお試しください。'
    });
  }

  // Plan eligibility (Premium / Scale / Team / Ultimate, unexpired).
  const entitlement = await getH3LiveEntitlement(db, auth.user.id);
  if (!entitlement.ok) {
    return res.status(503).json({
      ok: false,
      error: 'plan_check_unavailable',
      message: '現在プランを確認できないため、画像を添付できません。しばらくしてからお試しください。'
    });
  }
  if (!entitlement.allowed) {
    return res.status(403).json({
      ok: false,
      error: 'h3_live_plan_required',
      message: 'H3 Max は Premium 以上のプラン（有効期間内）でご利用いただけます。',
      redirect: '/pricing.html#monthly'
    });
  }

  const body = jsonBody(req);
  const contentType = String(body.contentType || '').toLowerCase();
  const byteSize = Number(body.byteSize || 0);
  const slot = body.slot;

  if (!isAllowedMime(contentType)) {
    return res.status(415).json({
      ok: false,
      error: 'unsupported_image_type',
      message: 'JPEG / PNG / WebP の画像を選択してください。'
    });
  }
  if (!isValidSlot(slot)) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_slot',
      message: '画像の枚数上限（1〜9枚）を確認してください。'
    });
  }
  if (Number.isFinite(byteSize) && byteSize > REFERENCE_MAX_BYTES) {
    return res.status(413).json({
      ok: false,
      error: 'image_too_large',
      message: '画像は20MB以下にしてください。'
    });
  }

  const result = await createReferenceUploadSlot(db, auth.user.id, {
    contentType,
    filename: body.filename,
    slot
  });
  if (!result.ok) {
    console.error('[h3-live/reference-image-upload-url] slot failed:', result.error);
    const status = result.error === 'unsupported_image_type' || result.error === 'invalid_slot' ? 415 : 500;
    return res.status(status).json({
      ok: false,
      error: result.error,
      message: '画像アップロードを開始できませんでした。もう一度お試しください。'
    });
  }

  return res.status(200).json({
    ok: true,
    uploadId: result.uploadId,
    bucket: result.bucket,
    path: result.path,
    token: result.token,
    signedUrl: result.signedUrl,
    slot: result.slot,
    maxBytes: REFERENCE_MAX_BYTES
  });
};
