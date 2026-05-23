const { createClient } = require('@supabase/supabase-js');

const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';
const HISTORY_TABLE = 'flowvid_video_history';

function dbClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

function isStatusEndpointUrl(url) {
  const value = String(url || '');
  return /^https?:\/\/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(value);
}

function findVideoUrl(value, keyName = '') {
  if (!value) return null;

  if (typeof value === 'string') {
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return null;

    if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) return url;

    const keyLooksLikeVideo = /(videoUrl|video_url|output_url|download_url|file_url|asset_url|signed_url|play_url|url)$/i.test(keyName || '');
    const urlLooksDownloadable = /(download|output|storage|cdn|signed|play|file|asset)/i.test(url);

    if (isStatusEndpointUrl(url) && !/\.(mp4|mov|webm)(\?|$)/i.test(url)) return null;
    if (keyLooksLikeVideo && urlLooksDownloadable) return url;

    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item, keyName);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const priorityKeys = ['videoUrl', 'video_url', 'output_url', 'download_url', 'file_url', 'asset_url', 'signed_url', 'play_url'];
    for (const key of priorityKeys) {
      const found = findVideoUrl(value[key], key);
      if (found) return found;
    }
    for (const key of Object.keys(value)) {
      const found = findVideoUrl(value[key], key);
      if (found) return found;
    }
  }

  return null;
}

function normalizeStatus(data) {
  return String(data?.status || data?.data?.status || data?.response?.status || data?.result?.status || '').toLowerCase();
}

function extFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('quicktime') || type.includes('mov')) return 'mov';
  return 'mp4';
}

function isSupabasePublicUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && String(url || '').includes('/storage/v1/object/public/');
}

function isOpenRouterUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && String(url || '').includes('openrouter.ai');
}

function effectiveJobId({ jobId, pollingUrl, rawVideoUrl }) {
  if (jobId) return jobId;

  for (const url of [pollingUrl, rawVideoUrl]) {
    try {
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const parsed = new URL(url);
      const queryId = parsed.searchParams.get('id') || parsed.searchParams.get('jobId') || parsed.searchParams.get('job_id');
      if (queryId) return String(queryId).trim();

      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const pathId = pathParts[pathParts.length - 1];
      if (pathId && !/^(download|output|video|file|public)$/i.test(pathId)) return pathId;
    } catch (_) {
      // Ignore malformed URLs and fall back below.
    }
  }

  return `video-${Date.now()}`;
}

