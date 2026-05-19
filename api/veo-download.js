export default async function handler(req, res) {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  if (!googleApiKey) {
    return res.status(500).json({ ok: false, error: 'Missing GOOGLE_API_KEY' });
  }

  const rawUri = String(req.query.uri || '').trim();
  if (!rawUri) {
    return res.status(400).json({ ok: false, error: 'uri query parameter is required' });
  }

  let url;
  try {
    url = new URL(rawUri);
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'Invalid uri' });
  }

  if (url.hostname !== 'generativelanguage.googleapis.com') {
    return res.status(400).json({ ok: false, error: 'Unsupported video host' });
  }

  if (!url.searchParams.has('key')) {
    url.searchParams.set('key', googleApiKey);
  }

  try {
    const upstream = await fetch(url.toString(), { method: 'GET' });
    if (!upstream.ok) {
      const text = await upstream.text();
      return res.status(upstream.status).json({
        ok: false,
        status: upstream.status,
        error: text
      });
    }

    const contentType = upstream.headers.get('content-type') || 'video/mp4';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', 'inline; filename="flowvid-veo-test.mp4"');

    const arrayBuffer = await upstream.arrayBuffer();
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'Unknown error'
    });
  }
}
