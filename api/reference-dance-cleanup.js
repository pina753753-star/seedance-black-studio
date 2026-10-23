'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  REFERENCE_DANCE_BUCKET,
  REFERENCE_DANCE_TABLE,
  validateOwnedPath,
  approvedPath,
  reviewFramePath
} = require('./_lib/reference-dance.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const MAX_PER_RUN = 50;

function authenticate(req) {
  if (!CRON_SECRET) return false;
  const header = String(req.headers?.authorization || req.headers?.Authorization || '');
  return header.toLowerCase().startsWith('bearer ') && header.slice(7).trim() === CRON_SECRET;
}

function pathsForRow(row) {
  const paths = [];
  if (validateOwnedPath('staging', row.user_id, row.id, row.staging_path)) paths.push(row.staging_path);
  // Inspection can upload one or more deterministic outputs before a later
  // frame/moderation/DB step fails. Derive every sealed path so expiry cleanup
  // also removes those partially committed objects.
  paths.push(approvedPath(row.user_id, row.id));
  for (let index = 1; index <= 5; index++) paths.push(reviewFramePath(row.user_id, row.id, index));
  if (validateOwnedPath('approved', row.user_id, row.id, row.approved_path)) paths.push(row.approved_path);
  for (const path of Array.isArray(row.review_paths) ? row.review_paths : []) {
    if (validateOwnedPath('review', row.user_id, row.id, path)) paths.push(path);
  }
  return [...new Set(paths)];
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!authenticate(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data: rows, error: selectError } = await db.from(REFERENCE_DANCE_TABLE)
    .select('id,user_id,status,staging_path,approved_path,review_paths,expires_at,updated_at,last_task_id')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (selectError) return res.status(500).json({ ok: false, error: 'Reference video cleanup lookup failed' });
  let deleted = 0;
  const failedIds = [];
  for (const row of rows || []) {
    // Do not remove input still referenced by any nonterminal task, not only
    // last_task_id (the asset may have been reused by multiple tasks).
    const { count: activeCount, error: activeError } = await db.from('generation_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', row.user_id)
      .contains('settings', { reference_dance: { asset_id: row.id } })
      .in('status', ['queued', 'processing', 'pending', 'running', 'needs_review']);
    if (activeError || activeCount == null || activeCount > 0) {
      if (activeError || activeCount == null) failedIds.push(row.id);
      continue;
    }
    // Conditional tombstone races safely with a lease renewal or task bind:
    // whichever update wins causes the other operation's predicate to fail.
    const { data: claimed, error: claimError } = await db.from(REFERENCE_DANCE_TABLE)
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', row.id).eq('status', row.status)
      .eq('updated_at', row.updated_at).eq('expires_at', row.expires_at)
      .lte('expires_at', new Date().toISOString()).select('id');
    if (claimError) { failedIds.push(row.id); continue; }
    if (!claimed || claimed.length !== 1) continue;
    const paths = pathsForRow(row);
    if (paths.length) {
      const { error: storageError } = await db.storage.from(REFERENCE_DANCE_BUCKET).remove(paths);
      if (storageError) {
        console.error('[reference-dance-cleanup] storage removal failed', row.id, storageError.message);
        failedIds.push(row.id);
        continue;
      }
    }
    const { error: rowDeleteError } = await db.from(REFERENCE_DANCE_TABLE).delete().eq('id', row.id).eq('status', 'failed').eq('expires_at', row.expires_at);
    if (rowDeleteError) {
      console.error('[reference-dance-cleanup] row removal failed', row.id, rowDeleteError.message);
      failedIds.push(row.id);
      continue;
    }
    deleted += 1;
  }
  return res.status(failedIds.length ? 503 : 200).json({
    ok: failedIds.length === 0,
    checked: (rows || []).length,
    deleted,
    failed: failedIds.length
  });
}

handler._test = { authenticate, pathsForRow };
module.exports = handler;

