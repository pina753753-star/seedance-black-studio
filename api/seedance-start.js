const { createClient } = require('@supabase/supabase-js');

const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const DEFAULT_MODEL = 'bytedance/seedance-2.0';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Credit cost comes from the client's creditEstimate() display value.
// Server enforces a safe range to prevent manipulation.
const MIN_CREDITS = 50;
const MAX_CREDITS = 500;

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function normalizeDuration(value) {
  const n = Number(value || 5);
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(15, Math.round(n)));
}

function normalizeAspectRatio(value) {
  const ratio = String(value || '9:16').trim();
  return ['9:16', '16:9', '1:1', '4:3', '3:4'].includes(ratio) ? ratio : '9:16';
}

function normalizeResolution(value) {
  const resolution = String(value || '720p').trim();
  return ['480p', '720p', '1080p'].includes(resolution) ? resolution : '720p';
}

function normalizeMode(value) {
  const m = String(value || '').trim();
  return ['text_to_video', 'image_to_video', 'reference_to_video'].includes(m) ? m : 'reference_to_video';
}

function imageObject(url, frameType) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) return null;
  const item = { type: 'image_url', image_url: { url: cleanUrl } };
  if (frameType) item.frame_type = frameType;
  return item;
}

function imageObjects(urls) {
  return (Array.isArray(urls) ? urls : []).map((url) => imageObject(url)).filter(Boolean);
}

function extractJobId(data) {
  const direct = data?.id || data?.jobId || data?.data?.id || data?.response?.id || data?.request_id;
  if (direct) return direct;
  // Fall back to extracting the video ID from polling_url path
  // (OpenRouter video jobs may return only polling_url without a top-level id)
  const pollingUrl = data?.polling_url || data?.pollingUrl;
  if (pollingUrl && typeof pollingUrl === 'string') {
    try {
      const parts = new URL(pollingUrl).pathname.split('/').filter(Boolean);
      const pathId = parts[parts.length - 1];
      if (pathId && !/^(content|download|output|video|file|public|status)$/i.test(pathId)) return pathId;
    } catch (_) {}
  }
  return null;
}

function bearerToken(req) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

async function getUserFromToken(token) {
  if (!token) return null;
  const db = serviceClient();
  if (!db) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch (_) {
    return null;
  }
}

// Reads the current balance and deducts creditCost atomically using optimistic
// concurrency control: the UPDATE only succeeds if the balance hasn't changed
// since we read it, which prevents double-deduction from concurrent requests.
async function checkAndDeduct(db, userId, creditCost, taskId) {
  const { data: bal, error: readErr } = await db
    .from('credit_balances')
    .select('free_credits,subscription_credits,purchased_credits')
    .eq('user_id', userId)
    .maybeSingle();

  if (readErr) return { ok: false, error: readErr.message };
  if (!bal) return { ok: false, error: 'クレジット残高が見つかりません' };

  const free = Number(bal.free_credits || 0);
  const sub = Number(bal.subscription_credits || 0);
  const purchased = Number(bal.purchased_credits || 0);
  const total = free + sub + purchased;

  if (total < creditCost) {
    return { ok: false, insufficient: true, balance: total, required: creditCost,
      error: `クレジット不足です（残高: ${total}、必要: ${creditCost}）` };
  }

  // Deduct priority: subscription → free → purchased
  let remaining = creditCost;
  const fromSub = Math.min(remaining, sub); remaining -= fromSub;
  const fromFree = Math.min(remaining, free); remaining -= fromFree;
  const fromPurchased = Math.min(remaining, purchased);

  // Optimistic lock: WHERE clause matches the exact values we read.
  // If another request already modified the balance, this returns 0 rows.
  const { data: updated, error: updateErr } = await db
    .from('credit_balances')
    .update({
      subscription_credits: sub - fromSub,
      free_credits: free - fromFree,
      purchased_credits: purchased - fromPurchased,
      updated_at: new Date().toISOString()
    })
    .eq('user_id', userId)
    .eq('subscription_credits', sub)
    .eq('free_credits', free)
    .eq('purchased_credits', purchased)
    .select('free_credits,subscription_credits,purchased_credits');

  if (updateErr) return { ok: false, error: updateErr.message };
  if (!updated || updated.length === 0) {
    return { ok: false, concurrentUpdate: true,
      error: 'クレジット残高が更新中です。もう一度お試しください。' };
  }

  // Record per-pool transactions
  const txRows = [];
  if (fromSub > 0) txRows.push({ user_id: userId, amount: -fromSub, credit_type: 'subscription', reason: 'video_generation', related_task_id: taskId || null });
  if (fromFree > 0) txRows.push({ user_id: userId, amount: -fromFree, credit_type: 'free', reason: 'video_generation', related_task_id: taskId || null });
  if (fromPurchased > 0) txRows.push({ user_id: userId, amount: -fromPurchased, credit_type: 'purchased', reason: 'video_generation', related_task_id: taskId || null });
  if (txRows.length) await db.from('credit_transactions').insert(txRows);

  return { ok: true, deducted: creditCost, newBalance: total - creditCost, fromSub, fromFree, fromPurchased };
}

