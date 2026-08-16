const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

// 動画編集のBGM機能用。クライアントからブラウザ経由でSupabase Storageへ
// 直接アップロードするための署名付きアップロードURLを発行するエンドポイント。
// api/reference-image-upload-url.jsと同じ設計(base64本体をサーバーの
// リクエストボディに通さず、Vercelサーバーレス関数の本文サイズ上限を経由しない)。
//
// 発行した署名URLは常に非公開の隔離バケット(video-edit-audio-quarantine)を
// 対象とする。実体検証(ffprobe、api/video-edit-audio-confirm-upload.js)前に
// 公開バケットへ直接アップロードさせないため。
const ALLOWED_MIME_TYPES = new Set([
  'audio/mpeg' // mp3のみ。他形式は段階3以降で検討。
]);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB。confirm-upload側・quarantineバケットのfile_size_limitと揃える
const QUARANTINE_BUCKET = 'video-edit-audio-quarantine';

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

  const supabase = auth.supabase || createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false }
  });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const filename = String(body.filename || `bgm-${Date.now()}.mp3`);
    const contentType = String(body.contentType || '').toLowerCase();
    const byteSize = Number(body.byteSize || 0);

    if (!ALLOWED_MIME_TYPES.has(contentType)) {
      return res.status(415).json({ ok: false, error: 'Unsupported audio type' });
    }

    // クライアント申告のサイズはあくまで事前の親切チェック。実際の上限は
    // Storageバケット側のfile_size_limitと、アップロード完了確認時の
    // 再検証(api/video-edit-audio-confirm-upload.js)で強制する。
    if (byteSize > 0 && byteSize > MAX_FILE_BYTES) {
      return res.status(413).json({ ok: false, error: 'Audio exceeds 15 MB limit' });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `bgm/${auth.user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}-${safeName}`;

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
