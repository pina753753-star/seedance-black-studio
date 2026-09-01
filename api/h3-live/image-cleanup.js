'use strict';

// GET /api/h3-live/image-cleanup
//
// Auth'd manual / cron entrypoint that removes abandoned H3 Live image-mode
// uploads (public.h3_live_image_uploads rows whose delete_after has passed).
// Requires Authorization: Bearer <CRON_SECRET>.
//
// NOTE: this endpoint is NOT registered in vercel.json's `crons` (that file is
// out of scope for the H3 Live slice). Until it is scheduled, cleanup relies on
// the opportunistic sweep every other /api/h3-live/* endpoint runs. This
// endpoint exists so an operator (or a future cron entry) can force a sweep.

const { createClient } = require('@supabase/supabase-js');
const { sweepStaleUploads } = require('../_lib/h3-live-image-store.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const MAX_BATCHES = 10;

function authenticate(req) {
  if (!CRON_SECRET) return false;
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  return auth.toLowerCase().startsWith('bearer ') && auth.slice(7).trim() === CRON_SECRET;
}

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!authenticate(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const result = await sweepStaleUploads(db);
    if (!result.ok) {
      return res.status(503).json({ ok: false, error: 'image_cleanup_failed', deleted });
    }
    deleted += result.deleted;
    if (result.deleted === 0) break;
  }

  return res.status(200).json({ ok: true, deleted });
}

handler._test = { authenticate };
module.exports = handler;
