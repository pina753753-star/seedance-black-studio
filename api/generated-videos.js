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
  return '';
}

function isKnownBrokenRow(row) {
  return BROKEN_JOB_IDS.has(String(row?.job_id || row?.operation_name || row?.id || ''));
}

function isSupabaseStorageUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && /\/storage\/v1\/object\/public\//i.test(String(url || ''));
}

// Confirms a Supabase Storage public URL actually has a readable object behind it.
// Mirrors api/seedance-status.js's verifyPublicObject(): try HEAD first, and when
// the HEAD response doesn't carry usable content-type/content-length (some Storage
// responses omit them), fall back to a Range GET of the first 1024 bytes, reading
// headers only. Read-only: never writes to Storage.
const STORAGE_CHECK_TIMEOUT_MS = 4000;
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORAGE_CHECK_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function verifyStorageObjectExists(url) {
  try {
    const headRes = await fetchWithTimeout(url, { method: 'HEAD' });
    const headContentType = headRes.headers.get('content-type') || '';
    const headContentLength = Number(headRes.headers.get('content-length') || 0);
    if (headRes.ok && /video|octet-stream/i.test(headContentType) && headContentLength >= 1024) {
      return true;
    }

    // HEAD insufficient — fall back to Range GET, headers only (no body reading)
    const rangeRes = await fetchWithTimeout(url, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
    const contentType = rangeRes.headers.get('content-type') || '';

    // Discard body immediately without reading
    await rangeRes.body?.cancel().catch(() => {});

    if (!rangeRes.ok && rangeRes.status !== 206) return false;

    const contentRange = rangeRes.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const totalBytes = totalMatch ? Number(totalMatch[1]) : Number(rangeRes.headers.get('content-length') || 0);

    if (!totalBytes || totalBytes < 1024) return false;
    if (!/video|octet-stream/i.test(contentType)) return false;

    return true;
  } catch (_) {
    // Network error, timeout, or abort: unverifiable, so exclude the row (safe default).
    return false;
  }
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

async function normalizeGeneratedRow(row) {
  if (isKnownBrokenRow(row)) return null;
  const url = validVideoUrl(row.video_uri || row.video_url || row.url || '');
  if (!url) return null;
  if (isSupabaseStorageUrl(url) && !(await verifyStorageObjectExists(url))) return null;
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

async function normalizeHistoryRow(row) {
  if (isKnownBrokenRow(row)) return null;
  const url = validVideoUrl(row.video_url || row.video_uri || row.url || '');
  if (!url) return null;
  if (isSupabaseStorageUrl(url) && !(await verifyStorageObjectExists(url))) return null;
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
  const normalized = await Promise.all((data || []).map(normalizeGeneratedRow));
  return { rows: normalized.filter(Boolean), error: null };
}

async function readFlowvidHistory(db, limit, userId) {
  if (!userId) return { rows: [], error: 'missing_authenticated_user' };
  const { data, error } = await db
    .from('generation_tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'completed')
    .not('output_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return { rows: [], error: error.message };
  const rows = (data || []).map(task => {
    const dur = Number(task.duration_seconds);
    const watermarkedUrl = validVideoUrl(task.watermarked_url || '');
    const outputUrl = validVideoUrl(task.output_url || '');

    // fal tasks: only display if watermarked_url is valid.
    // (fal tasks set watermarked_url on completion — missing means processing not finished.)
    // OpenRouter tasks: keep existing behavior (watermarked_url preferred, output_url fallback).
    if (task.api_provider === 'fal' && !watermarkedUrl) return null;

    return {
      id: task.id,
      job_id: task.api_task_id || task.id,
      status: 'completed',
      prompt: task.prompt || '',
      mode: task.mode || '',
      video_url: watermarkedUrl || outputUrl || '',
      reference_urls: [],
      settings: task.settings || {},
      created_at: task.created_at,
      updated_at: task.updated_at,
      duration_seconds: Number.isFinite(dur) && dur > 0 ? dur : 5,
      aspect_ratio: task.aspect_ratio || '9:16',
      watermarked_url: task.watermarked_url || ''
    };
  });
  const normalized = await Promise.all(rows.map(r => (r ? normalizeHistoryRow(r) : null)));
  return { rows: normalized.filter(Boolean), error: null };
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
    if (!userId) {
      if (req.query.public === 'true') {
        const generated = await readGeneratedVideos(db, limit);
        return res.status(200).json({ ok: true, rows: generated.rows });
      }
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const history = await readFlowvidHistory(db, limit, userId);

    const rows = history.rows
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, limit);

    return res.status(200).json({
      ok: true,
      rows,
      sources: {
        generation_tasks: { count: history.rows.length, error: history.error },
        hidden_broken_job_ids: Array.from(BROKEN_JOB_IDS)
      }
    });
  } catch (error) {
    return res.status(200).json({ ok: false, rows: [], error: error?.message || 'Unknown error' });
  }
};