'use strict';

// Recover orphaned temporary watermark inputs even when the uploading process
// died, or Storage committed an upload after its timeout/finally deletion.
// Uses the EXISTING authenticated OpenRouter reconciliation entrypoint. No DB writes.
const RETENTION_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const OP_TIMEOUT_MS = 3000;
const BUDGET_MS = 20000;
const TEMP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|webm|mov)$/i;
function expiredTemporaryObject(item, cutoff) {
  // No directories, nested paths, unknown names, or unknown timestamps.
  if (!item || !item.id || !TEMP_NAME.test(String(item.name || ''))) return false;
  const created = Date.parse(String(item.created_at || ''));
  const updated = Date.parse(String(item.updated_at || ''));
  return Number.isFinite(created) && Number.isFinite(updated)
    && Math.max(created, updated) < cutoff;
}
async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup_timeout')), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}
async function sweepWatermarkInputs(db, { now = Date.now(), videoBucket = 'reference-images', operationTimeoutMs = OP_TIMEOUT_MS, budgetMs = BUDGET_MS, clock = Date.now } = {}) {
  if (!Number.isFinite(now) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(videoBucket)) {
    return { ok: false, scanned: 0, deleted: 0, failedTargets: 0, hasMore: false };
  }
  // Never accept target prefixes from an HTTP request. Final outputs, user
  // uploads, recordings, and database rows are deliberately outside this list.
  const targets = [
    { bucket: videoBucket, prefix: 'watermark-inputs' }
  ];
  const result = { ok: true, scanned: 0, deleted: 0, failedTargets: 0, hasMore: false };
  const deadline = clock() + budgetMs;
  const cutoff = now - RETENTION_MS;
  for (const target of targets) {
    if (clock() >= deadline) { result.ok = false; result.hasMore = true; break; }
    try {
      const bucket = db.storage.from(target.bucket);
      const cursorPath = `watermark-cleanup-state/${target.prefix}.json`;
      const readMs = Math.min(operationTimeoutMs, deadline - clock());
      if (readMs <= 0) throw new Error('cleanup_budget');
      const cursorRead = await bounded(() => bucket.download(cursorPath), readMs);
      let initialOffset = 0;
      if (cursorRead?.error) {
        if (String(cursorRead.error.statusCode || cursorRead.error.status || cursorRead.error.originalError?.status) !== '404') throw new Error('cleanup_cursor_read');
      } else {
        if (!cursorRead?.data || !Number.isFinite(cursorRead.data.size) || cursorRead.data.size > 256) throw new Error('cleanup_cursor_invalid');
        const cursor = JSON.parse(await bounded(() => cursorRead.data.text(), Math.min(operationTimeoutMs, Math.max(1, deadline - clock()))));
        if (cursor?.version !== 1 || !Number.isSafeInteger(cursor.nextOffset) || cursor.nextOffset < 0 || cursor.nextOffset > 1000000000) throw new Error('cleanup_cursor_invalid');
        initialOffset = cursor.nextOffset;
      }
      let scanOffset = initialOffset, exhausted = false, deletedHere = 0;
      const candidates = [];
      // Collect before deleting: deleting page 1 and then using offset=100
      // would skip shifted objects. A bounded batch drains on later runs.
      for (let page = 0; page < MAX_PAGES; page++) {
        const remaining = deadline - clock();
        if (remaining <= 0) throw new Error('cleanup_budget');
        const list = await bounded(() => bucket.list(target.prefix, {
          limit: PAGE_SIZE, offset: scanOffset,
          sortBy: { column: 'updated_at', order: 'asc' }
        }), Math.min(operationTimeoutMs, remaining));
        if (list?.error || !Array.isArray(list?.data)) throw new Error('cleanup_list');
        result.scanned += list.data.length;
        for (const item of list.data) {
          if (expiredTemporaryObject(item, cutoff)) candidates.push(`${target.prefix}/${item.name}`);
        }
        scanOffset += list.data.length;
        if (list.data.length < PAGE_SIZE) { exhausted = true; break; }
        if (page === MAX_PAGES - 1) result.hasMore = true;
      }
      for (let offset = 0; offset < candidates.length; offset += PAGE_SIZE) {
        const remaining = deadline - clock();
        if (remaining <= 0) throw new Error('cleanup_budget');
        const paths = candidates.slice(offset, offset + PAGE_SIZE);
        const removed = await bounded(() => bucket.remove(paths), Math.min(operationTimeoutMs, remaining));
        if (removed?.error || !Array.isArray(removed?.data)) throw new Error('cleanup_remove');
        // Count confirmed returned rows only; timeout/unknown is retried later.
        result.deleted += removed.data.length;
        deletedHere += removed.data.length;
      }
      // Persist a scan cursor so unknown/invalid old objects cannot starve
      // later valid objects. Cursor contains no paths, identities or secrets.
      // Account for this run's deletions shifting offsets; EOF wraps around.
      const nextOffset = exhausted ? 0 : Math.max(0, scanOffset - deletedHere);
      if (nextOffset !== initialOffset) {
        const remaining = deadline - clock();
        if (remaining <= 0) throw new Error('cleanup_budget');
        const saved = await bounded(() => bucket.upload(cursorPath,
          JSON.stringify({ version: 1, nextOffset }),
          { contentType: 'application/json', cacheControl: '0', upsert: true }
        ), Math.min(operationTimeoutMs, remaining));
        if (saved?.error || !saved?.data) throw new Error('cleanup_cursor_write');
      }
    } catch (_) {
      result.ok = false;
      result.failedTargets++;
      result.hasMore = true;
    }
  }
  return result;
}
module.exports = { RETENTION_MS, PAGE_SIZE, MAX_PAGES, expiredTemporaryObject, sweepWatermarkInputs };
