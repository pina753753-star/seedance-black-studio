const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const ALLOWED_MOCK_SAFETY_DECISIONS = new Set([
  'pass',
  'reject',
  'error',
  'cleanup_error'
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

  // 2026-08-14: TEST_BYPASS_USER_ID限定のベータ提供を解除。URLを直接共有した
  // 相手だけが使うという制限は運用上の判断であり、コード側では行わない。
  // sexual/minors検査(api/reference-image-confirm-upload.js)は維持しているが、
  // CSAM既知ハッシュ照合等の専用検知は引き続き未実装
  // (docs/operations/REFERENCE-IMAGE-SAFETY-DESIGN.md参照)。

  const supabase = auth.supabase || createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const dataUrl = String(body.dataUrl || '');
    const filename = String(body.filename || `reference-${Date.now()}.jpg`);
    const requestedContentType = String(body.contentType || '').toLowerCase();
    const quarantineOnly = body.quarantineOnly === true;
    const mockSafetyDecision = quarantineOnly
      ? String(body.mockSafetyDecision || 'pass').trim().toLowerCase()
      : '';

    if (quarantineOnly && !ALLOWED_MOCK_SAFETY_DECISIONS.has(mockSafetyDecision)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_MOCK_SAFETY_DECISION'
      });
    }

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

      if (mockSafetyDecision === 'cleanup_error') {
        return res.status(500).json({
          ok: false,
          error: 'QUARANTINE_DELETE_FAILED',
          simulated: true,
          deleted: true,
          publicUrlIssued: false,
          message: '隔離画像の削除失敗を安全に模擬しました。'
        });
      }

      if (mockSafetyDecision === 'reject') {
        return res.status(422).json({
          ok: false,
          error: 'REFERENCE_IMAGE_REJECTED',
          deleted: true,
          publicUrlIssued: false,
          message: '参照画像は安全確認に合格しませんでした。'
        });
      }

      if (mockSafetyDecision === 'error') {
        return res.status(503).json({
          ok: false,
          error: 'REFERENCE_IMAGE_SAFETY_UNAVAILABLE',
          deleted: true,
          publicUrlIssued: false,
          message: '安全確認を完了できないため、処理を停止しました。'
        });
      }

      return res.status(200).json({
        ok: true,
        quarantineVerified: true,
        safetyDecision: 'pass',
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
