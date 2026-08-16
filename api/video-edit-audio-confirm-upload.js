const { createClient } = require('@supabase/supabase-js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { probeAudioBuffer } = require('./_lib/audio-probe.js');

// クライアントが署名付きURL経由でvideo-edit-audio-quarantine(非公開バケット)へ
// 直接アップロードを終えたあと、サーバー側で「本当にそのpathへ、想定どおりの
// 形式・サイズでオブジェクトが存在するか」に加え、ffprobeによる実体検証
// (音声ストリームを含む、実際にデコードできるファイルか)を行ってから、
// 公開バケット(video-edit-audio)へ移し公開URLを発行するエンドポイント。
// api/reference-image-confirm-upload.jsと同じ隔離バケット経由方式だが、
// OpenAI Moderationのようなコンテンツ内容検査は行わない(音声ファイルの
// 技術的な実体検証のみ)。
const ALLOWED_MIME_TYPES = new Set([
  'audio/mpeg'
]);
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB。video-edit-audio-upload-url.js・quarantineバケットのfile_size_limitと揃える
const QUARANTINE_BUCKET = 'video-edit-audio-quarantine';
const PUBLIC_BUCKET = 'video-edit-audio';
// 動画編集1本あたりの合計尺上限(watermark-server/server.jsのEDIT_MAX_TOTAL_DURATION_SEC=180秒)
// より十分大きく、かつ極端に長い(数時間の)ファイルの誤アップロードを弾ける値。
// 実際のミックス時は動画の長さに合わせて切り詰められる(段階1設計案参照)ため、
// ここでの上限はあくまで「常識的な範囲のBGM素材か」の粗い足切り。
const MAX_AUDIO_DURATION_SECONDS = 600; // 10分

// pathは常に "bgm/<userId>/..." の形式で、video-edit-audio-upload-url.jsが
// 発行したものだけを受け付ける。他ユーザーのpathを指定して不正に確認させることを防ぐ。
function pathBelongsToUser(path, userId) {
  const prefix = `bgm/${userId}/`;
  return typeof path === 'string' && path.startsWith(prefix) && path.length > prefix.length;
}

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

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const path = String(body.path || '');

  if (!pathBelongsToUser(path, auth.user.id)) {
    return res.status(400).json({ ok: false, error: 'INVALID_PATH' });
  }

  try {
    // 隔離バケットは非公開のため、サービスロールでの直接ダウンロードで
    // 「実在するか」「実際の形式・サイズは何か」を確認する。取得したバイト列は
    // そのまま実体検証・公開バケットへの移動にも使う。
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from(QUARANTINE_BUCKET)
      .download(path);

    if (downloadError || !fileBlob) {
      return res.status(404).json({
        ok: false,
        error: 'QUARANTINE_OBJECT_NOT_FOUND',
        message: 'アップロードされた音声ファイルが見つかりませんでした。'
      });
    }

    const buffer = Buffer.from(await fileBlob.arrayBuffer());
    const actualContentType = String(fileBlob.type || '').toLowerCase();

    // クライアントが署名付きURLへ直接PUTする際に申告した形式は、発行時点の
    // 期待値と異なる可能性があるため、実際にStorageへ書き込まれた形式を
    // ここで改めて検証する。
    if (!ALLOWED_MIME_TYPES.has(actualContentType)) {
      await supabase.storage.from(QUARANTINE_BUCKET).remove([path]).catch(() => {});
      return res.status(415).json({ ok: false, error: 'Unsupported audio type' });
    }

    if (buffer.length > MAX_FILE_BYTES) {
      await supabase.storage.from(QUARANTINE_BUCKET).remove([path]).catch(() => {});
      return res.status(413).json({ ok: false, error: 'Audio exceeds 15 MB limit' });
    }

    // ffprobeによる実体検証。MIMEタイプの自己申告だけでは、壊れたファイルや
    // 音声ストリームを含まないファイルを弾けないため、実際にデコードして
    // 音声ストリームの有無・長さを確認する。
    const probe = await probeAudioBuffer(buffer, { maxDurationSeconds: MAX_AUDIO_DURATION_SECONDS });
    if (!probe.ok) {
      await supabase.storage.from(QUARANTINE_BUCKET).remove([path]).catch(() => {});
      if (probe.reason === 'unreadable') {
        console.error('[video-edit-audio-confirm-upload] ffprobe failed:', probe.detail);
      }
      const message = probe.reason === 'duration_too_long'
        ? `BGMの長さが上限(${MAX_AUDIO_DURATION_SECONDS}秒)を超えています。`
        : '音声ファイルとして読み取れませんでした。別のファイルをお試しください。';
      return res.status(422).json({ ok: false, error: 'INVALID_AUDIO_FILE', reason: probe.reason, message });
    }

    const filename = path.split('/').pop() || `bgm-${Date.now()}.mp3`;
    const targetPath = `bgm/${Date.now()}-${Math.random().toString(36).slice(2)}-${filename}`;

    const { error: uploadError } = await supabase.storage
      .from(PUBLIC_BUCKET)
      .upload(targetPath, buffer, { contentType: actualContentType, upsert: false });

    if (uploadError) {
      return res.status(500).json({ ok: false, error: uploadError.message });
    }

    // 公開バケットへの複製が完了した後の隔離音声削除。失敗してもレスポンス
    // 自体は成功として返す(利用者への公開URL発行は既に完了しているため)が、
    // 削除失敗はログへ残す。
    const { error: cleanupError } = await supabase.storage.from(QUARANTINE_BUCKET).remove([path]);
    if (cleanupError) {
      console.error('Video edit audio quarantine cleanup failed after promotion', {
        bucket: QUARANTINE_BUCKET,
        path,
        message: cleanupError.message
      });
    }

    const { data: publicData } = supabase.storage.from(PUBLIC_BUCKET).getPublicUrl(targetPath);
    const publicUrl = publicData && publicData.publicUrl
      ? publicData.publicUrl
      : `${supabaseUrl}/storage/v1/object/public/${PUBLIC_BUCKET}/${targetPath}`;

    return res.status(200).json({
      ok: true,
      uploaded: true,
      publicUrl,
      url: publicUrl,
      path: targetPath,
      bucket: PUBLIC_BUCKET,
      size: buffer.length,
      duration: probe.duration
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
};
