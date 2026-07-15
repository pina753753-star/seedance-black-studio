const { createClient } = require('@supabase/supabase-js');
const { moderateContent } = require('./openai-moderation.js');

const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const DEFAULT_MODEL = 'bytedance/seedance-2.0';
const FAST_MODEL = 'bytedance/seedance-2.0-fast';
const LEGACY_LITE_MODEL = 'bytedance/seedance-2.0-lite';
const ALLOWED_MODELS = [DEFAULT_MODEL, FAST_MODEL, LEGACY_LITE_MODEL];
const MODEL_MULTIPLIERS = { [DEFAULT_MODEL]: 1.0, [FAST_MODEL]: 0.8, [LEGACY_LITE_MODEL]: 0.8 };

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
  return ['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard'].includes(m) ? m : 'reference_to_video';
}

function normalizeModel(value) {
  const m = String(value || DEFAULT_MODEL).trim();
  return ALLOWED_MODELS.includes(m) ? m : DEFAULT_MODEL;
}

function roundUpToFive(value) {
  return Math.ceil(Math.max(MIN_CREDITS, Math.min(MAX_CREDITS, value)) / 5) * 5;
}

function countReferenceInputs(body) {
  if (Array.isArray(body.reference_urls)) return Math.max(1, body.reference_urls.length);
  if (body.reference_url) return 1;
  return 1;
}

function calculateCreditCost(body, mode, duration, resolution, model) {
  if (mode === 'storyboard') {
    return roundUpToFive(Math.max(MIN_CREDITS, duration * 12));
  }
  let credits = 80;
  credits += Math.max(0, duration - 5) * 15;
  if (resolution === '1080p') credits += 100;
  if (resolution === '480p') credits -= 20;
  if (mode === 'text_to_video') credits -= 10;
  credits += 15;
  const multiplier = MODEL_MULTIPLIERS[model] ?? 1.0;
  const modeMultiplier = mode === 'reference_to_video' ? PRICING_SAFETY_MULTIPLIER : 1;
  return roundUpToFive(credits * multiplier * modeMultiplier);
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

function extractImageUrl(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  if (typeof value.url === 'string') return value.url.trim();
  if (typeof value.image_url === 'string') return value.image_url.trim();
  if (value.image_url && typeof value.image_url.url === 'string') return value.image_url.url.trim();
  return '';
}

function collectModerationImageUrls(body) {
  const values = [];
  const append = (value) => {
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  };

  append(body.frame_images);
  append(body.input_references);
  append(body.reference_urls);
  append(body.referenceUrls);
  append(body.reference_url);
  append(body.first_frame_url);

  return [...new Set(values.map(extractImageUrl).filter(Boolean))];
}

function extractJobId(data) {
  const direct = data?.id || data?.jobId || data?.data?.id || data?.response?.id || data?.request_id;
  if (direct) return direct;
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
    expiredFields.subscription_credits = 0;
    bal.subscription_credits = 0;
  }
  if (bal.purchased_expires_at && new Date(bal.purchased_expires_at) < now) {
    expiredFields.purchased_credits = 0;
    bal.purchased_credits = 0;
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
    return { ok: false, concurrentUpdate: true,
      error: 'クレジット残高が更新中です。もう一度お試しください。' };
  }

  const txRows = [];
  if (fromSub > 0) txRows.push({ user_id: userId, amount: -fromSub, credit_type: 'subscription', reason: 'video_generation', related_task_id: taskId || null });
  if (fromFree > 0) txRows.push({ user_id: userId, amount: -fromFree, credit_type: 'free', reason: 'video_generation', related_task_id: taskId || null });
  if (fromPurchased > 0) txRows.push({ user_id: userId, amount: -fromPurchased, credit_type: 'purchased', reason: 'video_generation', related_task_id: taskId || null });
  if (txRows.length) await db.from('credit_transactions').insert(txRows);

  return { ok: true, deducted: creditCost, newBalance: total - creditCost, fromSub, fromFree, fromPurchased };
}

