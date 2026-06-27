const { createClient } = require('@supabase/supabase-js');

const FAL_QUEUE_BASE = 'https://queue.fal.run';
const FAL_ENDPOINT_TEXT = 'bytedance/seedance-2.0/text-to-video';
const FAL_ENDPOINT_IMAGE = 'bytedance/seedance-2.0/image-to-video';
const FAL_WEBHOOK_URL = 'https://flowvid-studio.vercel.app/api/fal-webhook';

const DEFAULT_MODEL = 'bytedance/seedance-2.0';
const FAL_MODES = ['text_to_video', 'image_to_video'];

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const MIN_CREDITS = 50;
const MAX_CREDITS = 400;
const PRICING_SAFETY_MULTIPLIER = 1.15;

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function roundUpToFive(value) {
  return Math.ceil(Math.max(MIN_CREDITS, Math.min(MAX_CREDITS, value)) / 5) * 5;
}

function calculateCreditCost(mode, duration, resolution) {
  if (mode === 'storyboard') return roundUpToFive(Math.max(MIN_CREDITS, duration * 12));
  let credits = 80;
  credits += Math.max(0, duration - 5) * 15;
  if (resolution === '1080p') credits += 100;
  if (resolution === '480p') credits -= 20;
  if (mode === 'text_to_video') credits -= 10;
  credits += 15;
  // Standard model multiplier = 1.0; reference modeMultiplier not applicable here (only text/image)
  return roundUpToFive(credits);
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
  } catch (_) { return null; }
}

async function checkAndDeduct(db, userId, creditCost, taskId) {
  const { data: bal, error: readErr } = await db
    .from('credit_balances')
    .select('free_credits,subscription_credits,purchased_credits,subscription_expires_at,purchased_expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!bal) return { ok: false, error: 'クレジット残高が見つかりません' };

  const now = new Date();
  const expiredFields = {};
  if (bal.subscription_expires_at && new Date(bal.subscription_expires_at) < now) {
    expiredFields.subscription_credits = 0; bal.subscription_credits = 0;
  }
  if (bal.purchased_expires_at && new Date(bal.purchased_expires_at) < now) {
    expiredFields.purchased_credits = 0; bal.purchased_credits = 0;
  }
  if (Object.keys(expiredFields).length > 0) {
    expiredFields.updated_at = now.toISOString();
    await db.from('credit_balances').update(expiredFields).eq('user_id', userId);
  }

  const free = Number(bal.free_credits || 0);
  const sub = Number(bal.subscription_credits || 0);
  const purchased = Number(bal.purchased_credits || 0);
  const total = free + sub + purchased;
  if (total < creditCost) {
    return { ok: false, insufficient: true, balance: total, required: creditCost,
      error: `クレジット不足です（残高: ${total}、必要: ${creditCost}）` };
  }

  let remaining = creditCost;
  const fromSub = Math.min(remaining, sub); remaining -= fromSub;
  const fromFree = Math.min(remaining, free); remaining -= fromFree;
  const fromPurchased = Math.min(remaining, purchased);

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
    return { ok: false, concurrentUpdate: true, error: 'クレジット残高が更新中です。もう一度お試しください。' };
  }

  const txRows = [];
  if (fromSub > 0) txRows.push({ user_id: userId, amount: -fromSub, credit_type: 'subscription', reason: 'video_generation', related_task_id: taskId || null });
  if (fromFree > 0) txRows.push({ user_id: userId, amount: -fromFree, credit_type: 'free', reason: 'video_generation', related_task_id: taskId || null });
  if (fromPurchased > 0) txRows.push({ user_id: userId, amount: -fromPurchased, credit_type: 'purchased', reason: 'video_generation', related_task_id: taskId || null });
  if (txRows.length) await db.from('credit_transactions').insert(txRows);

  return { ok: true, deducted: creditCost, newBalance: total - creditCost, fromSub, fromFree, fromPurchased };
}

