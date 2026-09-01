'use strict';

// GET /api/h3-live/jobs?limit=<1..20>&cursor=<opaque>
//
// Keyset-paginated recent H3 Live jobs for the authenticated owner. Read-only:
// never calls fal.ai. Returns sanitized fields only.

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { serviceClient, sanitizeJob } = require('../_lib/h3-live-store.js');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

function encodeCursor(row) {
  if (!row) return null;
  return Buffer.from(JSON.stringify({ c: row.created_at, i: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!parsed || typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed', message: 'GET only.' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const cursor = decodeCursor(req.query.cursor);
  if (req.query.cursor && !cursor) {
    return res.status(400).json({ ok: false, error: 'invalid_cursor' });
  }

  let query = db
    .from('h3_live_jobs')
    .select('*')
    .eq('user_id', auth.user.id)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1);

  if (cursor) {
    // (created_at, id) strictly before the cursor. Values are double-quoted so
    // the timestamp's '+'/'.'/':' and the uuid are treated as literals.
    const c = JSON.stringify(String(cursor.c));
    const i = JSON.stringify(String(cursor.i));
    query = query.or(
      `created_at.lt.${c},and(created_at.eq.${c},id.lt.${i})`
    );
  }

  const { data, error } = await query;
  if (error) {
    console.error('[h3-live/jobs] query error:', error.message);
    return res.status(500).json({ ok: false, error: 'jobs_lookup_failed' });
  }

  const rows = Array.isArray(data) ? data : [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return res.status(200).json({
    ok: true,
    jobs: page.map(sanitizeJob),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null
  });
};