async function refundCredits(db, userId, { fromSub, fromFree, fromPurchased }, taskId) {
  try {
    const { data: bal, error: balSelectErr } = await db.from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', userId).maybeSingle();
    if (balSelectErr) return { ok: false, error: balSelectErr.message };
    if (!bal) return { ok: false, error: 'balance_not_found' };

    const updateFields = { updated_at: new Date().toISOString() };
    if (fromSub > 0) updateFields.subscription_credits = Number(bal.subscription_credits || 0) + fromSub;
    if (fromFree > 0) updateFields.free_credits = Number(bal.free_credits || 0) + fromFree;
    if (fromPurchased > 0) updateFields.purchased_credits = Number(bal.purchased_credits || 0) + fromPurchased;
    const { error: balUpdateErr } = await db.from('credit_balances').update(updateFields).eq('user_id', userId);
    if (balUpdateErr) return { ok: false, error: balUpdateErr.message };

    const txRows = [];
    if (fromSub > 0) txRows.push({ user_id: userId, amount: fromSub, credit_type: 'subscription', reason: 'generation_refund', related_task_id: taskId || null });
    if (fromFree > 0) txRows.push({ user_id: userId, amount: fromFree, credit_type: 'free', reason: 'generation_refund', related_task_id: taskId || null });
    if (fromPurchased > 0) txRows.push({ user_id: userId, amount: fromPurchased, credit_type: 'purchased', reason: 'generation_refund', related_task_id: taskId || null });
    if (txRows.length) {
      const { error: txErr } = await db.from('credit_transactions').insert(txRows);
      if (txErr) console.error('[seedance-start] refund ledger insert failed (balance was still updated):', txErr.message, 'taskId:', taskId);
    }
    return { ok: true };
  } catch (e) {
    console.error('[seedance-start] refundCredits exception:', e?.message, 'taskId:', taskId);
    return { ok: false, error: e?.message || String(e) };
  }
}

function classifyProviderError(rawBody, httpStatus) {
  let providerCode = '';
  let providerMessage = '';
  try {
    const outer = JSON.parse(rawBody);
    const outerMsg = String(outer?.error?.message || '');
    const nestedJsonMatch = /\{[\s\S]*\}\s*$/.exec(outerMsg);
    if (nestedJsonMatch) {
      try {
        const inner = JSON.parse(nestedJsonMatch[0]);
        providerCode = String(inner?.error?.code || '');
        providerMessage = String(inner?.error?.message || '');
      } catch (_) {}
    }
    if (!providerCode && typeof outer?.error?.code === 'string') providerCode = outer.error.code;
    if (!providerMessage) providerMessage = outerMsg;
  } catch (_) {}

  if (/SensitiveContentDetected|ContentPolicy|Moderation/i.test(providerCode) ||
      /content\s*polic|real person|privacy|nsfw|explicit|adult\s*content/i.test(providerMessage)) {
    return { code: providerCode || null, category: 'content_policy' };
  }
  if (httpStatus === 429 || /RateLimit|TooManyRequests/i.test(providerCode)) {
    return { code: providerCode || null, category: 'rate_limit' };
  }
  if (httpStatus === 403 || /Unauthorized|InvalidApiKey|PermissionDenied/i.test(providerCode)) {
    return { code: providerCode || null, category: 'auth' };
  }
  if (/InvalidParameter|InvalidImage|InvalidPrompt/i.test(providerCode)) {
    return { code: providerCode || null, category: 'invalid_input' };
  }
  return { code: providerCode || null, category: 'unknown' };
}

const PROVIDER_ERROR_MESSAGES = {
  content_policy: 'アップロードした画像またはプロンプトの内容が、生成AIのコンテンツポリシーに抵触したため生成できませんでした。内容を変更して再度お試しください。',
  rate_limit: 'リクエストが集中しています。しばらくしてからもう一度お試しください。',
  auth: 'システム側の設定に問題が発生しました。しばらくしてからお試しいただくか、サポートへご連絡ください。',
  invalid_input: '入力内容に問題があり生成できませんでした。内容をご確認のうえ再度お試しください。'
};