async function refundCredits(db, userId, deduction, taskId) {
  try {
    const { fromSub = 0, fromFree = 0, fromPurchased = 0 } = deduction;
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
    const { data, error } = await db.rpc('reserve_generation_task', {
      p_user_id: userId, p_mode: mode, p_model: String(model || DEFAULT_MODEL),
      p_prompt: prompt, p_resolution: resolution, p_duration_secs: Number(duration),
      p_aspect_ratio: aspectRatio, p_credit_cost: creditCost
    });
    if (error) {
      if (error.code === '23505') return { id: null, rejection: 'active_generation' };
      console.error('[fal-start] reserve_generation_task error:', error.message);
      return { id: null, rejection: null };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { id: null, rejection: null };
    if (row.rejection_reason) return { id: null, rejection: row.rejection_reason, retryAfterSeconds: row.retry_after_seconds || 0 };
    if (!row.task_id) return { id: null, rejection: null };
    return { id: row.task_id };
  } catch (e) {
    console.error('[fal-start] createTask exception:', e?.message);
    return { id: null, rejection: null };
  }
}

async function releaseTask(db, userId, taskId, status, errorMessage) {
  if (!taskId) return;
  try {
    const fields = { status: status || 'cancelled', updated_at: new Date().toISOString() };
    if (errorMessage) fields.error_message = String(errorMessage).slice(0, 500);
    const { error } = await db.from('generation_tasks').update(fields).eq('id', taskId);
    if (error) {
      await db.from('generation_tasks').delete().eq('id', taskId).eq('user_id', userId).eq('status', 'queued').is('api_task_id', null);
    }
  } catch (_) {}
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, endpoint: '/api/fal-start', method: 'POST', provider: 'fal' });
  }

  const falKey = process.env.FAL_KEY || '';
  if (!falKey) {
    return res.status(500).json({ ok: false, error: 'provider_not_configured', message: '動画生成サービスが設定されていません。' });
  }

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'ログインが必要です', redirect: '/login.html' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  let taskId = null;
  let deduction = null;
  let falSubmitted = false;

  try {
    const body = jsonBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

    const mode = String(body.mode || '').trim();
    if (!FAL_MODES.includes(mode)) {
      return res.status(400).json({ ok: false, error: 'invalid_mode', message: 'このモードはfal.ai経由では未対応です。' });
    }

    // duration: fal supports 4-15 seconds
    const rawDuration = body.duration !== undefined ? body.duration : body.duration_seconds;
    const duration = Math.max(1, Math.min(15, Math.round(Number(rawDuration) || 5)));
    if (duration < 4) {
      return res.status(400).json({ ok: false, error: 'invalid_duration', message: 'このモードでは4秒以上の動画のみ生成できます（fal.ai制約）。' });
    }

    const VALID_RESOLUTIONS = ['480p', '720p', '1080p'];
    const resolution = VALID_RESOLUTIONS.includes(String(body.resolution || '').trim()) ? body.resolution.trim() : '720p';
    const VALID_ASPECTS = ['9:16', '16:9', '1:1', '4:3', '3:4'];
    const aspectRatio = VALID_ASPECTS.includes(String(body.aspect_ratio || body.aspectRatio || '').trim())
      ? (body.aspect_ratio || body.aspectRatio).trim() : '9:16';

    const imageUrl = mode === 'image_to_video' ? String(body.first_frame_url || body.image_url || '').trim() : '';
    if (mode === 'image_to_video' && !imageUrl) {
      return res.status(400).json({ ok: false, error: 'image_url_required', message: '画像URLが必要です。' });
    }

    const model = DEFAULT_MODEL; // fal only handles Standard
    const creditCost = calculateCreditCost(mode, duration, resolution);

    // Pre-check balance (non-atomic, to fail fast)
    const { data: bal } = await db.from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', user.id).maybeSingle();
    const total = Number(bal?.free_credits || 0) + Number(bal?.subscription_credits || 0) + Number(bal?.purchased_credits || 0);
    if (total < creditCost) {
      return res.status(402).json({ ok: false, error: `クレジット不足です（残高: ${total}、必要: ${creditCost}）`, balance: total, required: creditCost });
    }

    // Reserve task (advisory lock + active check + cooldown check + INSERT)
    const taskResult = await createTask(db, { userId: user.id, mode, model, prompt, resolution, duration, aspectRatio, creditCost });
    if (!taskResult.id) {
      if (taskResult.rejection === 'active_generation') {
        return res.status(409).json({ ok: false, error: 'generation_already_in_progress', message: '現在生成中の動画があります。完了後にもう一度お試しください。' });
      }
      if (taskResult.rejection === 'cooldown_active') {
        const secs = taskResult.retryAfterSeconds || 60;
        res.setHeader('Retry-After', String(secs));
        return res.status(429).json({ ok: false, error: 'generation_cooldown_active', message: `前回の生成終了から60秒間は再生成できません。あと${secs}秒お待ちください。`, retryAfterSeconds: secs });
      }
      return res.status(500).json({ ok: false, error: 'タスクの作成に失敗しました。もう一度お試しください。' });
    }
    taskId = taskResult.id;
    console.log('[fal-start] task created:', taskId, 'user:', user.id, 'mode:', mode);

    // Mark provider immediately (before credit deduction, so webhook can find the task)
    await db.from('generation_tasks')
      .update({ api_provider: 'fal', updated_at: new Date().toISOString() })
      .eq('id', taskId);

    // Deduct credits (optimistic concurrency)
    deduction = await checkAndDeduct(db, user.id, creditCost, taskId);
    if (!deduction.ok) {
      console.error('[fal-start] credit deduction failed:', deduction.error, 'taskId:', taskId);
      await releaseTask(db, user.id, taskId, 'cancelled');
      return res.status(deduction.insufficient ? 402 : 409).json({
        ok: false, error: deduction.error, balance: deduction.balance, required: deduction.required
      });
    }

    // Build fal.ai input (per official schema)
    const falEndpoint = mode === 'image_to_video' ? FAL_ENDPOINT_IMAGE : FAL_ENDPOINT_TEXT;
    const falInput = {
      prompt,
      resolution,
      duration,
      aspect_ratio: aspectRatio,
      generate_audio: true,
      bitrate_mode: 'standard'
    };
    if (mode === 'image_to_video') falInput.image_url = imageUrl;

    // Submit to fal queue via REST (no SDK dependency)
    const encodedWebhook = encodeURIComponent(FAL_WEBHOOK_URL);
    const submitUrl = `${FAL_QUEUE_BASE}/${falEndpoint}?fal_webhook=${encodedWebhook}`;
    console.log('[fal-start] submitting to fal queue, taskId:', taskId, 'endpoint:', falEndpoint);
    falSubmitted = true;

    let falData;
    try {
      const falRes = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${falKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(falInput)
      });
      const falText = await falRes.text();
      try { falData = JSON.parse(falText); } catch (_) { falData = {}; }

      if (!falRes.ok) {
        console.error('[fal-start] fal queue error:', falRes.status, falText.slice(0, 500), 'taskId:', taskId);
        await refundCredits(db, user.id, deduction, taskId);
        await releaseTask(db, user.id, taskId, 'failed', `fal queue HTTP ${falRes.status}`);
        return res.status(502).json({
          ok: false,
          error: 'fal.aiへの動画生成リクエストに失敗しました。もう一度お試しください。',
          creditRefunded: creditCost,
          checkedAt: new Date().toISOString()
        });
      }
    } catch (fetchErr) {
      console.error('[fal-start] fal network error:', fetchErr?.message, 'taskId:', taskId);
      await refundCredits(db, user.id, deduction, taskId);
      await releaseTask(db, user.id, taskId, 'failed', fetchErr?.message || 'Network error');
      return res.status(502).json({
        ok: false,
        error: 'fal.aiへの接続に失敗しました。もう一度お試しください。',
        creditRefunded: creditCost,
        checkedAt: new Date().toISOString()
      });
    }

    // Extract request_id (handle both snake_case and camelCase from SDK/REST)
    const falRequestId = String(falData?.request_id || falData?.requestId || '').trim();
    if (!falRequestId) {
      console.error('[fal-start] no request_id from fal response:', JSON.stringify(falData).slice(0, 300), 'taskId:', taskId);
      await refundCredits(db, user.id, deduction, taskId);
      await releaseTask(db, user.id, taskId, 'failed', 'No request_id from fal');
      return res.status(502).json({
        ok: false,
        error: 'fal.aiから有効なリクエストIDが返されませんでした。もう一度お試しください。',
        creditRefunded: creditCost,
        checkedAt: new Date().toISOString()
      });
    }
    console.log('[fal-start] fal queue accepted, request_id:', falRequestId, 'taskId:', taskId);

    // Persist request_id + status (retry up to 3x)
    let trackingPersisted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data: updRows, error: updErr } = await db.from('generation_tasks')
          .update({ status: 'processing', api_task_id: falRequestId, polling_url: null, updated_at: new Date().toISOString() })
          .eq('id', taskId).eq('user_id', user.id).in('status', ['queued', 'processing']).select('id');
        if (!updErr && updRows?.length > 0) { trackingPersisted = true; break; }
        if (updErr) console.error('[fal-start] tracking persist attempt', attempt, updErr.message);
      } catch (e) {
        console.error('[fal-start] tracking persist attempt', attempt, 'exception:', e?.message);
      }
    }

    if (!trackingPersisted) {
      // fal is already running; do NOT refund or release
      console.error('[fal-start] tracking persistence FAILED — fal started, not refunding. taskId:', taskId, 'request_id:', falRequestId);
      return res.status(503).json({
        ok: false,
        error: 'generation_tracking_persistence_failed',
        message: '動画生成は開始されましたが、生成情報の保存に失敗しました。再度生成せず、サポートへお問い合わせください。',
        providerStarted: true,
        taskId,
        checkedAt: new Date().toISOString()
      });
    }

    return res.status(202).json({
      ok: true,
      accepted: true,
      done: false,
      provider: 'fal',
      taskId,
      status: 'queued',
      creditCost,
      creditBalance: deduction.newBalance,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[fal-start] unexpected error:', error?.message, 'taskId:', taskId, 'falSubmitted:', falSubmitted);
    if (taskId && !falSubmitted) {
      if (deduction?.ok) await refundCredits(db, user.id, deduction, taskId);
      await releaseTask(db, user.id, taskId, 'failed');
    }
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', checkedAt: new Date().toISOString() });
  }
};
