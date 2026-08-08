const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_URL_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/;

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// Parses a Supabase Storage public URL into { bucket, path }. Returns null for
// anything else (empty string, non-Supabase URL, malformed value) so callers can
// safely skip deletion instead of guessing at a path.
function parseStorageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  const match = value.match(STORAGE_URL_RE);
  if (!match) return null;
  return { bucket: match[1], path: decodeURIComponent(match[2]) };
}

// Finds the caller's own generation_tasks row by primary key (id) or by the
// external job id (api_task_id). taskId is attacker-controlled input, so this
// always filters by user_id via parameterized query builder calls — never by
// string-interpolating taskId into a raw filter expression.
async function findOwnedTask(db, userId, taskId) {
  if (UUID_RE.test(taskId)) {
    const byId = await db
      .from('generation_tasks')
      .select('id,user_id,output_url,watermarked_url')
      .eq('user_id', userId)
      .eq('id', taskId)
      .maybeSingle();
    if (byId.error) return { row: null, error: byId.error.message };
    if (byId.data) return { row: byId.data, error: null };
  }
  const byApiTaskId = await db
    .from('generation_tasks')
    .select('id,user_id,output_url,watermarked_url')
    .eq('user_id', userId)
    .eq('api_task_id', taskId)
    .maybeSingle();
  if (byApiTaskId.error) return { row: null, error: byApiTaskId.error.message };
  return { row: byApiTaskId.data || null, error: null };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const db = serviceClient();
  if (!db) {
    return res.status(500).json({ ok: false, error: 'Missing Supabase environment variables' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const taskId = String(body.taskId || body.jobId || body.id || '').trim();
  if (!taskId) {
    return res.status(400).json({ ok: false, error: 'MISSING_TASK_ID' });
  }

  const { row, error: findError } = await findOwnedTask(db, auth.user.id, taskId);
  if (findError) {
    return res.status(500).json({ ok: false, error: findError });
  }
  if (!row) {
    // Either it doesn't exist or it belongs to someone else — same response
    // either way so this endpoint can't be used to probe other users' data.
    return res.status(404).json({ ok: false, error: 'NOT_FOUND' });
  }

  // Delete the Storage objects first. output_url and watermarked_url usually
  // point at different paths in the same bucket; dedupe so a single object
  // isn't requested twice in one remove() call.
  const targets = [parseStorageUrl(row.output_url), parseStorageUrl(row.watermarked_url)].filter(Boolean);
  const byBucket = new Map();
  for (const t of targets) {
    if (!byBucket.has(t.bucket)) byBucket.set(t.bucket, new Set());
    byBucket.get(t.bucket).add(t.path);
  }

  const storageErrors = [];
  for (const [bucket, paths] of byBucket) {
    const { error } = await db.storage.from(bucket).remove(Array.from(paths));
    if (error) storageErrors.push(`${bucket}: ${error.message}`);
  }

  // Delete the DB row even if a Storage removal above failed, so the task at
  // least disappears from history; report the storage failure so it isn't
  // silently swallowed. The row is re-scoped to user_id here too, defense in
  // depth against a race where ownership changed between the lookup and here.
  const del = await db
    .from('generation_tasks')
    .delete()
    .eq('id', row.id)
    .eq('user_id', auth.user.id);

  if (del.error) {
    return res.status(500).json({
      ok: false,
      error: del.error.message,
      storageErrors: storageErrors.length ? storageErrors : undefined
    });
  }

  return res.status(200).json({
    ok: true,
    deletedTaskId: row.id,
    storageErrors: storageErrors.length ? storageErrors : undefined
  });
};
