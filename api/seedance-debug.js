const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';

function findUrls(value, path = '', out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.push({ path, url: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findUrls(item, `${path}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    Object.keys(value).forEach((key) => findUrls(value[key], path ? `${path}.${key}` : key, out));
  }
  return out;
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });

  const jobId = String(req.query.id || req.query.jobId || '').trim();
  const pollingUrl = String(req.query.pollingUrl || req.query.polling_url || '').trim();
  if (!jobId && !pollingUrl) {
    return res.status(400).json({ ok: false, error: 'id or pollingUrl is required' });
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

    const urls = findUrls(data).map((item) => ({
      path: item.path,
      url: item.url,
      isStatusUrl: /^https?:\/\/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(item.url),
      looksLikeVideoFile: /\.(mp4|mov|webm)(\?|$)/i.test(item.url),
      looksDownloadable: /(download|output|storage|cdn|signed|play|file|asset)/i.test(item.url)
    }));

    return res.status(200).json({
      ok: response.ok,
      status: response.status,
      statusUrl,
      urls,
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || String(error), statusUrl });
  }
};