async function verifyPublicObject(publicUrl) {
  try {
    const response = await fetch(publicUrl, { method: 'GET' });
    const contentType = response.headers.get('content-type') || '';
    const bytes = Number(response.headers.get('content-length') || 0);
    const body = await response.arrayBuffer();
    const actualBytes = body.byteLength;

    if (!response.ok) {
      return { ok: false, status: response.status, contentType, bytes: actualBytes, error: 'public-url-not-readable' };
    }
    if (actualBytes < 1024) {
      return { ok: false, status: response.status, contentType, bytes: actualBytes, error: 'stored-file-too-small' };
    }
    if (!/video|octet-stream/i.test(contentType)) {
      return { ok: false, status: response.status, contentType, bytes: actualBytes || bytes, error: 'stored-file-is-not-video' };
    }

    return { ok: true, status: response.status, contentType, bytes: actualBytes || bytes };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function persistVideo({ jobId, videoUrl, apiKey }) {
  if (!videoUrl) {
    return { ok: false, videoUrl, error: 'No video URL found yet' };
  }

  if (isStatusEndpointUrl(videoUrl)) {
    return { ok: false, videoUrl, error: 'OpenRouter status URL is not a downloadable video yet' };
  }

  if (isSupabasePublicUrl(videoUrl)) {
    const publicCheck = await verifyPublicObject(videoUrl);
    return publicCheck.ok
      ? { ok: true, videoUrl, skipped: true, reason: 'already-persistent', publicCheck }
      : { ok: false, videoUrl, error: 'Existing public URL is not readable as video', publicCheck };
  }

  const db = dbClient();
  if (!db) return { ok: false, videoUrl, error: 'Missing Supabase key' };

  const headers = isOpenRouterUrl(videoUrl) ? { Authorization: `Bearer ${apiKey}` } : {};
  const upstream = await fetch(videoUrl, { method: 'GET', headers });
  const contentType = upstream.headers.get('content-type') || '';

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return { ok: false, videoUrl, error: `Video download failed: ${upstream.status}`, contentType, details: text.slice(0, 500) };
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length < 1024 || !/video|octet-stream/i.test(contentType)) {
    return { ok: false, videoUrl, error: 'Downloaded file is not a valid video', contentType, bytes: buffer.length, preview: buffer.toString('utf8', 0, Math.min(buffer.length, 300)) };
  }

  const ext = extFromContentType(contentType);
  const safeJobId = String(jobId || Date.now()).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  const path = `generated-videos/${safeJobId}.${ext}`;

  const upload = await db.storage.from(VIDEO_BUCKET).upload(path, buffer, { contentType, cacheControl: '31536000', upsert: true });
  if (upload.error) return { ok: false, videoUrl, error: upload.error.message, bucket: VIDEO_BUCKET, path };

  const { data } = db.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  const publicUrl = data?.publicUrl || videoUrl;
  const publicCheck = await verifyPublicObject(publicUrl);
  if (!publicCheck.ok) return { ok: false, videoUrl: publicUrl, originalUrl: videoUrl, error: 'Uploaded object is not publicly readable as video', bucket: VIDEO_BUCKET, path, publicCheck };

  let historySave = { ok: true };
  try {
    const { error } = await db.from(HISTORY_TABLE).upsert(
      { job_id: jobId, status: 'completed', video_url: publicUrl, updated_at: new Date().toISOString() },
      { onConflict: 'job_id' }
    );
    if (error) historySave = { ok: false, error: error.message };
  } catch (error) {
    historySave = { ok: false, error: error?.message || String(error) };
  }

  return { ok: true, videoUrl: publicUrl, originalUrl: videoUrl, bucket: VIDEO_BUCKET, path, contentType, bytes: buffer.length, publicCheck, historySave };
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });

  const jobId = String(req.query.id || req.query.jobId || '').trim();
  const pollingUrl = String(req.query.pollingUrl || req.query.polling_url || '').trim();

  if (!jobId && !pollingUrl) {
    return res.status(400).json({
      ok: false,
      error: 'id or pollingUrl query parameter is required',
      example: '/api/seedance-status?id=video_job_id&pollingUrl=https://...'
    });
  }

  const statusUrl = pollingUrl || `${OPENROUTER_VIDEO_ENDPOINT}/${encodeURIComponent(jobId)}`;

  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowvid-studio.vercel.app',
        'X-Title': 'FlowVid Studio'
      }
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

    const jobStatus = normalizeStatus(data);
    const rawVideoUrl = findVideoUrl(data);
    const resolvedJobId = effectiveJobId({ jobId, pollingUrl, rawVideoUrl });
    let videoUrl = null;
    let storage = null;

    if (rawVideoUrl) {
      storage = await persistVideo({ jobId: resolvedJobId, videoUrl: rawVideoUrl, apiKey });
      if (storage?.ok && storage.videoUrl) videoUrl = storage.videoUrl;
    }

    const done = Boolean(videoUrl);

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      status: response.status,
      provider: 'openrouter',
      jobId: resolvedJobId,
      originalJobId: jobId,
      pollingUrl,
      statusUrl,
      jobStatus,
      done,
      videoUrl,
      storage: storage ? { ...storage, rawVideoUrl } : null,
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', statusUrl, checkedAt: new Date().toISOString() });
  }
};