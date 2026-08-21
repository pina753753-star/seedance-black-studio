const { createClient } = require('@supabase/supabase-js');
const { moderateContent } = require('./openai-moderation.js');
const { resolveModerationDecision } = require('./moderation-decision.js');
const { requireConfirmedAuth } = require('./confirmed-auth.js');
const { checkGenerationControl, REFUND_UNCONFIRMED_MESSAGE } = require('./generation-control.js');
const { calculateVideoCreditCost } = require('./video-pricing.js');
const { DEFAULT_MODEL, validateVideoGenerationOptions } = require('./video-model-validation.js');
const { buildProviderPrompt } = require('./video-provider-prompt.js');
const { normalizeReferenceAudioPaths, createReferenceAudioSignedUrls } = require('./reference-audio.js');

const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const WAVESPEED_API_BASE = 'https://api.wavespeed.ai/api/v3';
const WAVESPEED_TEXT_MODEL = 'bytedance/seedance-2.5/text-to-video-turbo';
const WAVESPEED_IMAGE_MODEL = 'bytedance/seedance-2.5/image-to-video-turbo';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
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

function buildWaveSpeedPayload({ providerPrompt, duration, resolution, aspectRatio, mode, frameImages, inputReferences, firstFrameUrl, referenceUrl, referenceUrls, referenceAudioUrls = [] }) {
  const payload = {
    prompt: providerPrompt,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    generate_audio: true
  };
  const waveReferenceUrls = [
    ...(Array.isArray(frameImages) ? frameImages : []).map(extractImageUrl),
    firstFrameUrl,
    ...(Array.isArray(inputReferences) ? inputReferences : []).map(extractImageUrl),
    ...(Array.isArray(referenceUrls) ? referenceUrls : []).map(extractImageUrl),
    referenceUrl
  ].filter(Boolean);
  if (mode === 'image_to_video') payload.image = waveReferenceUrls[0] || '';
  else if (waveReferenceUrls.length) payload.reference_images = [...new Set(waveReferenceUrls)];
  if (referenceAudioUrls.length) payload.reference_audios = [...new Set(referenceAudioUrls)];
  return payload;
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

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// Deducts the balance and writes all per-pool charge ledger rows in one DB
// transaction. The task row and balance row are locked by the RPC, and a retry
// for the same task returns the existing charge instead of deducting twice.
async function checkAndDeduct(db, userId, creditCost, taskId) {
  try {
    const { data, error } = await db.rpc('deduct_generation_credits_atomic', {
      p_task_id: taskId,
      p_user_id: userId,
      p_credit_cost: creditCost
    });
    if (error) return { ok: false, uncertain: true, error: error.message };
    if (!data?.ok) {
      const balance = Number(data?.balance || 0);
      const required = Number(data?.required || creditCost);
      if (data?.code === 'insufficient_credits') {
        return {
          ok: false,
          insufficient: true,
          balance,
          required,
          error: `クレジット不足です（残高: ${balance}、必要: ${required}）`
        };
      }
      return { ok: false, error: data?.code || 'クレジット控除に失敗しました' };
    }

    return {
      ok: true,
      deducted: Number(data.deducted || creditCost),
      newBalance: Number(data.new_balance || 0),
      fromSub: Number(data.from_subscription || 0),
      fromFree: Number(data.from_free || 0),
      fromPurchased: Number(data.from_purchased || 0)
    };
  } catch (error) {
    return { ok: false, uncertain: true, error: error?.message || String(error) };
  }
}

// Returns credits to the exact pools they were deducted from.
// Returns { ok: true } only if the balance update (and ledger insert, when
// applicable) actually completed. Callers use this to report an accurate
// refund status to the client instead of assuming success.
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
      // Balance was already updated above; the ledger row is a record of that
      // fact, not a precondition. Report ok:true regardless so the client
      // isn't told "not refunded" when the balance was in fact restored.
      if (txErr) console.error('[seedance-start] refund ledger insert failed (balance was still updated):', txErr.message, 'taskId:', taskId);
    }
    return { ok: true };
  } catch (e) {
    console.error('[seedance-start] refundCredits exception:', e?.message, 'taskId:', taskId);
    return { ok: false, error: e?.message || String(e) };
  }
}

