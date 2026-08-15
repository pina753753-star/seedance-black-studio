const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

// クライアントからブラウザ経由でSupabase Storageへ直接アップロードするための
// 署名付きアップロードURLを発行するエンドポイント。base64本体はサーバーの
// リクエストボディを通らないため、Vercelサーバーレス関数の本文サイズ上限
// (既定 約4.5MB)を経由しない。
//
// 発行した署名URLは常に非公開の隔離バケット(reference-image-quarantine)を
// 対象とする。安全確認前に公開バケットへ直接アップロードさせないため
// (docs/operations/REFERENCE-IMAGE-SAFETY-DESIGN.md §7-8参照)。
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB。confirm-upload側・quarantineバケットのfile_size_limitと揃える
const QUARANTINE_BUCKET = 'reference-image-quarantine';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ ok: false, error: 'Missing Supabase environment variables' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  // 2026-08-14: TEST_BYPASS_USER_ID限定のベータ提供を解除
  // (api/upload-reference-image.js参照)。

  const supabase = auth.supabase || createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const filename = String(body.filename || `reference-${Date.now()}.jpg`);
    const contentType = String(body.contentType || '').toLowerCase();
    const byteSize = Number(body.byteSize || 0);

    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      return res.status(415).json({ ok: false, error: 'Unsupported image type' });
    }

    // クライアント申告のサイズはあくまで事前の親切チェック。実際の上限は
    // Storageバケット側のfile_size_limitと、アップロード完了確認時の
    // 再検証(api/reference-image-confirm-upload.js)で強制する。
    if (byteSize > 0 && byteSize > MAX_FILE_BYTES) {
      return res.status(413).json({ ok: false, error: 'Image exceeds 20 MB limit' });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `verification/${auth.user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;

    const { data, error } = await supabase.storage
      .from(QUARANTINE_BUCKET)
      .createSignedUploadUrl(path);

    if (error || !data) {
      return res.status(500).json({
        ok: false,
        error: error ? error.message : 'SIGNED_URL_ISSUE_FAILED'
      });
    }

    return res.status(200).json({
      ok: true,
      bucket: QUARANTINE_BUCKET,
      path: data.path || path,
      token: data.token,
      signedUrl: data.signedUrl,
      maxBytes: MAX_FILE_BYTES
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
