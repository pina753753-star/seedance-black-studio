'use strict';

// Storage + registry helpers for H3 Live image-mode input frames.
//
// All access is through the service-role Supabase client. Nothing here is
// shared with Seedance's api/reference-image-*.js or the
// 'reference-image-quarantine' bucket. Uploaded frames live only in the private
// 'h3-live-image-quarantine' bucket and are NEVER promoted to a public bucket —
// api/h3-live/start.js hands fal.ai a short-lived signed URL and the object is
// swept afterwards.

const { randomUUID } = require('node:crypto');
const {
  IMAGE_QUARANTINE_BUCKET,
  IMAGE_ALLOWED_MIME,
  IMAGE_MAX_BYTES,
  IMAGE_MODERATION_SIGNED_URL_TTL_SECONDS,
  IMAGE_FAL_SIGNED_URL_TTL_SECONDS,
  IMAGE_UPLOAD_RETENTION_MS,
  IMAGE_CLEANUP_MAX_PER_RUN
} = require('./h3-live-config.js');

const UPLOADS_TABLE = 'h3_live_image_uploads';

function sanitizeFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
  return cleaned || 'frame';
}

function extensionForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

// Confirms the raw bytes really are one of the allowed image types. The client
// declares a MIME at upload-URL time and again on the PUT, but the bytes that
// actually land are re-checked here.
function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png';
  // WebP: "RIFF" .... "WEBP"
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp';
  return null;
}

function isAllowedMime(mime) {
  return IMAGE_ALLOWED_MIME.includes(String(mime || '').toLowerCase());
}

// Reserve one upload slot: issue a signed upload URL into the quarantine bucket
// and record the object path so an abandoned upload can still be swept.
//   -> { ok:true, uploadId, path, token, signedUrl }
//   -> { ok:false, error }
async function createImageUploadSlot(db, userId, { contentType, filename } = {}) {
  const mime = String(contentType || '').toLowerCase();
  if (!isAllowedMime(mime)) return { ok: false, error: 'unsupported_image_type' };

  const uploadId = randomUUID();
  const safeName = `${Date.now()}-${sanitizeFilename(filename)}`;
  const ext = extensionForMime(mime);
  const withExt = /\.(jpe?g|png|webp)$/i.test(safeName) ? safeName : `${safeName}.${ext}`;
  const path = `uploads/${userId}/${uploadId}/${withExt}`;

  const { data, error } = await db.storage
    .from(IMAGE_QUARANTINE_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data?.token) {
    return { ok: false, error: 'signed_upload_url_failed' };
  }

  const storedPath = data.path || path;
  const deleteAfter = new Date(Date.now() + IMAGE_UPLOAD_RETENTION_MS).toISOString();

  const { error: insertError } = await db
    .from(UPLOADS_TABLE)
    .insert({
      id: uploadId,
      user_id: userId,
      object_path: storedPath,
      content_type: mime,
      byte_size: 0,
      moderation_status: 'pending',
      delete_after: deleteAfter
    });

  if (insertError) {
    // Best-effort: drop the object we just allowed so it does not linger
    // untracked (there is no registry row to sweep it later).
    await db.storage.from(IMAGE_QUARANTINE_BUCKET).remove([storedPath]).catch(() => {});
    return { ok: false, error: 'upload_registry_insert_failed' };
  }

  return {
    ok: true,
    uploadId,
    bucket: IMAGE_QUARANTINE_BUCKET,
    path: storedPath,
    token: data.token,
    signedUrl: data.signedUrl
  };
}

