const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { moderateContent } = require('./_lib/openai-moderation.js');
const { resolveReferenceImageModerationDecision } = require('./_lib/reference-image-moderation-decision.js');

// クライアントが署名付きURL経由でreference-image-quarantine(非公開バケット)へ
// 直接アップロードを終えたあと、サーバー側で「本当にそのpathへ、想定どおりの
// 形式・サイズでオブジェクトが存在するか」を再検証してから、公開バケット
// (reference-images)へ移し公開URLを発行するエンドポイント。
//
// 2026-08-14: OpenAI Moderation(動画生成時と同じapi/_lib/openai-moderation.js)
// による画像内容検査を追加した。判定基準は動画生成時(api/_lib/seedance-start.js →
// api/_lib/moderation-decision.js)とは別物で、二次判定(fictional-action-classifier.js)
// は一切経由せず、`sexual/minors`カテゴリのみを厳格にブロックする
// (api/_lib/reference-image-moderation-decision.js参照)。CSAM既知ハッシュ照合
// (Thorn Safer Match/PhotoDNA等)や正確な年齢確認、実在人物・有名人検知は
// 引き続き未実装(docs/operations/REFERENCE-IMAGE-SAFETY-DESIGN.md参照)。
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB。reference-image-upload-url.js・quarantineバケットのfile_size_limitと揃える
const QUARANTINE_BUCKET = 'reference-image-quarantine';
// OpenAI Moderationが隔離バケットの非公開オブジェクトを取得するための
// 一時的な署名付きURLの有効期限。OpenAI側のフェッチは通常数秒で完了するため、
// 十分な余裕を持たせつつ、不要に長く公開されたままにならない値にしている。
const MODERATION_SIGNED_URL_TTL_SECONDS = 60;

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

  // 2026-08-14: TEST_BYPASS_USER_ID限定のベータ提供を解除
  // (api/upload-reference-image.js参照)。sexual/minors検査(下記)は維持。

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

    // OpenAI Moderationによる画像内容検査。判定にはhttps URLが必要なため、
    // 非公開の隔離バケットに対して短時間だけ有効な署名付きURLを発行する
    // (既に取得済みのbufferは、この後の公開バケットへの複製にのみ使う)。
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from(QUARANTINE_BUCKET)
      .createSignedUrl(path, MODERATION_SIGNED_URL_TTL_SECONDS);

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error('[reference-image-confirm-upload] failed to create signed URL for moderation:', signedUrlError?.message);
      // 検査用URLを発行できず安全確認自体ができないため、フェイルクローズ
      // (公開バケットへは進めない)。隔離画像は削除せず残し、再試行で
      // 再検証できるようにする。
      return res.status(503).json({
        ok: false,
        error: 'REFERENCE_IMAGE_SAFETY_UNAVAILABLE',
        message: '安全確認を完了できないため、処理を停止しました。'
      });
    }

    const moderation = await moderateContent('', [signedUrlData.signedUrl]);
    const moderationDecision = resolveReferenceImageModerationDecision(moderation);

    if (!moderationDecision.ok) {
      console.error(
        '[reference-image-confirm-upload] content safety decision unavailable:',
        moderationDecision.reason
      );
      return res.status(503).json({
        ok: false,
        error: 'REFERENCE_IMAGE_SAFETY_UNAVAILABLE',
        message: '安全確認を完了できないため、処理を停止しました。'
      });
    }

    if (!moderationDecision.allow) {
      console.warn(
        '[reference-image-confirm-upload] content safety blocked reference image;',
        'categories:', moderation.categories || [],
        'matched:', moderationDecision.matchedCategories || []
      );

      await supabase.storage.from(QUARANTINE_BUCKET).remove([path]).catch(() => {});

      // admin.html可視化のためのベストエフォート記録
      // (api/_lib/seedance-start.jsのmoderation_blocks記録と同じテーブル・
      // 同じ「失敗してもレスポンスは変えない」方針)。プロンプトが存在しない
      // 画像単体のブロックのため、promptは空文字とし、追跡用の情報
      // (バケット・path・サイズ・一致カテゴリ)はclassification列(jsonb)に入れる。
      try {
        const { error: logInsertError } = await supabase.from('moderation_blocks').insert({
          user_id: auth.user.id,
          mode: 'reference_image_upload',
          categories: moderation.categories || [],
          reason: moderationDecision.reason,
          classification: {
            bucket: QUARANTINE_BUCKET,
            path,
            contentType: actualContentType,
            size: buffer.length,
            matchedCategories: moderationDecision.matchedCategories || []
          },
          prompt: ''
        });
        if (logInsertError) {
          console.error('[reference-image-confirm-upload] failed to record moderation_blocks row:', logInsertError.message);
        }
      } catch (logError) {
        console.error('[reference-image-confirm-upload] failed to record moderation_blocks row:', logError?.message || logError);
      }

      return res.status(422).json({
        ok: false,
        error: 'REFERENCE_IMAGE_REJECTED',
        message: '参照画像は安全確認に合格しませんでした。'
      });
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
