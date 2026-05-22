module.exports = async function handler(req, res) {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  if (!googleApiKey) {
    return res.status(500).json({ ok: false, error: 'Missing GOOGLE_API_KEY' });
  }

  const operationName = String(req.query.operation || req.query.name || '').trim();
  if (!operationName) {
    return res.status(400).json({
      ok: false,
      error: 'operation query parameter is required',
      example: '/api/veo-status?operation=operations/xxxx'
    });
  }

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${encodeURIComponent(googleApiKey)}`;
    const response = await fetch(endpoint, { method: 'GET' });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      status: response.status,
      operationName,
      done: Boolean(data && data.done),
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : 'Unknown error',
      checkedAt: new Date().toISOString()
    });
  }
};
