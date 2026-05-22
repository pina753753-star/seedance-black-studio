const { createClient } = require('@supabase/supabase-js');

const TABLE = 'flowvid_video_history';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

function dbClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

function normalizeRow(row) {
  return {
    id: row.id,
    job_id: row.job_id,
    status: row.status || (row.video_url ? 'completed' : 'processing'),
    title: row.title || (String(row.prompt || '').includes('香水') ? 'Perfume sample' : '生成サンプル'),
    prompt: row.prompt || '',
    video_uri: row.video_uri || row.video_url || '',
    src: row.video_url || row.video_uri || '',
    duration_seconds: row.settings?.duration || row.duration_seconds || 5,
    aspect_ratio: row.settings?.aspect_ratio || row.aspect_ratio || '9:16',
    created_at: row.created_at || row.updated_at || new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    const db = dbClient();
    if (!db) return res.status(200).json({ ok: true, rows: [], note: 'Missing Supabase key' });

    const { data, error } = await db
      .from(TABLE)
      .select('*')
      .not('video_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) return res.status(200).json({ ok: false, rows: [], error: error.message });
    return res.status(200).json({ ok: true, rows: (data || []).map(normalizeRow) });
  } catch (error) {
    return res.status(200).json({ ok: false, rows: [], error: error?.message || 'Unknown error' });
  }
};