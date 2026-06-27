const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WATERMARK_SERVER_URL = process.env.WATERMARK_SERVER_URL || '';
const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function bearerToken(req) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

async function getUserFromToken(token) {
  if (!token) return null;
  const db = serviceClient();
  if (!db) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch (_) { return null; }
}

function isSupabasePublicUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && String(url || '').includes('/storage/v1/object/public/');
}

function validVideoUrl(url) {
  const s = String(url || '').trim();
  if (!/^https:\/\//i.test(s)) return '';
  if (/\.(mp4|mov|webm)(\?|$)/i.test(s)) return s;
  if (/\/storage\/v1\/object\/public\//i.test(s)) return s;
  return '';
}

async function applyWatermark(db, task, videoUrl) {
  if (!WATERMARK_SERVER_URL) return videoUrl;
  try {
    const { data: profile } = await db.from('profiles')
      .select('plan').eq('id', task.user_id).maybeSingle();
    const plan = String(profile?.plan || 'free').toLowerCase();
    const isFreeUser = !['paid', 'pro', 'premium', 'business', 'creator', 'ultimate'].includes(plan);
    if (!isFreeUser) return videoUrl;

    const wmRes = await fetch(`${WATERMARK_SERVER_URL}/watermark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl, userId: task.user_id })
    });
    if (!wmRes.ok) return videoUrl;
    const wmData = await wmRes.json().catch(() => null);
    const wmUrl = validVideoUrl(wmData?.watermarkedUrl || '');
    if (!wmUrl) return videoUrl;

    await db.from('generation_tasks')
      .update({ watermarked_url: wmUrl, updated_at: new Date().toISOString() })
      .eq('id', task.id);
    return wmUrl;
  } catch (_) { return videoUrl; }
}

// Download a fal CDN video URL and upload to Supabase Storage.
async function downloadAndUpload(db, videoUrl, taskId) {
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    return { ok: false, error: 'invalid video URL' };
  }

  let videoBuffer, contentType;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const dlRes = await fetch(videoUrl, { signal: controller.signal, headers: { 'User-Agent': 'flowvid-studio/1.0' } });
      if (!dlRes.ok) return { ok: false, error: `video download HTTP ${dlRes.status}` };
      contentType = dlRes.headers.get('content-type') || 'video/mp4';
      videoBuffer = Buffer.from(await dlRes.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    return { ok: false, error: `video download failed: ${e?.message}` };
  }

  if (!videoBuffer || videoBuffer.length < 1000) {
    return { ok: false, error: `video file too small: ${videoBuffer?.length ?? 0} bytes` };
  }

  const safeId = String(taskId || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80);
  const path = `fal-videos/${safeId}.mp4`;
  const upload = await db.storage.from(VIDEO_BUCKET).upload(path, videoBuffer, {
    contentType, cacheControl: '31536000', upsert: true
  });
  if (upload.error) return { ok: false, error: `Supabase upload: ${upload.error.message}` };

  const { data: urlData } = db.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  const publicUrl = urlData?.publicUrl || '';
  if (!publicUrl) return { ok: false, error: 'could not get public URL after upload' };

  return { ok: true, publicUrl, bytes: videoBuffer.length };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const taskId = String(req.query.taskId || '').trim();
  if (!taskId) return res.status(400).json({ ok: false, error: 'taskId is required' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  try {
    const { data: task, error } = await db.from('generation_tasks')
      .select('id,user_id,status,output_url,watermarked_url,polling_url,error_message,api_provider,api_task_id')
      .eq('id', taskId)
      .eq('user_id', user.id)
      .eq('api_provider', 'fal')
      .maybeSingle();

    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!task) return res.status(404).json({ ok: false, error: 'task_not_found' });

    if (task.status === 'completed') {
      if (task.watermarked_url && isSupabasePublicUrl(task.watermarked_url)) {
        return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl: task.watermarked_url, taskId });
      }
      if (task.output_url && isSupabasePublicUrl(task.output_url)) {
        const finalUrl = await applyWatermark(db, task, task.output_url);
        return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl: finalUrl, taskId });
      }
      // completed but no persistent URL yet — fall through to try polling_url
    }

    if (task.status === 'failed' || task.status === 'cancelled') {
      let refunded = false;
      try {
        const { data: txs } = await db.from('credit_transactions')
          .select('id').eq('related_task_id', taskId).eq('reason', 'generation_refund').limit(1);
        refunded = Boolean(txs && txs.length > 0);
      } catch (_) {}
      return res.status(200).json({
        ok: false, done: true, failed: true, status: task.status,
        message: '動画生成に失敗しました。', refunded, taskId
      });
    }

    // queued / processing: check if webhook has saved a fal CDN URL as polling_url
    if (task.polling_url && !isSupabasePublicUrl(task.polling_url)) {
      console.log('[fal-status] attempting download+upload from polling_url, taskId:', taskId);
      const uploadResult = await downloadAndUpload(db, task.polling_url, task.id);

      if (!uploadResult.ok) {
        console.warn('[fal-status] upload failed, will retry on next poll:', uploadResult.error, 'taskId:', taskId);
        return res.status(200).json({ ok: true, done: false, status: 'processing', taskId });
      }

      // Mark completed with the permanent Supabase URL and clear polling_url
      await db.from('generation_tasks')
        .update({
          status: 'completed',
          output_url: uploadResult.publicUrl,
          polling_url: null,
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('id', task.id);

      console.log('[fal-status] upload success, taskId:', taskId, 'bytes:', uploadResult.bytes);

      const finalUrl = await applyWatermark(db, { ...task, output_url: uploadResult.publicUrl }, uploadResult.publicUrl);
      return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl: finalUrl, taskId });
    }

    // queued / processing / expired — no polling_url yet
    return res.status(200).json({ ok: true, done: false, status: task.status || 'queued', taskId });
  } catch (err) {
    console.error('[fal-status] error:', err?.message, 'taskId:', taskId);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
