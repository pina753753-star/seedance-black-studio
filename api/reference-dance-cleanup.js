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
    .select('id,user_id,staging_path,approved_path,review_paths')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (selectError) return res.status(500).json({ ok: false, error: 'Reference video cleanup lookup failed' });
  let deleted = 0;
  const failedIds = [];
  for (const row of rows || []) {
    const paths = pathsForRow(row);
    if (paths.length) {
      const { error: storageError } = await db.storage.from(REFERENCE_DANCE_BUCKET).remove(paths);
      if (storageError) {
        console.error('[reference-dance-cleanup] storage removal failed', row.id, storageError.message);
        failedIds.push(row.id);
        continue;
      }
    }
    const { error: rowDeleteError } = await db.from(REFERENCE_DANCE_TABLE).delete().eq('id', row.id);
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
