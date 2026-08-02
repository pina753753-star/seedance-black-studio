const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const QUARANTINE_BUCKET = 'reference-image-quarantine';

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

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  const testBypassUserId = String(process.env.TEST_BYPASS_USER_ID || '').trim();
  const isApprovedTestUser = Boolean(
    testBypassUserId &&
    auth.user &&
    auth.user.id === testBypassUserId
  );

  if (!isApprovedTestUser) {
    return res.status(503).json({
      ok: false,
      error: 'REFERENCE_IMAGE_UPLOAD_DISABLED',
      message: '参照画像機能は安全確認中のため、現在利用できません。'
    });
  }

  const supabase = auth.supabase || createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const dataUrl = String(body.dataUrl || '');
    const filename = String(body.filename || `reference-${Date.now()}.jpg`);
    const requestedContentType = String(body.contentType || '').toLowerCase();
    const quarantineOnly = body.quarantineOnly === true;

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
    const pathPrefix = quarantineOnly ? `verification/${auth.user.id}` : 'seedance';
    const path = `${pathPrefix}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;
    const targetBucket = quarantineOnly ? QUARANTINE_BUCKET : bucket;

    const { error } = await supabase.storage.from(targetBucket).upload(path, buffer, {
      contentType,
      upsert: false
    });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: quarantineOnly ? 'QUARANTINE_UPLOAD_FAILED' : error.message,
        bucket: targetBucket,
        path
      });
    }

    if (quarantineOnly) {
      const { error: deleteError } = await supabase.storage.from(QUARANTINE_BUCKET).remove([path]);

      if (deleteError) {
        console.error('Reference image quarantine cleanup failed', {
          bucket: QUARANTINE_BUCKET,
          path,
          message: deleteError.message
        });
        return res.status(500).json({
          ok: false,
          error: 'QUARANTINE_DELETE_FAILED',
          message: '隔離画像の削除を確認できませんでした。'
        });
      }

      return res.status(200).json({
        ok: true,
        quarantineVerified: true,
        deleted: true,
        publicUrlIssued: false,
        size: buffer.length
      });
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    const publicUrl = data && data.publicUrl ? data.publicUrl : `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;

    return res.status(200).json({ ok: true, uploaded: true, publicUrl, url: publicUrl, path, bucket, size: buffer.length });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
