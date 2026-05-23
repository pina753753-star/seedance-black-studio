const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

function dbClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

function validVideoUrl(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  if (/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(value)) return '';
  if (/\.(mp4|mov|webm)(\?|$)/i.test(value)) return value;
  if (/\/storage\/v1\/object\/public\//i.test(value)) return value;
  return '';
}

function normalizeGeneratedRow(row) {
  const url = validVideoUrl(row.video_uri || row.video_url || row.url || '');
  if (!url) return null;
  return {
    id: row.id || row.job_id || row.operation_name || url,
    job_id: row.operation_name || row.job_id || '',
    status: row.status || 'completed',
    title: String(row.prompt || '').includes('香水') ? 'Perfume sample' : '生成サンプル',
    prompt: row.prompt || '',
    video_uri: url,
    video_url: url,
    src: url,
    duration_seconds: row.duration_seconds || 5,
    aspect_ratio: row.aspect_ratio || '9:16',
    created_at: row.created_at || row.updated_at || new Date().toISOString()
  };
}

function normalizeHistoryRow(row) {
  const url = validVideoUrl(row.video_url || row.video_uri || row.url || '');
  if (!url) return null;
  return {
    id: row.id || row.job_id || url,
    job_id: row.job_id || '',
    status: row.status || 'completed',
    title: '生成動画',
    prompt: row.prompt || '',
    video_uri: url,
    video_url: url,
    src: url,
    duration_seconds: row.duration_seconds || 5,
    aspect_ratio: row.aspect_ratio || '9:16',
    created_at: row.created_at || row.updated_at || new Date().toISOString()
  };
}

async function readGeneratedVideos(db, limit) {
  const { data, error } = await db
    .from('generated_videos')
    .select('*')
    .eq('status', 'completed')
    .not('video_uri', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  return { rows: (data || []).map(normalizeGeneratedRow).filter(Boolean), error: null };
}

async function readFlowvidHistory(db, limit) {
  const { data, error } = await db
    .from('flowvid_video_history')
    .select('*')
    .eq('status', 'completed')
    .not('video_url', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  return { rows: (data || []).map(normalizeHistoryRow).filter(Boolean), error: null };
}

module.exports = async function handler(req, res) {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    const db = dbClient();
    if (!db) return res.status(200).json({ ok: true, rows: [], note: 'Missing Supabase key' });

    const [generated, history] = await Promise.all([
      readGeneratedVideos(db, limit),
      readFlowvidHistory(db, limit)
    ]);

    const byUrl = new Map();
    for (const row of [...history.rows, ...generated.rows]) {
      const key = row.video_url || row.video_uri || row.src;
      if (!byUrl.has(key)) byUrl.set(key, row);
    }

    const rows = Array.from(byUrl.values())
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);

    return res.status(200).json({
      ok: true,
      rows,
      sources: {
        flowvid_video_history: { count: history.rows.length, error: history.error },
        generated_videos: { count: generated.rows.length, error: generated.error }
      }
    });
  } catch (error) {
    return res.status(200).json({ ok: false, rows: [], error: error?.message || 'Unknown error' });
  }
};