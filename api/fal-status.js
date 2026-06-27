const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WATERMARK_SERVER_URL = process.env.WATERMARK_SERVER_URL || '';

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
      .select('id,user_id,status,output_url,watermarked_url,error_message,api_provider,api_task_id')
      .eq('id', taskId)
      .eq('user_id', user.id)
      .eq('api_provider', 'fal')
      .maybeSingle();

    if (error) return res.status(500).json({ ok: false, error: error.message });
    if (!task) return res.status(404).json({ ok: false, error: 'task_not_found' });

    if (task.status === 'completed') {
      // Return watermarked URL if already set
      if (task.watermarked_url && isSupabasePublicUrl(task.watermarked_url)) {
        return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl: task.watermarked_url, taskId });
      }
      // Return output_url if it's a persistent Supabase URL
      if (task.output_url && isSupabasePublicUrl(task.output_url)) {
        // Apply watermark (best-effort, synchronous)
        const finalUrl = await applyWatermark(db, task, task.output_url);
        return res.status(200).json({ ok: true, done: true, status: 'completed', videoUrl: finalUrl, taskId });
      }
      // Completed but Webhook hasn't saved the video URL yet — treat as still processing
      return res.status(200).json({ ok: true, done: false, status: 'processing', taskId });
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

    // queued / processing / expired
    return res.status(200).json({ ok: true, done: false, status: task.status || 'queued', taskId });
  } catch (err) {
    console.error('[fal-status] error:', err?.message, 'taskId:', taskId);
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
