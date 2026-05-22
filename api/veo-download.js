function safeFilename(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\\/\r\n\t\0]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 96);
  return cleaned || fallback;
}

function wantsDownload(value) {
  return ['1', 'true', 'yes', 'attachment', 'download'].includes(String(value || '').toLowerCase());
}

module.exports = async function handler(req, res) {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  if (!googleApiKey) return res.status(500).json({ ok: false, error: 'Missing GOOGLE_API_KEY' });

  const rawUri = String(req.query.uri || '').trim();
  if (!rawUri) return res.status(400).json({ ok: false, error: 'uri query parameter is required' });

  let url;
  try { url = new URL(rawUri); } catch (_) { return res.status(400).json({ ok: false, error: 'Invalid uri' }); }

  if (url.hostname !== 'generativelanguage.googleapis.com') {
    return res.status(400).json({ ok: false, error: 'Unsupported video host' });
  }

  if (!url.searchParams.has('key')) url.searchParams.set('key', googleApiKey);

  const download = wantsDownload(req.query.download);
  const rawVariant = String(req.query.variant || req.query.watermark || '').toLowerCase();
  const variant = rawVariant.includes('clean') || rawVariant.includes('none') || rawVariant === '0' ? 'clean' : 'watermark';
  const filename = safeFilename(req.query.filename, `flowvid-${variant}.mp4`);

  try {
    const upstream = await fetch(url.toString(), { method: 'GET' });
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({ ok: false, status: upstream.status, error: text });
    }

    const contentType = upstream.headers.get('content-type') || 'video/mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
    res.setHeader('X-FlowVid-Download-Variant', variant);

    const arrayBuffer = await upstream.arrayBuffer();
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error' });
  }
};