// Best-effort extraction + classification of the upstream provider's error
// code from an OpenRouter error response body. OpenRouter/Seedance error
// bodies are inconsistent: sometimes the real provider error is nested as a
// stringified JSON inside `.error.message` (observed shape:
// {"error":{"message":"HTTP 400: {\"error\":{\"code\":\"...\",...}}","code":400}}),
// sometimes it's a flat string code at the top level. Returns { code, category }
// where category is one of 'content_policy' | 'rate_limit' | 'auth' |
// 'invalid_input' | 'unknown'. Never throws.
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
      } catch (_) { /* not nested JSON, fall through */ }
    }
    if (!providerCode && typeof outer?.error?.code === 'string') {
      providerCode = outer.error.code;
    }
    if (!providerMessage) providerMessage = outerMsg;
  } catch (_) { /* rawBody wasn't JSON at all */ }

  // Known/observed codes (confirmed from production logs):
  //   InputImageSensitiveContentDetected.PrivacyInformation — image flagged as a real person
  // Plausible sibling codes based on the same naming convention, NOT yet
  // observed in production — included so the same category catches them if
  // they occur, but unconfirmed:
  //   InputImageSensitiveContentDetected.Porn / .Violence
  //   InputTextSensitiveContentDetected.*
  //   OutputVideoSensitiveContentDetected.*
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

