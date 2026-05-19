export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/veo-start',
      method: 'POST',
      note: 'Send a POST request to start a Veo generation. Opening this page in a browser will not consume credits.',
      exampleBody: {
        prompt: 'A cinematic shot of a small robot walking through a neon city at night.',
        model: 'models/veo-3.0-fast-generate-001',
        aspectRatio: '9:16'
      }
    });
  }

  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  if (!googleApiKey) {
    return res.status(500).json({ ok: false, error: 'Missing GOOGLE_API_KEY' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const prompt = String(body.prompt || '').trim();
    const model = String(body.model || 'models/veo-3.0-fast-generate-001').trim();
    const aspectRatio = String(body.aspectRatio || '9:16').trim();
    const personGeneration = String(body.personGeneration || 'allow_adult').trim();

    if (!prompt) {
      return res.status(400).json({ ok: false, error: 'prompt is required' });
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${model}:predictLongRunning?key=${encodeURIComponent(googleApiKey)}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [
          {
            prompt
          }
        ],
        parameters: {
          aspectRatio,
          personGeneration
        }
      })
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      status: response.status,
      model,
      provider: 'veo',
      operationName: data?.name || null,
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unknown error',
      checkedAt: new Date().toISOString()
    });
  }
}
