'use strict';

// Storage + registry helpers for H3 Max multi-image "reference" and
// "storyboard" modes (1-9 images per job).
//
// Completely independent of api/_lib/h3-live-image-store.js (the existing
// single-image mode's helper) — different bucket
// ('h3-max-reference-image-quarantine'), different table
// (public.h3_max_reference_uploads), different slot model (up to 9 concurrent
// slots per user instead of 1). h3-live-image-store.js is NOT imported or
// modified here.
//
// All access is through the service-role Supabase client. Uploaded images are
// NEVER promoted to a public bucket — api/h3-live/start.js hands fal.ai
// short-lived signed URLs and the objects are swept afterwards, exactly like
// the single-image mode.

const { randomUUID } = require('node:crypto');

const REFERENCE_QUARANTINE_BUCKET = 'h3-max-reference-image-quarantine';
const REFERENCE_UPLOADS_TABLE = 'h3_max_reference_uploads';
const REFERENCE_JOB_IMAGES_TABLE = 'h3_live_job_reference_images';

const REFERENCE_ALLOWED_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
const REFERENCE_MAX_IMAGES = 9;

const REFERENCE_MODERATION_SIGNED_URL_TTL_SECONDS = 300;
const REFERENCE_FAL_SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;
const REFERENCE_UPLOAD_RETENTION_MS = 48 * 60 * 60 * 1000;
const REFERENCE_CLEANUP_MAX_PER_RUN = 20;
// Same fixed ~2h token expiry as h3-live-image-store.js — Supabase Storage's
// createSignedUploadUrl has no configurable/revocable expiry.
const REFERENCE_SIGNED_UPLOAD_URL_TTL_MS = 2 * 60 * 60 * 1000;

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

function isAllowedMime(mime) {
  return REFERENCE_ALLOWED_MIME.includes(String(mime || '').toLowerCase());
}

function isValidSlot(slot) {
  const n = Number(slot);
  return Number.isInteger(n) && n >= 1 && n <= REFERENCE_MAX_IMAGES;
}

// Confirms the raw bytes really are one of the allowed image types (same
// signature-sniffing approach as h3-live-image-store.js's detectImageMime,
// duplicated rather than imported to keep this module fully independent).
function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'image/png';
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'image/webp';
  return null;
}

// Reserve one upload slot (1-9) for this user. If the caller already has a
// still-usable (unbound, not deleted, not superseded) upload in the SAME
// slot, that prior upload is superseded first — this is a slot REPLACE, not
// an accumulate. A different slot's upload is never touched (per the
// product spec: "同じslotを差し替える場合だけ、そのslotの旧画像をsupersede
// / 別slotの画像は消さない").
//   -> { ok:true, uploadId, bucket, path, token, signedUrl }
//   -> { ok:false, error }
async function createReferenceUploadSlot(db, userId, { contentType, filename, slot } = {}) {
  const mime = String(contentType || '').toLowerCase();
  if (!isAllowedMime(mime)) return { ok: false, error: 'unsupported_image_type' };
  if (!isValidSlot(slot)) return { ok: false, error: 'invalid_slot' };
  const slotNumber = Number(slot);

  const { data: priorPending, error: priorLookupError } = await db
    .from(REFERENCE_UPLOADS_TABLE)
    .select('id, storage_path')
    .eq('user_id', userId)
    .eq('slot', slotNumber)
    .is('job_id', null)
    .is('deleted_at', null)
    .is('superseded_at', null);
  if (priorLookupError) {
    return { ok: false, error: 'pending_upload_lookup_failed' };
  }
  for (const prior of priorPending || []) {
    const expired = await expirePendingUpload(db, prior).catch(() => false);
    if (!expired) {
      return { ok: false, error: 'pending_upload_supersede_failed' };
    }
  }

  const uploadId = randomUUID();
  const safeName = `${Date.now()}-${sanitizeFilename(filename)}`;
  const ext = extensionForMime(mime);
  const withExt = /\.(jpe?g|png|webp)$/i.test(safeName) ? safeName : `${safeName}.${ext}`;
  const path = `uploads/${userId}/${uploadId}/${withExt}`;

  // Mint the signed upload token BEFORE inserting the registry row — same
  // ordering invariant as h3-live-image-store.js's createImageUploadSlot (see
  // its extensive comment): guarantees any later supersede's delete_after
  // push-out always covers this token's own real expiry.
  const { data, error } = await db.storage
    .from(REFERENCE_QUARANTINE_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data?.token) {
    return { ok: false, error: 'signed_upload_url_failed' };
  }

  const storedPath = data.path || path;
  const deleteAfter = new Date(Date.now() + REFERENCE_UPLOAD_RETENTION_MS).toISOString();

  const { error: insertError } = await db
    .from(REFERENCE_UPLOADS_TABLE)
    .insert({
      id: uploadId,
      user_id: userId,
      storage_bucket: REFERENCE_QUARANTINE_BUCKET,
      storage_path: storedPath,
      mime_type: mime,
      byte_size: 0,
      slot: slotNumber,
      moderation_status: 'pending',
      delete_after: deleteAfter
    });

  if (insertError) {
    await db.storage.from(REFERENCE_QUARANTINE_BUCKET).remove([storedPath]).catch(() => {});
    if (insertError.code === '23505') {
      return { ok: false, error: 'pending_upload_conflict' };
    }
    return { ok: false, error: 'upload_registry_insert_failed' };
  }

  return {
    ok: true,
    uploadId,
    bucket: REFERENCE_QUARANTINE_BUCKET,
    path: storedPath,
    token: data.token,
    signedUrl: data.signedUrl,
    slot: slotNumber
  };
}

