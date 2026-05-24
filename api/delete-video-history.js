const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

function dbClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const db = dbClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase key' });

  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }

  const jobId = String(body.jobId || body.job_id || '').trim();
  if (!jobId) return res.status(400).json({ ok: false, error: 'jobId is required' });

  const { data, error } = await db
    .from('flowvid_video_history')
    .delete()
    .eq('job_id', jobId)
    .select('job_id');

  if (error) return res.status(500).json({ ok: false, error: error.message, jobId });

  return res.status(200).json({ ok: true, jobId, deleted: data?.length || 0 });
};
