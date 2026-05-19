export default async function handler(req, res) {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  if (!googleApiKey) {
    return res.status(500).json({
      ok: false,
      omniAvailable: false,
      error: 'Missing GOOGLE_API_KEY',
      checkedAt: new Date().toISOString()
    });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(googleApiKey)}`);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }

    const models = Array.isArray(data?.models) ? data.models : [];
    const omniModels = models
      .filter((model) => /omni/i.test(`${model.name || ''} ${model.displayName || ''} ${model.description || ''}`))
      .map((model) => ({
        name: model.name || null,
        displayName: model.displayName || null,
        description: model.description || null,
        supportedGenerationMethods: model.supportedGenerationMethods || []
      }));

    const videoModels = models
      .filter((model) => /veo|video/i.test(`${model.name || ''} ${model.displayName || ''} ${model.description || ''}`))
      .map((model) => ({
        name: model.name || null,
        displayName: model.displayName || null,
        supportedGenerationMethods: model.supportedGenerationMethods || []
      }));

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      status: response.status,
      omniAvailable: response.ok && omniModels.length > 0,
      omniModelCount: omniModels.length,
      omniModels,
      currentVideoModelCount: videoModels.length,
      currentVideoModels: videoModels,
      nextAction: omniModels.length > 0
        ? 'Omni appears in this API key model list. Review supportedGenerationMethods and add provider routing.'
        : 'Omni is not visible for this API key yet. Keep using Veo and check again later.',
      error: response.ok ? null : data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      omniAvailable: false,
      error: error?.message || 'Unknown error',
      checkedAt: new Date().toISOString()
    });
  }
}
