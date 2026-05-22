async function ensureBucket(supabaseUrl, serviceRoleKey, bucket) {
  const create = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ id: bucket, name: bucket, public: true, file_size_limit: 8388608, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] })
  });
  if (create.ok || create.status === 409 || create.status === 400) return;
  const text = await create.text();
  throw new Error(text || 'Failed to ensure storage bucket');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, endpoint: '/api/upload-reference-image', method: 'POST' });
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceRoleKey = process.env['SUPABASE_' + 'SERVICE_ROLE_KEY'] || '';
  const bucket = process.env.REFERENCE_IMAGE_BUCKET || 'reference-images';

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ ok: false, error: 'Missing Supabase environment variables' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const dataUrl = String(body.dataUrl || body.data_url || '').trim();
    const filename = String(body.filename || 'reference.jpg').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'reference.jpg';
    const contentType = String(body.contentType || body.content_type || 'image/jpeg').trim();

    if (!dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ ok: false, error: 'dataUrl image is required' });
    }

    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) return res.status(400).json({ ok: false, error: 'Invalid dataUrl' });

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ ok: false, error: 'Empty image' });
    if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'Image is too large. Max 8MB.' });

    await ensureBucket(supabaseUrl, serviceRoleKey, bucket);

    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const path = `seedance/${Date.now()}-${Math.random().toString(36).slice(2)}-${filename.replace(/\.[^.]+$/, '')}.${ext}`;
    const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${path}`;

    const upload = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
      body: buffer
    });

    const uploadText = await upload.text();
    let uploadData = null;
    try { uploadData = uploadText ? JSON.parse(uploadText) : null; } catch (_) { uploadData = uploadText; }

    if (!upload.ok) {
      return res.status(upload.status).json({ ok: false, error: 'Supabase upload failed', details: uploadData });
    }

    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
    return res.status(200).json({ ok: true, bucket, path, publicUrl, contentType, size: buffer.length, checkedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', checkedAt: new Date().toISOString() });
  }
};
