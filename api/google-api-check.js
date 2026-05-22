module.exports = async function handler(req, res) {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  const videoProvider = process.env.VIDEO_PROVIDER || '';

  if (!googleApiKey) {
    return res.status(500).json({ ok: false, googleApiConnected: false, error: 'Missing GOOGLE_API_KEY', checkedAt: new Date().toISOString() });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(googleApiKey)}`);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

    const models = Array.isArray(data?.models) ? data.models : [];
    const videoRelatedModels = models
      .filter((model) => /veo|video/i.test(model.name || ''))
      .map((model) => ({ name: model.name, displayName: model.displayName || null, supportedGenerationMethods: model.supportedGenerationMethods || [] }));

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      status: response.status,
      googleApiConnected: response.ok,
      videoProvider,
      modelCount: models.length,
      videoRelatedModels,
      error: response.ok ? null : data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, googleApiConnected: false, error: error?.message || 'Unknown error', checkedAt: new Date().toISOString() });
  }
};