// Load a registry row by id, scoped to its owner.
async function getUploadRow(db, uploadId, userId) {
  const { data, error } = await db
    .from(UPLOADS_TABLE)
    .select('*')
    .eq('id', uploadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { ok: false, error: 'upload_lookup_failed' };
  if (!data) return { ok: false, error: 'upload_not_found' };
  return { ok: true, row: data };
}

// Download the quarantined object and re-validate format + size against the
// bytes that actually landed.
//   -> { ok:true, buffer, contentType }
//   -> { ok:false, error }
async function downloadAndValidate(db, objectPath) {
  const { data: blob, error } = await db.storage
    .from(IMAGE_QUARANTINE_BUCKET)
    .download(objectPath);
  if (error || !blob) return { ok: false, error: 'quarantine_object_not_found' };

  const buffer = Buffer.from(await blob.arrayBuffer());
  if (buffer.length === 0) return { ok: false, error: 'empty_object' };
  if (buffer.length > IMAGE_MAX_BYTES) return { ok: false, error: 'image_too_large' };

  const detected = detectImageMime(buffer);
  if (!detected || !isAllowedMime(detected)) {
    return { ok: false, error: 'unsupported_image_type' };
  }
  return { ok: true, buffer, contentType: detected };
}

async function createModerationSignedUrl(db, objectPath) {
  const { data, error } = await db.storage
    .from(IMAGE_QUARANTINE_BUCKET)
    .createSignedUrl(objectPath, IMAGE_MODERATION_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return { ok: false, error: 'moderation_signed_url_failed' };
  return { ok: true, signedUrl: data.signedUrl };
}

async function createFalSignedUrl(db, objectPath) {
  const { data, error } = await db.storage
    .from(IMAGE_QUARANTINE_BUCKET)
    .createSignedUrl(objectPath, IMAGE_FAL_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return { ok: false, error: 'fal_signed_url_failed' };
  return { ok: true, signedUrl: data.signedUrl };
}

async function markModeration(db, uploadId, status, { categories, byteSize, contentType } = {}) {
  const patch = {
    moderation_status: status,
    moderated_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (Array.isArray(categories)) patch.moderation_categories = categories;
  if (Number.isFinite(byteSize)) patch.byte_size = byteSize;
  if (contentType) patch.content_type = contentType;
  const { error } = await db.from(UPLOADS_TABLE).update(patch).eq('id', uploadId);
  return !error;
}

// Best-effort: remove the object from storage and stamp deleted_at. Never
// throws; returns whether the storage delete reported success.
//
// deleted_at is stamped ONLY when the storage removal actually succeeded. On a
// transient storage error the registry row is left with deleted_at IS NULL so
// sweepStaleUploads (which filters deleted_at IS NULL) picks it up again on a
// later run, rather than the object lingering in quarantine forever.
async function deleteUploadObject(db, row) {
  if (!row || !row.object_path) return false;
  let removed = false;
  try {
    const { error } = await db.storage
      .from(IMAGE_QUARANTINE_BUCKET)
      .remove([row.object_path]);
    removed = !error;
  } catch (_) {
    removed = false;
  }
  if (removed) {
    try {
      await db.from(UPLOADS_TABLE)
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .is('deleted_at', null);
    } catch (_) { /* best effort */ }
  }
  return removed;
}

async function deleteUploadById(db, uploadId, userId) {
  const found = await getUploadRow(db, uploadId, userId);
  if (!found.ok) return false;
  return deleteUploadObject(db, found.row);
}

// Opportunistic cleanup: every H3 Live endpoint calls this so abandoned uploads
// are removed without a dedicated cron. Bounded to IMAGE_CLEANUP_MAX_PER_RUN and
// never throws — a cleanup failure must not affect the caller's main flow.
async function sweepStaleUploads(db) {
  try {
    const { data: rows, error } = await db
      .from(UPLOADS_TABLE)
      .select('id, object_path')
      .lte('delete_after', new Date().toISOString())
      .is('deleted_at', null)
      .order('delete_after', { ascending: true })
      .limit(IMAGE_CLEANUP_MAX_PER_RUN);
    if (error || !Array.isArray(rows) || rows.length === 0) {
      return { ok: !error, deleted: 0 };
    }

    const paths = rows.map((r) => String(r.object_path || '')).filter(Boolean);
    if (paths.length) {
      const { error: removeError } = await db.storage
        .from(IMAGE_QUARANTINE_BUCKET)
        .remove(paths);
      if (removeError) {
        console.error('[h3-live-image-store] sweep storage remove failed:', removeError.message);
        return { ok: false, deleted: 0 };
      }
    }

    const nowIso = new Date().toISOString();
    await db.from(UPLOADS_TABLE)
      .update({ deleted_at: nowIso, updated_at: nowIso })
      .in('id', rows.map((r) => r.id));

    return { ok: true, deleted: rows.length };
  } catch (error) {
    console.error('[h3-live-image-store] sweep exception:', error?.message || String(error));
    return { ok: false, deleted: 0 };
  }
}

module.exports = {
  IMAGE_QUARANTINE_BUCKET,
  UPLOADS_TABLE,
  isAllowedMime,
  detectImageMime,
  createImageUploadSlot,
  getUploadRow,
  downloadAndValidate,
  createModerationSignedUrl,
  createFalSignedUrl,
  markModeration,
  deleteUploadObject,
  deleteUploadById,
  sweepStaleUploads
};
