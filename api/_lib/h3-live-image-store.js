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
  IMAGE_CLEANUP_MAX_PER_RUN,
  IMAGE_SIGNED_UPLOAD_URL_TTL_MS
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

  // Replace any of this user's still-pending (unbound, not-deleted) uploads
  // before creating a new one. The UI only ever tracks one image at a time
  // (h3-live.html's state.uploadId), so a new upload always supersedes
  // whatever was picked before — this keeps that the common case rather than
  // an error. It also closes the gap (found in review, PR #224) that let a
  // caller accumulate unlimited pending uploads by repeatedly calling this
  // endpoint: the original h3_live_image_uploads_one_bound_per_job_idx never
  // actually capped this (it only constrained already-bound rows, and every
  // newly issued slot has job_id = NULL), so nothing stopped unbounded 20 MiB
  // objects piling up for up to 48h (IMAGE_UPLOAD_RETENTION_MS) before the
  // sweep caught them. The DB-level backstop is now
  // h3_live_image_uploads_one_pending_per_user_idx (see the migration that
  // replaced that index); this sweep is what keeps normal use from ever
  // hitting that constraint.
  //
  // Uses expirePendingUpload (below), NOT deleteUploadObject: the caller may
  // have already received the prior slot's signed upload URL, and Supabase
  // Storage's createSignedUploadUrl token has a fixed ~2h expiry that cannot
  // be revoked (IMAGE_SIGNED_UPLOAD_URL_TTL_MS) — so it could still be used
  // to re-upload to that exact object_path after this point (found in
  // review, PR #224 follow-up). Stamping deleted_at immediately would make
  // that resurrected object invisible to sweepStaleUploads (which filters
  // deleted_at IS NULL) forever. expirePendingUpload instead removes the
  // current object now (handles the common case immediately) but defers the
  // deleted_at stamp to a later sweep pass, once any retained token is
  // guaranteed expired.
  const { data: priorPending, error: priorLookupError } = await db
    .from(UPLOADS_TABLE)
    .select('id, object_path')
    .eq('user_id', userId)
    .is('job_id', null)
    .is('deleted_at', null)
    .is('superseded_at', null);
  if (priorLookupError) {
    return { ok: false, error: 'pending_upload_lookup_failed' };
  }
  for (const prior of priorPending || []) {
    // If this fails, `prior` is left counting toward the per-user pending
    // slot (superseded_at not stamped) — proceeding to the INSERT below
    // would then predictably fail with a 23505 that looks like a normal
    // concurrency conflict but is actually a stuck row. Fail fast with a
    // distinct, operator-greppable error instead (found in review, PR #224
    // follow-up round 2). expirePendingUpload logs the underlying cause.
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

  // Mint the signed upload token BEFORE inserting the registry row (this
  // order matters — see the round-2/round-3 note below, not just "which
  // happens to work"). createSignedUploadUrl's token has a fixed ~2h expiry
  // that cannot be revoked once minted (IMAGE_SIGNED_UPLOAD_URL_TTL_MS in
  // h3-live-config.js). This keeps a hard invariant true everywhere else in
  // this file (deleteUploadObject, expirePendingUpload, sweepStaleUploads):
  // a row's delete_after is always set no earlier than its own object's
  // real, live token expiry, so a sweep never removes an object + stamps
  // deleted_at (making the row permanently unsweepable) while a still-valid
  // token for that exact path remains outstanding. Minting BEFORE this row
  // exists guarantees mint time <= this row's insert time <= any later
  // supersede of this row, so a subsequent expirePendingUpload's
  // supersede-time + IMAGE_SIGNED_UPLOAD_URL_TTL_MS deadline is always >=
  // this token's own mint time + IMAGE_SIGNED_UPLOAD_URL_TTL_MS.
  //
  // An earlier draft of this fix (round 2) inserted the row FIRST and only
  // minted the token after, to avoid minting a token for a losing 23505
  // race (see below). Review (round 3) found that ordering broke the
  // invariant above: if a concurrent request superseded this row between
  // the INSERT and the (possibly slow) createSignedUploadUrl call, the
  // superseder would compute delete_after from ITS OWN (earlier) timestamp,
  // while this call's token would only start its real countdown once it
  // actually minted (later) — leaving delete_after earlier than the token's
  // real expiry. A sweep could then remove the object and stamp deleted_at
  // while the token our own caller had just been handed was still valid,
  // producing exactly the unsweepable-orphan failure mode this whole change
  // exists to prevent. Minting first closes that; see the residual,
  // narrower risk noted at the insertError branch below instead.
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
    // untracked (there is no registry row to sweep it later). This cannot
    // revoke the token itself (Supabase has no revoke API), so if this
    // removal fails too, the object could still be recreated by whoever
    // holds this token for up to IMAGE_SIGNED_UPLOAD_URL_TTL_MS with zero DB
    // tracking. That residual risk is bounded to this exact process's own
    // in-flight request (the token is never returned to any HTTP caller on
    // this error path — the function returns an error, not the token) and
    // pre-dates this change; it is not widened by it.
    await db.storage.from(IMAGE_QUARANTINE_BUCKET).remove([storedPath]).catch(() => {});
    // 23505 = unique_violation against h3_live_image_uploads_one_pending_
    // per_user_idx. Only reachable via a genuine race (two concurrent calls
    // for the same user both passed the supersede loop above before either
    // inserted) since that loop just removed any prior pending upload for
    // this user. Reported distinctly so it is not confused with a real
    // registry failure in logs.
    if (insertError.code === '23505') {
      return { ok: false, error: 'pending_upload_conflict' };
    }
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

// Best-effort: remove the object now, stamp superseded_at so the row
// immediately stops counting toward h3_live_image_uploads_one_pending_per_
// user_idx, but do NOT stamp deleted_at — instead push delete_after out to
// cover IMAGE_SIGNED_UPLOAD_URL_TTL_MS, keeping the row visible to
// sweepStaleUploads for one more pass after that window.
//
// Used only when superseding a still-pending upload (createImageUploadSlot's
// replace-before-insert step above), never for a terminal cleanup — the
// caller may already hold that row's signed upload URL, and Supabase's
// createSignedUploadUrl token has a fixed ~2h expiry with no revoke API
// (IMAGE_SIGNED_UPLOAD_URL_TTL_MS; see h3-live-config.js), so it could still
// be used to write a new object to the same object_path after this call
// returns. If this stamped deleted_at immediately (like deleteUploadObject),
// such a resurrected object would be permanently invisible to
// sweepStaleUploads (which filters deleted_at IS NULL) — an unsweepable
// orphan. Deferring delete_after instead guarantees a later opportunistic
// sweep re-checks object_path once any retained token is guaranteed expired,
// catching a resurrected object rather than losing track of it forever.
//
// superseded_at is a SEPARATE marker from deleted_at (added by the migration
// that replaced h3_live_image_uploads_one_bound_per_job_idx): leaving
// deleted_at null here (so the row stays sweepable) but doing nothing else
// would leave the row still matching job_id IS NULL AND deleted_at IS NULL —
// i.e. still colliding with the very "one pending upload per user" unique
// index this whole fix exists to add, which would make the caller's very
// next insert in createImageUploadSlot fail with a unique violation on every
// single replacement. Stamping superseded_at removes it from that predicate
// immediately while leaving deleted_at/delete_after doing their normal job.
//
// The UPDATE below is an ATOMIC CLAIM, not a blind write, and it runs BEFORE
// any Storage removal — both load-bearing. `row` was read by the caller via
// a plain SELECT with no lock, so between that read and this call, a
// concurrent api/h3-live/start.js request can have raced in and legitimately
// bound the very same row to a real (possibly already-charged) job via
// reserve_h3_live_job_atomic. Removing the Storage object first (the
// previous version of this function did that) would then delete the input
// image out from under an active job — found in review, PR #224 follow-up
// round 2. Conditioning this UPDATE on job_id IS NULL (in addition to
// deleted_at/superseded_at IS NULL — the same predicate as the unique index)
// makes it lose that race cleanly: if a bind won, this UPDATE matches zero
// rows and the object is never touched. That is also correct bookkeeping,
// not just a safe no-op — once job_id is set the row no longer collides with
// h3_live_image_uploads_one_pending_per_user_idx at all, so there is nothing
// left here for this call to do.
//
// Never throws (all failures are caught internally). Returns whether the
// row was left in a state where it no longer blocks a new upload slot for
// this user: true if this call claimed it (and removed the object), if a
// concurrent bind claimed it first (row no longer pending; see above), or if
// there was nothing to do; false only when the claim UPDATE itself could not
// be confirmed to have run (a real DB error) — the caller then cannot tell
// whether the row still collides with the unique index, so it must stop
// rather than let the next INSERT fail with a misleading 23505.
async function expirePendingUpload(db, row) {
  if (!row || !row.object_path) return true;
  let claimed;
  try {
    const { data, error } = await db.from(UPLOADS_TABLE)
      .update({
        superseded_at: new Date().toISOString(),
        delete_after: new Date(Date.now() + IMAGE_SIGNED_UPLOAD_URL_TTL_MS).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', row.id)
      .is('job_id', null)
      .is('deleted_at', null)
      .is('superseded_at', null)
      .select('id');
    if (error) {
      console.error('[h3-live-image-store] expirePendingUpload update failed:', error.message, 'uploadId:', row.id);
      return false;
    }
    claimed = Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.error('[h3-live-image-store] expirePendingUpload update exception:', e?.message || String(e), 'uploadId:', row.id);
    return false;
  }

  if (!claimed) {
    // Lost the claim — a concurrent bind (or another concurrent supersede)
    // got there first. Either way the object must NOT be removed here.
    return true;
  }

  try {
    await db.storage.from(IMAGE_QUARANTINE_BUCKET).remove([row.object_path]);
  } catch (_) {
    // Best effort — the deferred sweep (via the delete_after pushed out
    // above) still retries this later.
  }
  return true;
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
  expirePendingUpload,
  deleteUploadById,
  sweepStaleUploads
};