// Atomically reserve a generation task via RPC.
// The DB function acquires a per-user advisory lock then checks:
//   1. active (queued/processing) task → rejection_reason: 'active_generation'
//   2. cooldown (finished_at + 60s > NOW()) → rejection_reason: 'cooldown_active'
//   3. neither → INSERT with status='queued', returns task_id
// RPC errors abort task reservation; no direct INSERT fallback is used because
// that would bypass the active-generation and cooldown checks.
async function createTask(db, { userId, mode, model, prompt, resolution, duration, aspectRatio, creditCost }) {
  try {
    const { data, error } = await db.rpc('reserve_generation_task', {
      p_user_id:       userId,
      p_mode:          mode,
      p_model:         String(model || DEFAULT_MODEL),
      p_prompt:        prompt,
      p_resolution:    resolution,
      p_duration_secs: Number(duration),
      p_aspect_ratio:  aspectRatio,
      p_credit_cost:   creditCost
    });
    if (error) {
      console.error('[seedance-start] reserve_generation_task RPC error:', error.message, error.code);
      // A 23505 propagated by the RPC's INSERT still maps to active_generation.
      if (error.code === '23505') return { id: null, code: '23505', rejection: 'active_generation' };
      return { id: null, code: error.code || null, rejection: null };
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      console.error('[seedance-start] reserve_generation_task: no row returned');
      return { id: null, code: null, rejection: null };
    }
    if (row.rejection_reason) {
      console.log('[seedance-start] reserve_generation_task rejected:', row.rejection_reason, 'retryAfter:', row.retry_after_seconds);
      return { id: null, code: null, rejection: row.rejection_reason, retryAfterSeconds: row.retry_after_seconds || 0 };
    }
    if (!row.task_id) {
      console.error('[seedance-start] reserve_generation_task: no task_id in response');
      return { id: null, code: null, rejection: null };
    }
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
    if (error) {
      console.error('[seedance-start] updateTask error:', error.message, 'taskId:', taskId, 'fields:', JSON.stringify(Object.keys(fields)));
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    console.error('[seedance-start] updateTask exception:', err?.message, 'taskId:', taskId);
    return { ok: false, error: err?.message };
  }
}

// Releases a generation reservation by marking it cancelled/failed.
// Falls back to DELETE if the status update fails, to ensure the partial
// unique index slot is freed and the user can start a new generation.
async function releaseTask(db, userId, taskId, status, errorMessage) {
  if (!taskId) return;
  const fields = { status: status || 'cancelled' };
  if (errorMessage) fields.error_message = errorMessage;
  const upd = await updateTask(db, taskId, fields);
  if (!upd.ok) {
    console.error('[seedance-start] releaseTask: updateTask failed, attempting DELETE fallback', 'taskId:', taskId);
    try {
      const { error } = await db.from('generation_tasks')
        .delete()
        .eq('id', taskId)
        .eq('user_id', userId)
        .eq('status', 'queued')
        .is('api_task_id', null);
      if (error) console.error('[seedance-start] releaseTask DELETE fallback error:', error.message, 'taskId:', taskId);
      else console.log('[seedance-start] releaseTask: DELETE fallback succeeded for taskId:', taskId);
    } catch (err) {
      console.error('[seedance-start] releaseTask DELETE fallback exception:', err?.message, 'taskId:', taskId);
    }
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/seedance-start',
      method: 'POST',
      provider: 'openrouter (480p/720p) or wavespeed (Seedance 2.5 1080p)',
      model: DEFAULT_MODEL,
      note: 'POST only. Authorization: Bearer <supabase-jwt> required.',
      requiredEnv: 'OPENROUTER_API_KEY and WAVESPEED_API_KEY for Seedance 2.5 1080p'
    });
  }

  // Authenticate against Supabase Auth and reject unconfirmed addresses before
  // moderation, balance reads, task creation, credit use, or OpenRouter calls.
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  const user = auth.user;
  const db = auth.supabase || serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  // Global emergency stop. Check after authentication but before moderation,
  // task creation, credit deduction, or any OpenRouter request. A missing row
  // or database read error fails closed so an uncertain control state can
  // never start a paid generation.
  const generationControl = await checkGenerationControl(db);
  if (!generationControl.ok) {
    return res.status(generationControl.status).json(generationControl.body);
  }

  let taskId = null;
  let deduction = null;
  let orStarted = false;

  try {
    const body = jsonBody(req);
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

    // Model capabilities are validated before moderation, DB writes, credit
    // deductions, and the OpenRouter request. Missing fields retain the existing
    // Seedance 2.0 defaults for backward compatibility.
    const options = validateVideoGenerationOptions({
      model: body.model,
      mode: body.mode,
      resolution: body.resolution,
      aspectRatio: body.aspect_ratio || body.aspectRatio,
      duration: body.duration !== undefined ? body.duration : body.duration_seconds
    });
    if (!options.ok) return res.status(400).json({ ok: false, error: options.error, message: options.message });
    const { resolution, aspectRatio, duration, mode, model } = options;
    const provider = model === 'bytedance/seedance-2.5' && resolution === '1080p'
      ? 'wavespeed'
      : 'openrouter';
    const apiKey = provider === 'wavespeed'
      ? (process.env.WAVESPEED_API_KEY || '')
      : (process.env.OPENROUTER_API_KEY || '');
    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: provider === 'wavespeed' ? 'Missing WAVESPEED_API_KEY' : 'Missing OPENROUTER_API_KEY'
      });
    }

    const normalizedAudio = normalizeReferenceAudioPaths(body.reference_audio_paths, user.id);
    if (!normalizedAudio.ok) {
      return res.status(400).json({ ok: false, error: normalizedAudio.error, message: normalizedAudio.message });
    }
    if (normalizedAudio.paths.length && (provider !== 'wavespeed' || mode === 'image_to_video')) {
      return res.status(400).json({
        ok: false,
        error: 'reference_audio_not_supported',
        message: '参照音源はSeedance 2.5・1080pのテキスト／リファレンス生成で利用できます。'
      });
    }
    const signedAudio = await createReferenceAudioSignedUrls(db, normalizedAudio.paths);
    if (!signedAudio.ok) {
      return res.status(400).json({ ok: false, error: signedAudio.error, message: signedAudio.message });
    }

    // Authentication has already succeeded above. Fail closed before any task,
    // credit, or OpenRouter work if moderation blocks or cannot complete.
    const moderation = await moderateContent(prompt, collectModerationImageUrls(body));
    const moderationDecision = await resolveModerationDecision(prompt, moderation);
    if (!moderationDecision.ok) {
      console.error(
        '[seedance-start] content safety decision unavailable:',
        moderationDecision.reason,
        moderationDecision.errorCode || null
      );
      return res.status(503).json({
        ok: false,
        error: 'content_safety_check_unavailable',
        errorCategory: 'moderation_unavailable',
        message: '現在コンテンツの安全確認を行えないため、生成を開始できません。しばらくしてからもう一度お試しください。'
      });
    }
    if (!moderationDecision.allow) {
      console.warn(
        '[seedance-start] content safety blocked request;',
        'categories:',
        moderation.categories || [],
        'reason:',
        moderationDecision.reason
      );
      // Record the block for admin.html visibility. Best-effort only: a
      // logging failure must never change the rejection response the user
      // already gets above/below, so errors here are swallowed after being
      // logged. This does not alter the moderation decision itself.
      try {
        const { error: logInsertError } = await db.from('moderation_blocks').insert({
          user_id: user.id,
          mode,
          categories: moderation.categories || [],
          reason: moderationDecision.reason,
          classification: moderationDecision.classification || null,
          prompt
        });
        if (logInsertError) {
          console.error('[seedance-start] failed to record moderation_blocks row:', logInsertError.message);
        }
      } catch (logError) {
        console.error('[seedance-start] failed to record moderation_blocks row:', logError?.message || logError);
      }
      return res.status(422).json({
        ok: false,
        error: 'content_policy_violation',
        errorCategory: 'content_policy',
        message: PROVIDER_ERROR_MESSAGES.content_policy
      });
    }

    const creditCost = calculateVideoCreditCost({ ...body, mode, duration, resolution, model });

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

    // Moderation and the balance read can take long enough for an operator to
    // activate the stop after the request's first check. Recheck immediately
    // before task reservation so no write begins after a confirmed stop.
    const preReservationControl = await checkGenerationControl(db);
    if (!preReservationControl.ok) {
      return res.status(preReservationControl.status).json(preReservationControl.body);
    }

    // Reserve task atomically via RPC (advisory lock + active check + cooldown check + INSERT).
    // The partial unique index (queued/processing per user) remains as a final defence.
    // Credits and OpenRouter are never touched if reservation is rejected.
    const taskResult = await createTask(db, { userId: user.id, mode, model, prompt, resolution, duration, aspectRatio, creditCost });
    if (!taskResult.id) {
      // active_generation: queued/processing task exists, or 23505 from concurrent INSERT
      if (taskResult.rejection === 'active_generation' || taskResult.code === '23505') {
        return res.status(409).json({
          ok: false,
          error: 'generation_already_in_progress',
          message: '現在生成中の動画があります。完了後にもう一度お試しください。'
        });
      }
      // cooldown_active: last task finished less than 60 seconds ago
      if (taskResult.rejection === 'cooldown_active') {
        const secs = taskResult.retryAfterSeconds || 60;
        res.setHeader('Retry-After', String(secs));
        return res.status(429).json({
          ok: false,
          error: 'generation_cooldown_active',
          message: `前回の生成終了から60秒間は再生成できません。あと${secs}秒お待ちください。`,
          retryAfterSeconds: secs
        });
      }
      console.error('[seedance-start] Aborting: task reservation failed, will not deduct credits or call OpenRouter');
      return res.status(500).json({ ok: false, error: 'タスクの作成に失敗しました。もう一度お試しください。' });
    }
    taskId = taskResult.id;
    console.log('[seedance-start] task created:', taskId, 'user:', user.id, 'mode:', mode);

    // Deduct balance + ledger rows in one DB transaction.
    deduction = await checkAndDeduct(db, user.id, creditCost, taskId);
    if (!deduction.ok) {
      console.error('[seedance-start] credit deduction failed:', deduction.error, 'taskId:', taskId);

      if (deduction.uncertain) {
        // A transport error can arrive after the DB transaction committed.
        // Reconcile atomically before changing the task to a terminal state.
        // If this recovery call also fails, leave the queued task for the
        // existing OpenRouter reconciliation job instead of losing the path.
        let recoveryData = null;
        let recoveryError = null;
        try {
          const recoveryResult = await db.rpc('refund_generation_task_atomic', {
            p_task_id: taskId,
            p_error_message: 'Generation credit deduction result was uncertain'
          });
          recoveryData = recoveryResult.data;
          recoveryError = recoveryResult.error;
        } catch (error) {
          recoveryError = error;
        }

        const recoveryConfirmed = !recoveryError
          && recoveryData?.ok === true
          && ['refunded', 'already_refunded', 'no_charge_found'].includes(recoveryData.code);
        const refunded = recoveryConfirmed
          && (recoveryData.code === 'refunded' || recoveryData.code === 'already_refunded');

        if (!recoveryConfirmed) {
          console.error(
            '[seedance-start] CRITICAL: uncertain deduction recovery failed, taskId:',
            taskId,
            'code:',
            recoveryData?.code,
            'error:',
            recoveryError?.message || recoveryError || null
          );
        }

        return res.status(recoveryConfirmed ? 409 : 500).json({
          ok: false,
          error: 'credit_deduction_unconfirmed',
          message: recoveryConfirmed
            ? (refunded
              ? '生成は開始されず、クレジットを返還しました。もう一度お試しください。'
              : 'クレジット控除を確認できなかったため、生成を開始しませんでした。もう一度お試しください。')
            : REFUND_UNCONFIRMED_MESSAGE,
          refunded,
          creditRefunded: refunded ? creditCost : 0
        });
      }

      await releaseTask(db, user.id, taskId, 'cancelled');
      return res.status(deduction.insufficient ? 402 : 409).json({
        ok: false,
        error: deduction.error,
        balance: deduction.balance,
        required: deduction.required
      });
    }

    // Keep the user's original prompt in the task/history. Seedance 2.5 receives
    // an internal audio-only constraint at the provider boundary so its native
    // audio does not invent music that may trigger output copyright checks.
    const providerPrompt = buildProviderPrompt({ model, prompt, generateAudio: true, hasReferenceAudio: signedAudio.urls.length > 0 });

    const frameImages = Array.isArray(body.frame_images) ? body.frame_images : [];
    const inputReferences = Array.isArray(body.input_references) ? body.input_references : [];
    const firstFrameUrl = String(body.first_frame_url || '').trim();
    const referenceUrl = String(body.reference_url || '').trim();
    const referenceUrls = imageObjects(body.reference_urls || body.referenceUrls || []);

    // Keep the existing OpenRouter request shape for 480p/720p. Seedance 2.5
    // at 1080p uses WaveSpeed's dedicated Turbo request shape.
    const payload = provider === 'wavespeed'
      ? buildWaveSpeedPayload({
          providerPrompt,
          duration,
          resolution,
          aspectRatio,
          mode,
          frameImages,
          inputReferences,
          firstFrameUrl,
          referenceUrl,
          referenceUrls,
          referenceAudioUrls: signedAudio.urls
        })
      : {
          model,
          prompt: providerPrompt,
          duration,
          resolution,
          aspect_ratio: aspectRatio,
          generate_audio: true
        };

    if (provider !== 'wavespeed') {
      if (frameImages.length) payload.frame_images = frameImages;
      else if (firstFrameUrl) payload.frame_images = [imageObject(firstFrameUrl, 'first_frame')].filter(Boolean);

      if (!payload.frame_images?.length) {
        if (inputReferences.length) payload.input_references = inputReferences;
        else if (referenceUrls.length) payload.input_references = referenceUrls;
        else if (referenceUrl) payload.input_references = [imageObject(referenceUrl)].filter(Boolean);
      }
    }

    // Final check at the external-send boundary. If the stop was activated
    // after reservation/deduction, restore the exact credit pools and mark the
    // task failed in one idempotent DB transaction before returning.
    const preSendControl = await checkGenerationControl(db);
    if (!preSendControl.ok) {
      let refundData = null;
      let refundError = null;
      try {
        const refundResult = await db.rpc('refund_generation_task_atomic', {
          p_task_id: taskId,
          p_error_message: 'Generation stopped before provider submission'
        });
        refundData = refundResult.data;
        refundError = refundResult.error;
      } catch (error) {
        refundError = error;
      }

      const refundConfirmed = !refundError
        && refundData?.ok === true
        && (refundData.code === 'refunded' || refundData.code === 'already_refunded');
      if (!refundConfirmed) {
        // Keep the task queued. The OpenRouter reconciliation job can retry the
        // same atomic refund instead of losing the recovery path.
        console.error(
          '[seedance-start] CRITICAL: emergency-stop refund unconfirmed, taskId:',
          taskId,
          'code:',
          refundData?.code,
          'error:',
          refundError?.message || refundError || null
        );
      }

      return res.status(refundConfirmed ? preSendControl.status : 500).json({
        ...preSendControl.body,
        message: refundConfirmed ? preSendControl.body.message : REFUND_UNCONFIRMED_MESSAGE,
        refunded: refundConfirmed,
        creditRefunded: refundConfirmed ? creditCost : 0
      });
    }

    // reserve_generation_task/deduct_generation_credits_atomic initially store
    // openrouter. Switch only the 1080p task before any WaveSpeed request so the
    // OpenRouter reconciler can never claim it.
    if (provider === 'wavespeed') {
      const { data: providerRows, error: providerError } = await db.from('generation_tasks')
        .update({ api_provider: 'wavespeed', updated_at: new Date().toISOString() })
        .eq('id', taskId)
        .eq('user_id', user.id)
        .in('status', ['queued', 'processing'])
        .eq('api_provider', 'openrouter')
        .select('id');
      if (providerError || !providerRows || providerRows.length !== 1) {
        const refundResult = await db.rpc('refund_generation_task_atomic', {
          p_task_id: taskId,
          p_error_message: 'WaveSpeed provider routing could not be persisted'
        });
        const refunded = !refundResult.error && refundResult.data?.ok === true
          && ['refunded', 'already_refunded'].includes(refundResult.data.code);
        return res.status(refunded ? 503 : 500).json({
          ok: false,
          error: 'wavespeed_provider_persist_failed',
          message: refunded ? '生成を開始できなかったため、クレジットを返還しました。' : REFUND_UNCONFIRMED_MESSAGE,
          refunded,
          creditRefunded: refunded ? creditCost : 0
        });
      }
    }

    const providerModel = mode === 'image_to_video' ? WAVESPEED_IMAGE_MODEL : WAVESPEED_TEXT_MODEL;
    const providerEndpoint = provider === 'wavespeed'
      ? `${WAVESPEED_API_BASE}/${providerModel}`
      : OPENROUTER_VIDEO_ENDPOINT;
    console.log('[seedance-start] calling provider, provider:', provider, 'taskId:', taskId, 'mode:', mode);
    orStarted = true;
    let response, text, data;
    try {
      response = await fetch(providerEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(provider === 'openrouter' ? {
            'HTTP-Referer': 'https://flowvid-studio.vercel.app',
            'X-Title': 'FlowVid Studio'
          } : {})
        },
        body: JSON.stringify(payload)
      });
      text = await response.text();
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    } catch (fetchError) {
      console.error('[seedance-start] provider network error:', fetchError?.message, 'provider:', provider, 'taskId:', taskId);
      let refunded = false;
      if (provider === 'wavespeed') {
        const refundResult = await db.rpc('refund_generation_task_atomic', { p_task_id: taskId, p_error_message: fetchError?.message || 'WaveSpeed network error' });
        refunded = !refundResult.error && refundResult.data?.ok === true && ['refunded', 'already_refunded'].includes(refundResult.data.code);
      } else {
        const refundResult = await refundCredits(db, user.id, deduction, taskId);
        await releaseTask(db, user.id, taskId, 'failed', fetchError?.message || 'Network error');
        refunded = refundResult.ok;
      }
      return res.status(502).json({
        ok: false,
        error: fetchError?.message || `${provider} request failed`,
        creditRefunded: refunded ? creditCost : 0,
        refunded,
        checkedAt: new Date().toISOString()
      });
    }

    if (!response.ok) {
      const rawBody = String(text || '');
      console.error('[seedance-start] provider error body:', provider, response.status, rawBody.slice(0, 500));
      let refunded = false;
      if (provider === 'wavespeed') {
        const refundResult = await db.rpc('refund_generation_task_atomic', { p_task_id: taskId, p_error_message: `WaveSpeed ${response.status}: ${rawBody.slice(0, 200)}` });
        refunded = !refundResult.error && refundResult.data?.ok === true && ['refunded', 'already_refunded'].includes(refundResult.data.code);
      } else {
        const refundResult = await refundCredits(db, user.id, deduction, taskId);
        await releaseTask(db, user.id, taskId, 'failed', `OpenRouter ${response.status}: ${rawBody.slice(0, 200)}`);
        refunded = refundResult.ok;
      }
      const classified = classifyProviderError(rawBody, response.status);
      const orMsg = PROVIDER_ERROR_MESSAGES[classified.category]
        || (response.status === 403
          ? 'APIキーが無効か、モデルへのアクセス権がありません（HTTP 403）'
          : response.status === 429
          ? 'リクエストが多すぎます。しばらくしてからお試しください（HTTP 429）'
          : `生成に失敗しました（HTTP ${response.status}）`);
      console.log('[seedance-start] provider error classified:', classified.category, 'code:', classified.code, 'taskId:', taskId);
      return res.status(502).json({
        ok: false,
        error: orMsg,
        errorCategory: classified.category,
        providerErrorCode: classified.code,
        error_detail: rawBody.slice(0, 1000),
        openrouterStatus: response.status,
        creditRefunded: refunded ? creditCost : 0,
        refunded,
        checkedAt: new Date().toISOString()
      });
    }

    const jobId = extractJobId(data);
    const orPollingUrl = provider === 'wavespeed' && jobId
      ? `${WAVESPEED_API_BASE}/predictions/${encodeURIComponent(jobId)}/result`
      : (data?.polling_url || data?.pollingUrl || null);
    console.log('[seedance-start] OR response keys:', Object.keys(data && typeof data === 'object' ? data : {}));
    console.log('[seedance-start] OR response preview:', JSON.stringify(data).slice(0, 600));
    console.log('[seedance-start] OpenRouter accepted, jobId:', jobId, 'pollingUrl:', orPollingUrl, 'taskId:', taskId);

    if (!jobId && !orPollingUrl) {
      console.error('[seedance-start] OpenRouter 200 but no jobId or pollingUrl — cannot track job, refunding', 'taskId:', taskId);
      let refunded = false;
      if (provider === 'wavespeed') {
        const refundResult = await db.rpc('refund_generation_task_atomic', { p_task_id: taskId, p_error_message: 'WaveSpeed response missing prediction id' });
        refunded = !refundResult.error && refundResult.data?.ok === true && ['refunded', 'already_refunded'].includes(refundResult.data.code);
      } else {
        const refundResult = await refundCredits(db, user.id, deduction, taskId);
        await releaseTask(db, user.id, taskId, 'failed');
        refunded = refundResult.ok;
      }
      return res.status(502).json({
        ok: false,
        error: 'OpenRouterから有効なジョブIDが返されませんでした。もう一度お試しください。',
        creditRefunded: refunded ? creditCost : 0,
        refunded,
        checkedAt: new Date().toISOString()
      });
    }

    // Persist tracking info (status, api_task_id, polling_url) in one UPDATE.
    // Retry up to 3 attempts total. Condition: row must still be active (queued or processing).
    let trackingPersisted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data: updRows, error: updErr } = await db.from('generation_tasks')
          .update({
            status: 'processing',
            api_task_id: jobId || null,
            polling_url: orPollingUrl || null,
            api_provider: provider,
            updated_at: new Date().toISOString()
          })
          .eq('id', taskId)
          .eq('user_id', user.id)
          .in('status', ['queued', 'processing'])
          .select('id');
        if (updErr) {
          console.error('[seedance-start] tracking persist attempt', attempt, 'DB error:', updErr.message, 'taskId:', taskId);
        } else if (!updRows || updRows.length === 0) {
          console.error('[seedance-start] tracking persist attempt', attempt, 'no rows updated', 'taskId:', taskId);
        } else {
          console.log('[seedance-start] tracking persisted on attempt', attempt, 'taskId:', taskId);
          trackingPersisted = true;
          break;
        }
      } catch (persistErr) {
        console.error('[seedance-start] tracking persist attempt', attempt, 'exception:', persistErr?.message, 'taskId:', taskId);
      }
    }

    if (!trackingPersisted) {
      // Final fallback: relax the status filter (still scoped to id+user_id) in case
      // the row's status drifted between reservation and this point.
      try {
        const { data: fallbackRows, error: fallbackErr } = await db.from('generation_tasks')
          .update({
            status: 'processing',
            api_task_id: jobId || null,
            polling_url: orPollingUrl || null,
            api_provider: provider,
            updated_at: new Date().toISOString()
          })
          .eq('id', taskId)
          .eq('user_id', user.id)
          .select('id');
        if (!fallbackErr && fallbackRows && fallbackRows.length > 0) {
          trackingPersisted = true;
          console.log('[seedance-start] tracking persisted via fallback (status filter relaxed), taskId:', taskId);
        }
      } catch (fallbackException) {
        console.error('[seedance-start] fallback tracking persist exception:', fallbackException?.message, 'taskId:', taskId);
      }
    }

    if (!trackingPersisted) {
      console.error(
        '[seedance-start] ORPHAN_TASK tracking persistence FAILED after all attempts — provider started, not refunding here (reconcile job will handle)',
        'userId:', user.id, 'taskId:', taskId, 'jobId:', jobId, 'pollingUrl:', orPollingUrl
      );
      return res.status(503).json({
        ok: false,
        error: 'generation_tracking_persistence_failed',
        message: '動画生成は開始されましたが、生成情報の保存に失敗しました。再度生成せず、サポートへお問い合わせください。',
        providerStarted: true,
        taskId,
        jobId,
        pollingUrl: orPollingUrl
      });
    }

    return res.status(202).json({
      ok: true,
      status: response.status,
      provider,
      model,
      jobId,
      pollingUrl: orPollingUrl,
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
    console.error('[seedance-start] unexpected error:', error?.message, 'taskId:', taskId, 'orStarted:', orStarted);
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

module.exports._test = { buildWaveSpeedPayload };
