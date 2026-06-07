const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const BROKEN_JOB_IDS = new Set(['uyfqpQhNClOWXqKYPfQ5']);

function dbClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

function validVideoUrl(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  if (/\.(mp4|mov|webm)(\?|$)/i.test(value)) return value;
  if (/\/storage\/v1\/object\/public\//i.test(value)) return value;
  if (/openrouter\.ai\/api\/v1\/videos\//i.test(value)) return value;
  return '';
}

function isKnownBrokenRow(row) {
  return BROKEN_JOB_IDS.has(String(row?.job_id || row?.operation_name || row?.id || ''));
}

function resolveMode(row) {
  const raw = String(row?.mode || row?.generation_mode || row?.settings?.mode || '').trim();
  if (raw === 'image_to_video' || raw === '画像から動画' || raw === '画像から動画へ') return 'image_to_video';
  if (raw === 'text_to_video' || raw === 'テキストから動画') return 'text_to_video';
  if (raw === 'reference_to_video' || raw === 'リファレンス') return 'reference_to_video';
  if (raw) return raw;
  // Infer from settings when mode column is empty
  const s = row?.settings || {};
  if (Array.isArray(s.reference_urls) && s.reference_urls.length) return 'reference_to_video';
  if (s.reference_url || s.referenceUrl) return 'reference_to_video';
  if (s.first_frame_url || s.input_image_url || s.image_url || s.imageUrl || s.inputImageUrl) return 'image_to_video';
  if (row?.first_frame_url || row?.input_image_url) return 'image_to_video';
  return '';
}

function normalizeGeneratedRow(row) {
  if (isKnownBrokenRow(row)) return null;
  const url = validVideoUrl(row.video_uri || row.video_url || row.url || '');
  if (!url) return null;
  return {
    id: row.id || row.job_id || row.operation_name || url,
    job_id: row.operation_name || row.job_id || '',
    status: row.status || 'completed',
    title: String(row.prompt || '').includes('香水') ? 'Perfume sample' : '生成サンプル',
    prompt: row.prompt || '',
    mode: resolveMode(row),
    video_uri: url,
    video_url: url,
    src: url,
    duration_seconds: row.duration_seconds || 5,
    aspect_ratio: row.aspect_ratio || '9:16',
    created_at: row.created_at || row.updated_at || new Date().toISOString()
  };
}

function normalizeHistoryRow(row) {
  if (isKnownBrokenRow(row)) return null;
  const url = validVideoUrl(row.video_url || row.video_uri || row.url || '');
  if (!url) return null;
  return {
    id: row.id || row.job_id || url,
    job_id: row.job_id || '',
    status: row.status || 'completed',
    title: '生成動画',
    prompt: row.prompt || '',
    mode: resolveMode(row),
    reference_urls: Array.isArray(row.reference_urls) ? row.reference_urls : [],
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

async function readFlowvidHistory(db, limit, userId) {
  if (userId) {
    const { data, error } = await db
      .from('generation_tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'completed')
      .not('output_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return { rows: [], error: error.message };
    const rows = (data || []).map(task => ({
      id: task.id,
      job_id: task.api_task_id || task.id,
      status: 'completed',
      prompt: task.prompt || '',
      mode: task.mode || '',
      video_url: task.output_url || '',
      reference_urls: [],
      settings: task.settings || {},
      created_at: task.created_at,
      updated_at: task.updated_at
    }));
    return { rows: rows.map(normalizeHistoryRow).filter(Boolean), error: null };
  }
  const { data, error } = await db
    .from('flowvid_video_history')
    .select('*')
    .eq('status', 'completed')
    .not('video_url', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) return { rows: [], error: error.message };
  const rows = (data || []);

  // Find rows missing mode or prompt — backfill from generation_tasks via api_task_id
  const needsBackfill = rows.filter(r => !r.mode || !r.prompt);
  if (needsBackfill.length > 0) {
    const jobIds = needsBackfill.map(r => r.job_id).filter(Boolean);
    if (jobIds.length > 0) {
      const { data: tasks } = await db
        .from('generation_tasks')
        .select('api_task_id,mode,prompt')
        .in('api_task_id', jobIds);
      if (tasks && tasks.length) {
        const byJobId = new Map(tasks.map(t => [t.api_task_id, t]));
        for (const row of rows) {
          const task = byJobId.get(row.job_id);
          if (!task) continue;
          if (!row.mode && task.mode) row.mode = task.mode;
          if (!row.prompt && task.prompt) row.prompt = task.prompt;
        }
      }
    }
  }

  return { rows: rows.map(normalizeHistoryRow).filter(Boolean), error: null };
}

module.exports = async function handler(req, res) {
  try {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    const db = dbClient();
    if (!db) return res.status(200).json({ ok: true, rows: [], note: 'Missing Supabase key' });

    // 認証チェック
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    let userId = null;
    if (token) {
      try {
        const { createClient: cc } = require('@supabase/supabase-js');
        const userClient = cc(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
        const { data: { user } } = await userClient.auth.getUser(token);
        userId = user?.id || null;
      } catch (_) {}
    }
    if (!userId) return res.status(200).json({ ok: true, rows: [] });

    const [generated, history] = await Promise.all([
      readGeneratedVideos(db, limit),
      readFlowvidHistory(db, limit, userId)
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
        generated_videos: { count: generated.rows.length, error: generated.error },
        hidden_broken_job_ids: Array.from(BROKEN_JOB_IDS)
      }
    });
  } catch (error) {
    return res.status(200).json({ ok: false, rows: [], error: error?.message || 'Unknown error' });
  }
};