const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const DEFAULT_MODEL = 'bytedance/seedance-2.0';

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function normalizeDuration(value) {
  const n = Number(value || 5);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(15, Math.round(n)));
}

function normalizeAspectRatio(value) {
  const ratio = String(value || '9:16').trim();
  return ['9:16', '16:9', '1:1', '4:3', '3:4'].includes(ratio) ? ratio : '9:16';
}

function normalizeResolution(value) {
  const resolution = String(value || '720p').trim();
  return ['480p', '720p', '1080p'].includes(resolution) ? resolution : '720p';
}

function imageObject(url, frameType) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) return null;
  const item = { type: 'image_url', image_url: { url: cleanUrl } };
  if (frameType) item.frame_type = frameType;
  return item;
}

function imageObjects(urls) {
  return (Array.isArray(urls) ? urls : []).map((url) => imageObject(url)).filter(Boolean);
}

function extractJobId(data) {
  return data?.id || data?.jobId || data?.data?.id || data?.response?.id || data?.request_id || null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/seedance-start',
      method: 'POST',
      provider: 'openrouter',
      model: DEFAULT_MODEL,
      note: 'POST only. Opening this page in a browser will not consume credits.',
      requiredEnv: 'OPENROUTER_API_KEY'
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });

  try {
    const body = jsonBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

    const payload = {
      model: String(body.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
      prompt,
      duration: normalizeDuration(body.duration || body.duration_seconds),
      resolution: normalizeResolution(body.resolution),
      aspect_ratio: normalizeAspectRatio(body.aspect_ratio || body.aspectRatio),
      generate_audio: Boolean(body.generate_audio || false)
    };

    const frameImages = Array.isArray(body.frame_images) ? body.frame_images : [];
    const inputReferences = Array.isArray(body.input_references) ? body.input_references : [];
    const firstFrameUrl = String(body.first_frame_url || '').trim();
    const referenceUrl = String(body.reference_url || '').trim();
    const referenceUrls = imageObjects(body.reference_urls || body.referenceUrls || []);

    if (frameImages.length) payload.frame_images = frameImages;
    else if (firstFrameUrl) payload.frame_images = [imageObject(firstFrameUrl, 'first_frame')].filter(Boolean);

    if (!payload.frame_images?.length) {
      if (inputReferences.length) payload.input_references = inputReferences;
      else if (referenceUrls.length) payload.input_references = referenceUrls;
      else if (referenceUrl) payload.input_references = [imageObject(referenceUrl)].filter(Boolean);
    }

    const response = await fetch(OPENROUTER_VIDEO_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowvid-studio.vercel.app',
        'X-Title': 'FlowVid Studio'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

    return res.status(response.ok ? 202 : response.status).json({
      ok: response.ok,
      status: response.status,
      provider: 'openrouter',
      model: payload.model,
      jobId: extractJobId(data),
      pollingUrl: data?.polling_url || data?.pollingUrl || null,
      jobStatus: data?.status || data?.data?.status || null,
      request: {
        duration: payload.duration,
        resolution: payload.resolution,
        aspect_ratio: payload.aspect_ratio,
        has_frame_images: Boolean(payload.frame_images?.length),
        frame_image_count: payload.frame_images?.length || 0,
        has_input_references: Boolean(payload.input_references?.length),
        input_reference_count: payload.input_references?.length || 0,
        text_only: !payload.frame_images?.length && !payload.input_references?.length
      },
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', checkedAt: new Date().toISOString() });
  }
};