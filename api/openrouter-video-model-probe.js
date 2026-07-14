const OPENROUTER_VIDEO_MODELS_URL = 'https://openrouter.ai/api/v1/videos/models';

function isTargetModel(model) {
  const id = String(model?.id || model?.slug || model?.model || '').toLowerCase();
  const name = String(model?.name || '').toLowerCase();
  const text = `${id} ${name}`;
  return (
    text.includes('kling-v3.0-pro') ||
    text.includes('sora-2-pro') ||
    (text.includes('grok') && text.includes('imagine') && text.includes('video'))
  );
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'missing_openrouter_api_key' });
  }

  try {
    const upstream = await fetch(OPENROUTER_VIDEO_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'HTTP-Referer': 'https://flowvid-studio.vercel.app',
        'X-Title': 'FlowVid Studio metadata probe'
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        error: 'openrouter_models_request_failed',
        upstreamStatus: upstream.status
      });
    }

    const payload = await upstream.json();
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : [];

    const models = rows.filter(isTargetModel);

    return res.status(200).json({
      ok: true,
      endpoint: OPENROUTER_VIDEO_MODELS_URL,
      matchedCount: models.length,
      models
    });
  } catch (_) {
    return res.status(502).json({ ok: false, error: 'openrouter_models_request_failed' });
  }
};