async function getUploadRow(db, uploadId, userId) {
  const { data, error } = await db
    .from(REFERENCE_UPLOADS_TABLE)
    .select('*')
    .eq('id', uploadId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { ok: false, error: 'upload_lookup_failed' };
  if (!data) return { ok: false, error: 'upload_not_found' };
  return { ok: true, row: data };
}

// Fetch multiple upload rows by id, scoped to their owner, in the SAME order
// as the ids array (order matters — reference/storyboard preserves image
// order). Any id not found (or not owned by userId) is reported by absence:
// callers must check rows.length === uploadIds.length.
async function getUploadRowsOrdered(db, uploadIds, userId) {
  const ids = Array.isArray(uploadIds) ? uploadIds : [];
  if (ids.length === 0) return { ok: true, rows: [] };
  const { data, error } = await db
    .from(REFERENCE_UPLOADS_TABLE)
    .select('*')
    .in('id', ids)
    .eq('user_id', userId);
  if (error) return { ok: false, error: 'upload_lookup_failed' };
  const byId = new Map((data || []).map((row) => [row.id, row]));
  const rows = ids.map((id) => byId.get(id) || null);
  return { ok: true, rows };
}

async function downloadAndValidate(db, row) {
  const bucket = row?.storage_bucket || REFERENCE_QUARANTINE_BUCKET;
  const { data: blob, error } = await db.storage.from(bucket).download(row.storage_path);
  if (error || !blob) return { ok: false, error: 'quarantine_object_not_found' };

  const buffer = Buffer.from(await blob.arrayBuffer());
  if (buffer.length === 0) return { ok: false, error: 'empty_object' };
  if (buffer.length > REFERENCE_MAX_BYTES) return { ok: false, error: 'image_too_large' };

  const detected = detectImageMime(buffer);
  if (!detected || !isAllowedMime(detected)) {
    return { ok: false, error: 'unsupported_image_type' };
  }
  return { ok: true, buffer, contentType: detected };
}

async function createModerationSignedUrl(db, row) {
  const bucket = row?.storage_bucket || REFERENCE_QUARANTINE_BUCKET;
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(row.storage_path, REFERENCE_MODERATION_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return { ok: false, error: 'moderation_signed_url_failed' };
  return { ok: true, signedUrl: data.signedUrl };
}

async function createFalSignedUrl(db, row) {
  const bucket = row?.storage_bucket || REFERENCE_QUARANTINE_BUCKET;
  const { data, error } = await db.storage
    .from(bucket)
    .createSignedUrl(row.storage_path, REFERENCE_FAL_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return { ok: false, error: 'fal_signed_url_failed' };
  return { ok: true, signedUrl: data.signedUrl };
}

async function markModeration(db, uploadId, status, { detail, byteSize, contentType } = {}) {
  const patch = {
    moderation_status: status,
    moderation_checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  if (detail !== undefined) patch.moderation_detail = detail;
  if (Number.isFinite(byteSize)) patch.byte_size = byteSize;
  if (contentType) patch.mime_type = contentType;
  const { error } = await db.from(REFERENCE_UPLOADS_TABLE).update(patch).eq('id', uploadId);
  return !error;
}

// Best-effort: remove the object from storage and stamp deleted_at only once
// the removal actually succeeded (same invariant as
// h3-live-image-store.js's deleteUploadObject).
async function deleteUploadObject(db, row) {
  if (!row || !row.storage_path) return false;
  const bucket = row.storage_bucket || REFERENCE_QUARANTINE_BUCKET;
  let removed = false;
  try {
    const { error } = await db.storage.from(bucket).remove([row.storage_path]);
    removed = !error;
  } catch (_) {
    removed = false;
  }
  if (removed) {
    try {
      await db.from(REFERENCE_UPLOADS_TABLE)
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .is('deleted_at', null);
    } catch (_) { /* best effort */ }
  }
  return removed;
}

// Best-effort: remove the object now, stamp superseded_at (stops counting
// toward h3_max_reference_uploads_one_active_per_slot_idx immediately) but
// defer deleted_at to a later sweep — same rationale as
// h3-live-image-store.js's expirePendingUpload (a retained, unrevocable
// signed-upload token could still resurrect the object at this exact path
// for up to REFERENCE_SIGNED_UPLOAD_URL_TTL_MS).
//
// The UPDATE is an atomic claim conditioned on job_id IS NULL so a concurrent
// reservation that has already bound this row wins cleanly (this call then
// does nothing, which is correct: a bound row no longer collides with the
// per-slot unique index at all).
async function expirePendingUpload(db, row) {
  if (!row || !row.storage_path) return true;
  let claimed;
  try {
    const { data, error } = await db.from(REFERENCE_UPLOADS_TABLE)
      .update({
        superseded_at: new Date().toISOString(),
        delete_after: new Date(Date.now() + REFERENCE_SIGNED_UPLOAD_URL_TTL_MS).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', row.id)
      .is('job_id', null)
      .is('deleted_at', null)
      .is('superseded_at', null)
      .select('id');
    if (error) {
      console.error('[h3-max-reference-image-store] expirePendingUpload update failed:', error.message, 'uploadId:', row.id);
      return false;
    }
    claimed = Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.error('[h3-max-reference-image-store] expirePendingUpload update exception:', e?.message || String(e), 'uploadId:', row.id);
    return false;
  }

  if (!claimed) return true;

  const bucket = row.storage_bucket || REFERENCE_QUARANTINE_BUCKET;
  try {
    await db.storage.from(bucket).remove([row.storage_path]);
  } catch (_) { /* best effort — the deferred sweep retries this later */ }
  return true;
}

async function deleteUploadById(db, uploadId, userId) {
  const found = await getUploadRow(db, uploadId, userId);
  if (!found.ok) return false;
  return deleteUploadObject(db, found.row);
}

// Opportunistic cleanup, bounded and never throws — same shape as
// h3-live-image-store.js's sweepStaleUploads.
async function sweepStaleUploads(db) {
  try {
    const { data: rows, error } = await db
      .from(REFERENCE_UPLOADS_TABLE)
      .select('id, storage_bucket, storage_path')
      .lte('delete_after', new Date().toISOString())
      .is('deleted_at', null)
      .order('delete_after', { ascending: true })
      .limit(REFERENCE_CLEANUP_MAX_PER_RUN);
    if (error || !Array.isArray(rows) || rows.length === 0) {
      return { ok: !error, deleted: 0 };
    }

    const byBucket = new Map();
    for (const r of rows) {
      const bucket = r.storage_bucket || REFERENCE_QUARANTINE_BUCKET;
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket).push(r);
    }

    for (const [bucket, bucketRows] of byBucket) {
      const paths = bucketRows.map((r) => String(r.storage_path || '')).filter(Boolean);
      if (!paths.length) continue;
      const { error: removeError } = await db.storage.from(bucket).remove(paths);
      if (removeError) {
        console.error('[h3-max-reference-image-store] sweep storage remove failed:', removeError.message);
        return { ok: false, deleted: 0 };
      }
    }

    const nowIso = new Date().toISOString();
    await db.from(REFERENCE_UPLOADS_TABLE)
      .update({ deleted_at: nowIso, updated_at: nowIso })
      .in('id', rows.map((r) => r.id));

    return { ok: true, deleted: rows.length };
  } catch (error) {
    console.error('[h3-max-reference-image-store] sweep exception:', error?.message || String(error));
    return { ok: false, deleted: 0 };
  }
}

// Reconcile/best-effort cleanup for a job's whole bound image set (used only
// when releasing a reference/storyboard job — never touches the single-image
// mode's h3_live_image_uploads table).
async function deleteJobReferenceImages(db, jobId) {
  try {
    const { data: rows, error } = await db
      .from(REFERENCE_JOB_IMAGES_TABLE)
      .select('upload_id')
      .eq('job_id', jobId);
    if (error || !Array.isArray(rows) || rows.length === 0) return { ok: !error, deleted: 0 };

    const { data: uploads } = await db
      .from(REFERENCE_UPLOADS_TABLE)
      .select('*')
      .in('id', rows.map((r) => r.upload_id))
      .is('deleted_at', null);

    let deleted = 0;
    for (const row of uploads || []) {
      const ok = await deleteUploadObject(db, row).catch(() => false);
      if (ok) deleted++;
    }
    return { ok: true, deleted };
  } catch (error) {
    console.error('[h3-max-reference-image-store] deleteJobReferenceImages exception:', error?.message || String(error));
    return { ok: false, deleted: 0 };
  }
}

module.exports = {
  REFERENCE_QUARANTINE_BUCKET,
  REFERENCE_UPLOADS_TABLE,
  REFERENCE_JOB_IMAGES_TABLE,
  REFERENCE_ALLOWED_MIME,
  REFERENCE_MAX_BYTES,
  REFERENCE_MAX_IMAGES,
  isAllowedMime,
  isValidSlot,
  detectImageMime,
  createReferenceUploadSlot,
  getUploadRow,
  getUploadRowsOrdered,
  downloadAndValidate,
  createModerationSignedUrl,
  createFalSignedUrl,
  markModeration,
  deleteUploadObject,
  expirePendingUpload,
  deleteUploadById,
  sweepStaleUploads,
  deleteJobReferenceImages
};
