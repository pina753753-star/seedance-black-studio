'use strict';

const { createClient } = require('@supabase/supabase-js');
const {
  REFERENCE_AUDIO_BUCKET,
  REFERENCE_AUDIO_REGISTRY_TABLE
} = require('./_lib/reference-audio.js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const CRON_SECRET = process.env.CRON_SECRET || '';
const MAX_PER_RUN = 100;

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

  const { data: expired, error: selectError } = await db
    .from(REFERENCE_AUDIO_REGISTRY_TABLE)
    .select('path')
    .lte('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (selectError) return res.status(500).json({ ok: false, error: 'Audio cleanup lookup failed' });

  const paths = (expired || []).map(row => String(row.path || '')).filter(Boolean);
  if (!paths.length) return res.status(200).json({ ok: true, checked: 0, deleted: 0 });

  // Supabase explicitly requires object deletion through the Storage API;
  // deleting storage.objects metadata directly can leave billable objects.
  const { error: storageError } = await db.storage.from(REFERENCE_AUDIO_BUCKET).remove(paths);
  if (storageError) {
    console.error('[reference-audio-cleanup] storage removal failed', storageError.message);
    return res.status(503).json({ ok: false, error: 'Audio cleanup storage removal failed' });
  }

  const { error: registryError } = await db
    .from(REFERENCE_AUDIO_REGISTRY_TABLE)
    .delete()
    .in('path', paths);
  if (registryError) {
    console.error('[reference-audio-cleanup] registry removal failed', registryError.message);
    return res.status(503).json({ ok: false, error: 'Audio cleanup registry removal failed' });
  }

  return res.status(200).json({ ok: true, checked: paths.length, deleted: paths.length });
}

handler._test = { authenticate };
module.exports = handler;
