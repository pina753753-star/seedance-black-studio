const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

// クライアントが署名付きURL経由でreference-image-quarantine(非公開バケット)へ
// 直接アップロードを終えたあと、サーバー側で「本当にそのpathへ、想定どおりの
// 形式・サイズでオブジェクトが存在するか」を再検証してから、公開バケット
// (reference-images)へ移し公開URLを発行するエンドポイント。
//
// 現時点では実際のコンテンツ安全検知(CSAMハッシュ照合・年齢判定・実在人物検知等)
// は未実装(docs/operations/REFERENCE-IMAGE-SAFETY-DESIGN.md参照)。このエンドポイントは
// 既存api/upload-reference-image.jsと同等の検証範囲(形式・サイズ・テストユーザー限定)
// のみを行い、隔離バケットを経由する経路を用意する段階に留める。
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB。reference-image-upload-url.js・quarantineバケットのfile_size_limitと揃える
const QUARANTINE_BUCKET = 'reference-image-quarantine';

// pathは常に "verification/<userId>/..." の形式で、reference-image-upload-url.js
// が発行したものだけを受け付ける。他ユーザーのpathを指定して不正に確認させることを防ぐ。
function pathBelongsToUser(path, userId) {
  const prefix = `verification/${userId}/`;
  return typeof path === 'string' && path.startsWith(prefix) && path.length > prefix.length;
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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const path = String(body.path || '');

  if (!pathBelongsToUser(path, auth.user.id)) {
    return res.status(400).json({ ok: false, error: 'INVALID_PATH' });
  }

  try {
    // 隔離バケットは非公開のため、サービスロールでの直接ダウンロードで
    // 「実在するか」「実際の形式・サイズは何か」を確認する。取得したバイト列は
    // そのまま公開バケットへの移動にも使う。
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from(QUARANTINE_BUCKET)
      .download(path);

    if (downloadError || !fileBlob) {
      return res.status(404).json({
        ok: false,
        error: 'QUARANTINE_OBJECT_NOT_FOUND',
        message: 'アップロードされた画像が見つかりませんでした。'
      });
    }

    const buffer = Buffer.from(await fileBlob.arrayBuffer());
    const actualContentType = String(fileBlob.type || '').toLowerCase();

    // クライアントが署名付きURLへ直接PUTする際に申告した形式は、発行時点の
    // 期待値と異なる可能性があるため、実際にStorageへ書き込まれた形式を
    // ここで改めて検証する。
    if (!ALLOWED_MIME_TYPES.has(actualContentType)) {
      await supabase.storage.from(QUARANTINE_BUCKET).remove([path]).catch(() => {});
      return res.status(415).json({ ok: false, error: 'Unsupported image type' });
    }

    if (buffer.length > MAX_FILE_BYTES) {
      await supabase.storage.from(QUARANTINE_BUCKET).remove([path]).catch(() => {});
      return res.status(413).json({ ok: false, error: 'Image exceeds 20 MB limit' });
    }

    const filename = path.split('/').pop() || `reference-${Date.now()}.jpg`;
    const targetPath = `seedance/${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`;

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(targetPath, buffer, { contentType: actualContentType, upsert: false });

    if (uploadError) {
      return res.status(500).json({ ok: false, error: uploadError.message });
    }

    // 公開バケットへの複製が完了した後の隔離画像削除。失敗してもレスポンス
    // 自体は成功として返す(利用者への公開URL発行は既に完了しているため)が、
    // 削除失敗はログへ残す。
    const { error: cleanupError } = await supabase.storage.from(QUARANTINE_BUCKET).remove([path]);
    if (cleanupError) {
      console.error('Reference image quarantine cleanup failed after promotion', {
        bucket: QUARANTINE_BUCKET,
        path,
        message: cleanupError.message
      });
    }

    const { data: publicData } = supabase.storage.from(bucket).getPublicUrl(targetPath);
    const publicUrl = publicData && publicData.publicUrl
      ? publicData.publicUrl
      : `${supabaseUrl}/storage/v1/object/public/${bucket}/${targetPath}`;

    return res.status(200).json({
      ok: true,
      uploaded: true,
      publicUrl,
      url: publicUrl,
      path: targetPath,
      bucket,
      size: buffer.length
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
