'use strict';

// POST /api/h3-live/image-upload-url
//
// Issue a one-shot signed upload URL so the browser can PUT an image-mode input
// frame straight into the private 'h3-live-image-quarantine' bucket (keeping the
// bytes out of the Vercel function body limit). Records a
// public.h3_live_image_uploads row so the object can be swept if the upload is
// abandoned. Moderation happens later, in /api/h3-live/start, before any charge.
//
// Headers:  Authorization: Bearer <Supabase JWT>   (required)
// Body:     { "contentType": "image/jpeg|image/png|image/webp", "byteSize": <int>, "filename": "<optional>" }
//
// Standalone: shares no code with Seedance's reference-image endpoints.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, serviceClient, checkH3LiveEnabled } = require('../_lib/h3-live-store.js');
const { getH3LiveEntitlement } = require('../_lib/h3-live-entitlement.js');
const { createImageUploadSlot, sweepStaleUploads, isAllowedMime } = require('../_lib/h3-live-image-store.js');
const { IMAGE_MAX_BYTES } = require('../_lib/h3-live-config.js');

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

  // Kill switch — do not hand out upload URLs while H3 Live is disabled.
  const control = await checkH3LiveEnabled(db);
  if (!control.ok) {
    return res.status(503).json({
      ok: false,
      error: 'h3_live_disabled',
      message: 'H3 Live は現在利用できません。しばらくしてからお試しください。'
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
      message: 'H3 Live は Premium 以上のプラン（有効期間内）でご利用いただけます。',
      redirect: '/pricing.html#monthly'
    });
  }

  const body = jsonBody(req);
  const contentType = String(body.contentType || '').toLowerCase();
  const byteSize = Number(body.byteSize || 0);

  if (!isAllowedMime(contentType)) {
    return res.status(415).json({
      ok: false,
      error: 'unsupported_image_type',
      message: 'JPEG / PNG / WebP の画像を選択してください。'
    });
  }
  if (Number.isFinite(byteSize) && byteSize > IMAGE_MAX_BYTES) {
    return res.status(413).json({
      ok: false,
      error: 'image_too_large',
      message: '画像は20MB以下にしてください。'
    });
  }

  const slot = await createImageUploadSlot(db, auth.user.id, {
    contentType,
    filename: body.filename
  });
  if (!slot.ok) {
    console.error('[h3-live/image-upload-url] slot failed:', slot.error);
    const status = slot.error === 'unsupported_image_type' ? 415 : 500;
    return res.status(status).json({
      ok: false,
      error: slot.error,
      message: '画像アップロードを開始できませんでした。もう一度お試しください。'
    });
  }

  return res.status(200).json({
    ok: true,
    uploadId: slot.uploadId,
    bucket: slot.bucket,
    path: slot.path,
    token: slot.token,
    signedUrl: slot.signedUrl,
    maxBytes: IMAGE_MAX_BYTES
  });
};