// Returns credits to the exact pools they were deducted from.
async function refundCredits(db, userId, { fromSub, fromFree, fromPurchased }, taskId) {
  try {
    const { data: bal } = await db.from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', userId).maybeSingle();
    if (!bal) return;

    const updateFields = { updated_at: new Date().toISOString() };
    if (fromSub > 0) updateFields.subscription_credits = Number(bal.subscription_credits || 0) + fromSub;
    if (fromFree > 0) updateFields.free_credits = Number(bal.free_credits || 0) + fromFree;
    if (fromPurchased > 0) updateFields.purchased_credits = Number(bal.purchased_credits || 0) + fromPurchased;
    await db.from('credit_balances').update(updateFields).eq('user_id', userId);

    const txRows = [];
    if (fromSub > 0) txRows.push({ user_id: userId, amount: fromSub, credit_type: 'subscription', reason: 'generation_refund', related_task_id: taskId || null });
    if (fromFree > 0) txRows.push({ user_id: userId, amount: fromFree, credit_type: 'free', reason: 'generation_refund', related_task_id: taskId || null });
    if (fromPurchased > 0) txRows.push({ user_id: userId, amount: fromPurchased, credit_type: 'purchased', reason: 'generation_refund', related_task_id: taskId || null });
    if (txRows.length) await db.from('credit_transactions').insert(txRows);
  } catch (_) {}
}

async function createTask(db, { userId, mode, model, prompt, resolution, duration, aspectRatio, creditCost }) {
  try {
    const { data, error } = await db.from('generation_tasks').insert({
      user_id: userId,
      mode,
      model: String(model || DEFAULT_MODEL),
      prompt,
      resolution,
      duration_seconds: Number(duration),
      aspect_ratio: aspectRatio,
      credit_cost: creditCost,
      status: 'queued'
    }).select('id').single();
    if (error) {
      console.error('[seedance-start] createTask error:', error.message, error.code, error.details);
      return null;
    }
    if (!data?.id) {
      console.error('[seedance-start] createTask: no id returned');
      return null;
    }
    return data.id;
  } catch (err) {
    console.error('[seedance-start] createTask exception:', err?.message);
    return null;
  }
}

