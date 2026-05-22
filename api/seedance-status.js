const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';

function findVideoUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value) && /\.(mp4|mov|webm)(\?|$)/i.test(value)) return value;
    if (/^https?:\/\//i.test(value) && /(video|output|download|storage|cdn)/i.test(value)) return value;
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const priorityKeys = [
      'videoUrl', 'video_url', 'output_url', 'download_url', 'url', 'uri',
      'file_url', 'asset_url', 'signed_url', 'play_url'
    ];
    for (const key of priorityKeys) {
      const found = findVideoUrl(value[key]);
      if (found) return found;
    }
    for (const key of Object.keys(value)) {
      const found = findVideoUrl(value[key]);
      if (found) return found;
    }
  }
  return null;
}

function normalizeStatus(data) {
  return String(
    data?.status ||
    data?.data?.status ||
    data?.response?.status ||
    data?.result?.status ||
    ''
  ).toLowerCase();
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });

  const jobId = String(req.query.id || req.query.jobId || '').trim();
  if (!jobId) {
    return res.status(400).json({ ok: false, error: 'id query parameter is required', example: '/api/seedance-status?id=video_job_id' });
  }

  try {
    const response = await fetch(`${OPENROUTER_VIDEO_ENDPOINT}/${encodeURIComponent(jobId)}`, {
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
    const videoUrl = findVideoUrl(data);
    const done = Boolean(videoUrl) || ['completed', 'succeeded', 'success', 'done'].includes(jobStatus);

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      status: response.status,
      provider: 'openrouter',
      jobId,
      jobStatus,
      done,
      videoUrl,
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', checkedAt: new Date().toISOString() });
  }
};