async function createTask(db, { userId, mode, model, prompt, resolution, duration, aspectRatio, creditCost }) {
  try {
    const { data, error } = await db.rpc('reserve_generation_task', {
      p_user_id: userId,
      p_mode: mode,
      p_model: String(model || DEFAULT_MODEL),
      p_prompt: prompt,
      p_resolution: resolution,
      p_duration_secs: Number(duration),
      p_aspect_ratio: aspectRatio,
      p_credit_cost: creditCost
    });
    if (error) {
      console.error('[seedance-start] reserve_generation_task RPC error:', error.message, error.code);
      if (error.code === '23505') return { id: null, code: '23505', rejection: 'active_generation' };
      return { id: null, code: error.code || null, rejection: null };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { id: null, code: null, rejection: null };
    if (row.rejection_reason) return { id: null, code: null, rejection: row.rejection_reason, retryAfterSeconds: row.retry_after_seconds || 0 };
    if (!row.task_id) return { id: null, code: null, rejection: null };
    return { id: row.task_id, code: null, rejection: null };
  } catch (err) {
    console.error('[seedance-start] createTask exception:', err?.message);
    return { id: null, code: null, rejection: null };
  }
}

async function updateTask(db, taskId, fields) {
  if (!taskId) return { ok: false, error: 'no taskId' };
  try {
    const { error } = await db.from('generation_tasks').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', taskId);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

async function releaseTask(db, userId, taskId, status, errorMessage) {
  if (!taskId) return;
  const fields = { status: status || 'cancelled' };
  if (errorMessage) fields.error_message = errorMessage;
  const upd = await updateTask(db, taskId, fields);
  if (!upd.ok) {
    try {
      await db.from('generation_tasks').delete().eq('id', taskId).eq('user_id', userId).eq('status', 'queued').is('api_task_id', null);
    } catch (_) {}
  }
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

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'ログインが必要です', redirect: '/login.html' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  let taskId = null;
  let deduction = null;
  let orStarted = false;

  try {
    const body = jsonBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

    const VALID_MODES = ['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard'];
    const VALID_RESOLUTIONS = ['480p', '720p', '1080p'];
    const rawMode = body.mode;
    const rawModel = body.model;
    const rawResolution = body.resolution;
    const rawDuration = body.duration !== undefined ? body.duration : body.duration_seconds;
    if (rawMode !== undefined && rawMode !== null && rawMode !== '' && !VALID_MODES.includes(String(rawMode).trim())) {
      return res.status(400).json({ ok: false, error: 'invalid_mode', message: 'Unsupported generation mode.' });
    }
    if (rawModel !== undefined && rawModel !== null && rawModel !== '' && !ALLOWED_MODELS.includes(String(rawModel).trim())) {
      return res.status(400).json({ ok: false, error: 'invalid_model', message: 'Unsupported generation model.' });
    }
    if (rawResolution !== undefined && rawResolution !== null && rawResolution !== '' && !VALID_RESOLUTIONS.includes(String(rawResolution).trim())) {
      return res.status(400).json({ ok: false, error: 'invalid_resolution', message: 'Unsupported resolution.' });
    }
    if (rawDuration !== undefined && rawDuration !== '') {
      const durNum = Number(rawDuration);
      if (rawDuration === null || !Number.isFinite(durNum) || !Number.isInteger(durNum) || durNum < 1 || durNum > 15) {
        return res.status(400).json({ ok: false, error: 'invalid_duration', message: 'Duration must be an integer between 1 and 15.' });
      }
    }

    const resolution = normalizeResolution(body.resolution);
    const aspectRatio = normalizeAspectRatio(body.aspect_ratio || body.aspectRatio);
    const duration = normalizeDuration(body.duration || body.duration_seconds);
    const mode = normalizeMode(body.mode);
    const model = normalizeModel(body.model);

    if ((model === FAST_MODEL || model === LEGACY_LITE_MODEL) && mode === 'reference_to_video' && resolution === '1080p') {
      return res.status(400).json({
        ok: false,
        error: 'unsupported_combination',
        message: 'Seedance 2.0 Fastのリファレンスモードは1080pに対応していません。720p以下をお選びください。'
      });
    }

    const moderation = await moderateContent(prompt, collectModerationImageUrls(body));
    if (!moderation.ok) {
      console.error('[seedance-start] moderation unavailable:', moderation.errorCode, 'httpStatus:', moderation.httpStatus || null);
      return res.status(503).json({
        ok: false,
        error: 'content_safety_check_unavailable',
        errorCategory: 'moderation_unavailable',
        message: '現在コンテンツの安全確認を行えないため、生成を開始できません。しばらくしてからもう一度お試しください。'
      });
    }
    if (moderation.flagged) {
      console.warn('[seedance-start] moderation blocked request; categories:', moderation.categories || []);
      return res.status(422).json({
        ok: false,
        error: 'content_policy_violation',
        errorCategory: 'content_policy',
        message: PROVIDER_ERROR_MESSAGES.content_policy
      });
    }

    const creditCost = calculateCreditCost(body, mode, duration, resolution, model);

    const { data: bal } = await db
      .from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', user.id)
      .maybeSingle();
    const total = Number(bal?.free_credits || 0) + Number(bal?.subscription_credits || 0) + Number(bal?.purchased_credits || 0);
    if (total < creditCost) {
      return res.status(402).json({ ok: false, error: `クレジット不足です（残高: ${total}、必要: ${creditCost}）`, balance: total, required: creditCost });
    }

    const taskResult = await createTask(db, { userId: user.id, mode, model, prompt, resolution, duration, aspectRatio, creditCost });
    if (!taskResult.id) {
      if (taskResult.rejection === 'active_generation' || taskResult.code === '23505') {
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

    deduction = await checkAndDeduct(db, user.id, creditCost, taskId);
    if (!deduction.ok) {
      await releaseTask(db, user.id, taskId, 'cancelled');
      return res.status(deduction.insufficient ? 402 : 409).json({ ok: false, error: deduction.error, balance: deduction.balance, required: deduction.required });
    }

    const payload = { model, prompt, duration, resolution, aspect_ratio: aspectRatio, generate_audio: true };
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

    orStarted = true;
    let response, text, data;
    try {
      response = await fetch(OPENROUTER_VIDEO_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://flowvid-studio.vercel.app', 'X-Title': 'FlowVid Studio' },
        body: JSON.stringify(payload)
      });
      text = await response.text();
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    } catch (fetchError) {
      const refundResult = await refundCredits(db, user.id, deduction, taskId);
      await releaseTask(db, user.id, taskId, 'failed', fetchError?.message || 'Network error');
      return res.status(502).json({ ok: false, error: fetchError?.message || 'OpenRouter request failed', creditRefunded: refundResult.ok ? creditCost : 0, refunded: refundResult.ok, checkedAt: new Date().toISOString() });
    }

    if (!response.ok) {
      const rawBody = String(text || '');
      const refundResult = await refundCredits(db, user.id, deduction, taskId);
      await releaseTask(db, user.id, taskId, 'failed', `OpenRouter ${response.status}: ${rawBody.slice(0, 200)}`);
      const classified = classifyProviderError(rawBody, response.status);
      const orMsg = PROVIDER_ERROR_MESSAGES[classified.category] || `生成に失敗しました（HTTP ${response.status}）`;
      return res.status(502).json({ ok: false, error: orMsg, errorCategory: classified.category, providerErrorCode: classified.code, error_detail: rawBody.slice(0, 1000), openrouterStatus: response.status, creditRefunded: refundResult.ok ? creditCost : 0, refunded: refundResult.ok, checkedAt: new Date().toISOString() });
    }

    const jobId = extractJobId(data);
    const orPollingUrl = data?.polling_url || data?.pollingUrl || null;
    if (!jobId && !orPollingUrl) {
      const refundResult = await refundCredits(db, user.id, deduction, taskId);
      await releaseTask(db, user.id, taskId, 'failed');
      return res.status(502).json({ ok: false, error: 'OpenRouterから有効なジョブIDが返されませんでした。もう一度お試しください。', creditRefunded: refundResult.ok ? creditCost : 0, refunded: refundResult.ok, checkedAt: new Date().toISOString() });
    }

    let trackingPersisted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data: updRows, error: updErr } = await db.from('generation_tasks')
          .update({ status: 'processing', api_task_id: jobId || null, polling_url: orPollingUrl || null, updated_at: new Date().toISOString() })
          .eq('id', taskId).eq('user_id', user.id).in('status', ['queued', 'processing']).select('id');
        if (!updErr && updRows && updRows.length > 0) { trackingPersisted = true; break; }
      } catch (_) {}
    }
    if (!trackingPersisted) {
      try {
        const { data: fallbackRows, error: fallbackErr } = await db.from('generation_tasks')
          .update({ status: 'processing', api_task_id: jobId || null, polling_url: orPollingUrl || null, updated_at: new Date().toISOString() })
          .eq('id', taskId).eq('user_id', user.id).select('id');
        if (!fallbackErr && fallbackRows && fallbackRows.length > 0) trackingPersisted = true;
      } catch (_) {}
    }
    if (!trackingPersisted) {
      return res.status(503).json({ ok: false, error: 'generation_tracking_persistence_failed', message: '動画生成は開始されましたが、生成情報の保存に失敗しました。再度生成せず、サポートへお問い合わせください。', providerStarted: true, taskId, jobId, pollingUrl: orPollingUrl });
    }

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
    let refunded = false;
    if (taskId && !orStarted) {
      if (deduction?.ok) {
        const refundResult = await refundCredits(db, user.id, deduction, taskId);
        refunded = refundResult.ok;
      }
      await releaseTask(db, user.id, taskId, 'failed');
    }
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', refunded, checkedAt: new Date().toISOString() });
  }
};