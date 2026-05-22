module.exports = async function handler(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  const jobId = String(req.query.id || '').trim();

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: 'Missing OPENROUTER_API_KEY'
    });
  }

  if (!jobId) {
    return res.status(400).json({
      ok: false,
      error: 'id required'
    });
  }

  try {
    const response = await fetch(
      `https://openrouter.ai/api/v1/videos/${encodeURIComponent(jobId)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`
        }
      }
    );

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    return res.status(200).json({
      statusCode: response.status,
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
};
