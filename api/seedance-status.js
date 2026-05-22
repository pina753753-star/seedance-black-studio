const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';

export default async function handler(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });
  }

  const jobId = String(req.query.id || req.query.jobId || '').trim();
  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: 'id query parameter is required',
      example: '/api/seedance-status?id=video_job_id'
    });
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

    const videoUrl = data?.output?.video_url || data?.video_url || data?.url || data?.output?.url || null;

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      status: response.status,
      provider: 'openrouter',
      jobId,
      jobStatus: data?.status || null,
      done: ['completed', 'succeeded', 'success', 'done'].includes(String(data?.status || '').toLowerCase()),
      videoUrl,
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', checkedAt: new Date().toISOString() });
  }
}
