const { createClient } = require('@supabase/supabase-js');

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function bearerToken(req) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  const bucket = process.env.SUPABASE_REFERENCE_BUCKET || 'reference-images';

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ ok: false, error: 'Missing Supabase environment variables' });
  }

  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const dataUrl = String(body.dataUrl || '');
    const filename = String(body.filename || `reference-${Date.now()}.jpg`);
    const requestedContentType = String(body.contentType || '').toLowerCase();

    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ ok: false, error: 'Invalid dataUrl' });
    }

    const dataUrlContentType = String(match[1] || '').toLowerCase();
    const contentType = requestedContentType || dataUrlContentType;
    if (!ALLOWED_MIME_TYPES.has(contentType) || dataUrlContentType !== contentType) {
      return res.status(415).json({ ok: false, error: 'Unsupported image type' });
    }

    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_FILE_BYTES) {
      return res.status(413).json({ ok: false, error: 'Image exceeds 10 MB limit' });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `seedance/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;

    const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
      contentType,
      upsert: false
    });

    if (error) {
      return res.status(500).json({ ok: false, error: error.message, bucket, path });
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    const publicUrl = data && data.publicUrl ? data.publicUrl : `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;

    return res.status(200).json({ ok: true, uploaded: true, publicUrl, url: publicUrl, path, bucket, size: buffer.length });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