async function updateTask(db, taskId, fields) {
  if (!taskId) return;
  try {
    await db.from('generation_tasks').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', taskId);
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/seedance-start',
      method: 'POST',
      provider: 'openrouter',
      model: DEFAULT_MODEL,
      note: 'POST only. Authorization: Bearer <supabase-jwt> required.',
      requiredEnv: 'OPENROUTER_API_KEY'
    });
  }

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });

  // Authenticate the user
  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'ログインが必要です', redirect: '/login.html' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  try {
    const body = jsonBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

    const resolution = normalizeResolution(body.resolution);
    const aspectRatio = normalizeAspectRatio(body.aspect_ratio || body.aspectRatio);
    const duration = normalizeDuration(body.duration || body.duration_seconds);
    const mode = normalizeMode(body.mode);
    const model = String(body.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

    // Credit cost is the value shown in the UI (estimated_credits).
    // Clamped to a safe range to prevent client-side manipulation.
    const rawCredits = Math.round(Number(body.estimated_credits) || 0);
    const creditCost = Math.max(MIN_CREDITS, Math.min(MAX_CREDITS, rawCredits)) || MIN_CREDITS;

    // Pre-check balance (read-only, no writes yet)
    const { data: bal } = await db
      .from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', user.id)
      .maybeSingle();
    const total = Number(bal?.free_credits || 0) + Number(bal?.subscription_credits || 0) + Number(bal?.purchased_credits || 0);
    if (total < creditCost) {
      return res.status(402).json({
        ok: false,
        error: `クレジット不足です（残高: ${total}、必要: ${creditCost}）`,
        balance: total,
        required: creditCost
      });
    }

    // Create task record — MUST succeed before touching credits or calling OpenRouter
    const taskId = await createTask(db, { userId: user.id, mode, model, prompt, resolution, duration, aspectRatio, creditCost });
    if (!taskId) {
      console.error('[seedance-start] Aborting: task creation failed, will not deduct credits or call OpenRouter');
      return res.status(500).json({ ok: false, error: 'タスクの作成に失敗しました。もう一度お試しください。' });
    }
    console.log('[seedance-start] task created:', taskId, 'user:', user.id, 'mode:', mode);

    // Deduct credits with optimistic concurrency control (prevents double-deduction)
    const deduction = await checkAndDeduct(db, user.id, creditCost, taskId);
    if (!deduction.ok) {
      console.error('[seedance-start] credit deduction failed:', deduction.error, 'taskId:', taskId);
      await updateTask(db, taskId, { status: 'cancelled', error_message: deduction.error });
      return res.status(deduction.insufficient ? 402 : 409).json({
        ok: false,
        error: deduction.error,
        balance: deduction.balance,
        required: deduction.required
      });
    }

    // Build OpenRouter payload
    const payload = {
      model,
      prompt,
      duration,
      resolution,
      aspect_ratio: aspectRatio,
      generate_audio: true
    };

    const frameImages = Array.isArray(body.frame_images) ? body.frame_images : [];
    const inputReferences = Array.isArray(body.input_references) ? body.input_references : [];
    const firstFrameUrl = String(body.first_frame_url || '').trim();
    const referenceUrl = String(body.reference_url || '').trim();
    const referenceUrls = imageObjects(body.reference_urls || body.referenceUrls || []);

    if (frameImages.length) payload.frame_images = frameImages;
    else if (firstFrameUrl) payload.frame_images = [imageObject(firstFrameUrl, 'first_frame')].filter(Boolean);

    if (!payload.frame_images?.length) {
      if (inputReferences.length) payload.input_references = inputReferences;
      else if (referenceUrls.length) payload.input_references = referenceUrls;
      else if (referenceUrl) payload.input_references = [imageObject(referenceUrl)].filter(Boolean);
    }

    // Call OpenRouter
    console.log('[seedance-start] calling OpenRouter, taskId:', taskId, 'model:', payload.model, 'mode:', mode, 'has_refs:', Boolean(payload.input_references?.length), 'has_frames:', Boolean(payload.frame_images?.length));
    let response, text, data;
    try {
      response = await fetch(OPENROUTER_VIDEO_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://flowvid-studio.vercel.app',
          'X-Title': 'FlowVid Studio'
        },
        body: JSON.stringify(payload)
      });
      text = await response.text();
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    } catch (fetchError) {
      console.error('[seedance-start] OpenRouter network error:', fetchError?.message, 'taskId:', taskId);
      await refundCredits(db, user.id, deduction, taskId);
      await updateTask(db, taskId, { status: 'failed', error_message: fetchError?.message || 'Network error' });
      return res.status(502).json({
        ok: false,
        error: fetchError?.message || 'OpenRouter request failed',
        creditRefunded: creditCost,
        checkedAt: new Date().toISOString()
      });
    }

    if (!response.ok) {
      console.error('[seedance-start] OpenRouter returned', response.status, 'taskId:', taskId, 'body:', String(text||'').slice(0,300));
      await refundCredits(db, user.id, deduction, taskId);
      await updateTask(db, taskId, { status: 'failed', error_message: `OpenRouter ${response.status}` });
      // Always return 502 — never forward OpenRouter's status code (e.g. 403, 429)
      // to avoid misleading the client or Vercel request logs.
      const orError = (typeof data === 'object' && data?.error) ? String(data.error) : String(text||'').slice(0,200);
      const userMsg = response.status === 403
        ? 'API キーが無効か、モデルへのアクセス権がありません（OpenRouter 403）'
        : response.status === 429
        ? 'リクエストが多すぎます。しばらくしてからお試しください（OpenRouter 429）'
        : `生成に失敗しました（OpenRouter ${response.status}）`;
      return res.status(502).json({
        ok: false,
        error: userMsg,
        openrouterStatus: response.status,
        openrouterError: orError,
        creditRefunded: creditCost,
        checkedAt: new Date().toISOString()
      });
    }

    const jobId = extractJobId(data);
    console.log('[seedance-start] OpenRouter accepted, jobId:', jobId, 'pollingUrl:', data?.polling_url||data?.pollingUrl, 'taskId:', taskId);
    await updateTask(db, taskId, { status: 'processing', api_task_id: jobId || null });

    return res.status(202).json({
      ok: true,
      status: response.status,
      provider: 'openrouter',
      model: payload.model,
      jobId,
      pollingUrl: data?.polling_url || data?.pollingUrl || null,
      jobStatus: data?.status || data?.data?.status || null,
      taskId,
      creditCost,
      creditBalance: deduction.newBalance,
      request: {
        duration: payload.duration,
        resolution: payload.resolution,
        aspect_ratio: payload.aspect_ratio,
        has_frame_images: Boolean(payload.frame_images?.length),
        frame_image_count: payload.frame_images?.length || 0,
        has_input_references: Boolean(payload.input_references?.length),
        input_reference_count: payload.input_references?.length || 0,
        text_only: !payload.frame_images?.length && !payload.input_references?.length
      },
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', checkedAt: new Date().toISOString() });
  }
};
