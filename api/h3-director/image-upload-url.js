'use strict';

// POST /api/h3-director/image-upload-url
//
// Issue a one-shot signed upload URL so the browser can PUT an H3 Max Live
// initial-frame image straight into the private 'h3-live-image-quarantine'
// bucket. Reuses H3 Max's existing image-isolation infrastructure
// (h3-live-image-store.js) so no new Storage bucket or table is introduced.
// Deliberately does NOT call /api/h3-live/image-upload-url or its kill
// switch/entitlement checks — this endpoint uses H3 Max Live's own
// (h3_director) kill switch and plan entitlement instead.
//
// Moderation of the image (together with the initial prompt) happens later,
// in /api/h3-director/start-session, before any credit charge.
//
// Headers:  Authorization: Bearer <Supabase JWT>   (required)
// Body:     { "contentType": "image/jpeg|image/png|image/webp", "byteSize": <int>, "filename": "<optional>" }

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const {
  jsonBody, serviceClient, isUuid, checkDirectorEnabled, getDirectorEntitlement
} = require('../_lib/h3-director-store.js');
const { ALLOWED_PLANS } = require('../_lib/h3-director-config.js');
const { createImageUploadSlot, sweepStaleUploads, isAllowedMime } = require('../_lib/h3-live-image-store.js');
const { IMAGE_MAX_BYTES } = require('../_lib/h3-live-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'POST only.' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  // Opportunistic cleanup of abandoned uploads (bounded, never throws). Safe
  // to share with H3 Live: it sweeps by delete_after/deleted_at only, with no
  // product-specific logic.
  sweepStaleUploads(db).catch(() => {});

  // Director's own kill switch — never hand out an upload URL while H3 Max
  // Live is disabled, independent of H3 Live's (h3_live) switch.
  const control = await checkDirectorEnabled(db);
  if (!control.ok) {
    return res.status(503).json({
      ok: false,
      error: 'h3_director_disabled',
      message: 'H3 Max Live は現在利用できません。しばらくしてからお試しください。'
    });
  }

  const entitlement = await getDirectorEntitlement(db, auth.user.id, ALLOWED_PLANS);
  if (!entitlement.ok) {
    return res.status(503).json({
      ok: false,
      error: 'entitlement_unavailable',
      message: '現在プランを確認できないため、画像を添付できません。しばらくしてからお試しください。'
    });
  }
  if (!entitlement.allowed) {
    return res.status(403).json({
      ok: false,
      error: 'eligible_plan_required',
      message: 'H3 Max Live は Premium 以上の有効なプランで利用できます。',
      redirect: '/pricing.html#monthly'
    });
  }
  if (entitlement.accountStatus !== 'active') {
    return res.status(403).json({ ok: false, error: 'account_restricted' });
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
    console.error('[h3-director/image-upload-url] slot failed:', slot.error);
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

module.exports._test = { isUuid };
