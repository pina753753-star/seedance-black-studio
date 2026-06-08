const { createClient } = require('@supabase/supabase-js');

const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';
const HISTORY_TABLE = 'flowvid_video_history';
const CREDIT_RATE = 110;

// ---- cost-based credit settlement ----

function extractCostUsd(data) {
  if (!data || typeof data !== 'object') return null;
  for (const key of ['cost', 'cost_usd', 'total_cost']) {
    const v = Number(data[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  if (data.usage && typeof data.usage === 'object') {
    for (const key of ['cost', 'total_cost', 'cost_usd']) {
      const v = Number(data.usage[key]);
      if (Number.isFinite(v) && v > 0) return v;
    }
  }
  for (const key of ['response', 'data']) {
    if (data[key] && typeof data[key] === 'object') {
      const found = extractCostUsd(data[key]);
      if (found) return found;
    }
  }
  return null;
}

// Refund delta back to subscription_credits (highest-priority pool).
async function creditDeltaRefund(db, userId, taskId, amount) {
  if (amount <= 0) return;
  try {
    const { data: bal } = await db.from('credit_balances')
      .select('subscription_credits').eq('user_id', userId).maybeSingle();
    if (!bal) return;
    await db.from('credit_balances').update({
      subscription_credits: Number(bal.subscription_credits || 0) + amount,
      updated_at: new Date().toISOString()
    }).eq('user_id', userId);
    await db.from('credit_transactions').insert({
      user_id: userId, amount, credit_type: 'subscription',
      reason: 'cost_based_refund', related_task_id: taskId
    });
  } catch (_) {}
}

// Charge additional delta. Returns shortfall (0 if fully charged).
async function creditDeltaCharge(db, userId, taskId, amount) {
  if (amount <= 0) return 0;
  try {
    const { data: bal } = await db.from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', userId).maybeSingle();
    if (!bal) return amount;

    const sub = Number(bal.subscription_credits || 0);
    const free = Number(bal.free_credits || 0);
    const purch = Number(bal.purchased_credits || 0);
    const available = sub + free + purch;
    const charge = Math.min(amount, available);
    const shortfall = amount - charge;

    if (charge > 0) {
      let rem = charge;
      const fromSub = Math.min(rem, sub); rem -= fromSub;
      const fromFree = Math.min(rem, free); rem -= fromFree;
      const fromPurch = Math.min(rem, purch);
      await db.from('credit_balances').update({
        subscription_credits: sub - fromSub,
        free_credits: free - fromFree,
        purchased_credits: purch - fromPurch,
        updated_at: new Date().toISOString()
      }).eq('user_id', userId);
      const txRows = [];
      if (fromSub > 0) txRows.push({ user_id: userId, amount: -fromSub, credit_type: 'subscription', reason: 'cost_based_adjustment', related_task_id: taskId });
      if (fromFree > 0) txRows.push({ user_id: userId, amount: -fromFree, credit_type: 'free', reason: 'cost_based_adjustment', related_task_id: taskId });
      if (fromPurch > 0) txRows.push({ user_id: userId, amount: -fromPurch, credit_type: 'purchased', reason: 'cost_based_adjustment', related_task_id: taskId });
      if (txRows.length) await db.from('credit_transactions').insert(txRows);
    }
    if (shortfall > 0) {
      // Log shortfall; do NOT go negative
      await db.from('credit_transactions').insert({
        user_id: userId, amount: -shortfall, credit_type: 'purchased',
        reason: 'cost_based_shortfall', related_task_id: taskId
      }).catch(() => {});
    }
    return shortfall;
  } catch (_) {
    return amount;
  }
}

// Atomically claims the completed task, settles the credit delta, and
// writes credit metadata to flowvid_video_history.settings.
async function processFinalCredits(db, resolvedJobId, costUsd, videoUrl) {
  if (!db || !resolvedJobId) return null;
  try {
    const { data: task } = await db
      .from('generation_tasks')
      .select('id,user_id,credit_cost,status,prompt,mode')
      .eq('api_task_id', resolvedJobId)
      .in('status', ['queued', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!task) return null;

    // Atomic claim — prevents double-settlement on concurrent polls
    const { data: claimed } = await db
      .from('generation_tasks')
      .update({ status: 'completed', output_url: videoUrl, updated_at: new Date().toISOString() })
      .eq('id', task.id)
      .in('status', ['queued', 'processing', 'completed'])
      .select('id');
    if (!claimed || claimed.length === 0) return null;

    const estimatedCredits = Number(task.credit_cost || 0);
    const finalCredits = (costUsd != null && Number.isFinite(Number(costUsd)) && Number(costUsd) > 0)
      ? Math.ceil(Number(costUsd) * CREDIT_RATE)
      : estimatedCredits;
    const delta = finalCredits - estimatedCredits;
    let shortfall = 0;

    if (delta < 0) {
      await creditDeltaRefund(db, task.user_id, task.id, Math.abs(delta));
    } else if (delta > 0) {
      shortfall = await creditDeltaCharge(db, task.user_id, task.id, delta);
    }

    const taskPrompt = String(task.prompt || '').trim();
    const creditMeta = {
      estimated_credits: estimatedCredits,
      final_credits: finalCredits,
      cost_usd: costUsd ?? null,
      credit_rate: CREDIT_RATE,
      pricing_mode: 'cost_based',
      shortfall: shortfall || 0,
      settled_at: new Date().toISOString()
    };
    if (taskPrompt) creditMeta.prompt = taskPrompt;

    // Merge into flowvid_video_history.settings (read-then-write to avoid clobbering)
    if (videoUrl) {
      const { data: existing } = await db.from(HISTORY_TABLE)
        .select('settings,prompt').eq('job_id', resolvedJobId).maybeSingle();
      const merged = { ...(existing?.settings || {}), ...creditMeta };
      const row = { job_id: resolvedJobId, settings: merged, updated_at: new Date().toISOString() };
      // Always persist the prompt column so reference-mode history keeps the input prompt
      if (taskPrompt) row.prompt = taskPrompt;
      else if (existing?.prompt) row.prompt = existing.prompt;
      if (task.mode) row.mode = task.mode;
      await db.from(HISTORY_TABLE).upsert(row, { onConflict: 'job_id' });
    }

    return { estimatedCredits, finalCredits, costUsd, delta, shortfall, userId: task.user_id };
  } catch (_) {
    return null;
  }
}

// ---- end cost-based settlement ----

function dbClient() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

function isStatusEndpointUrl(url) {
  const value = String(url || '');
  return /^https?:\/\/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/?(?:[?#].*)?$/i.test(value);
}

function isOpenRouterContentUrl(url) {
  return /^https?:\/\/openrouter\.ai\/api\/v1\/videos\/[^/?#]+\/content(?:\?|$)/i.test(String(url || ''));
}

function findVideoUrl(value, keyName = '') {
  if (!value) return null;

  if (typeof value === 'string') {
    const url = value.trim();
    if (!/^https?:\/\//i.test(url)) return null;

    if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) return url;
    if (isOpenRouterContentUrl(url)) return url;

    const keyLooksLikeVideo = /(videoUrl|video_url|output_url|download_url|file_url|asset_url|signed_url|signed_urls|unsigned_url|unsigned_urls|play_url|url)$/i.test(keyName || '');
    const urlLooksDownloadable = /(download|output|storage|cdn|signed|play|file|asset|content\?index=)/i.test(url);

    if (isStatusEndpointUrl(url) && !/\.(mp4|mov|webm)(\?|$)/i.test(url)) return null;
    if (keyLooksLikeVideo && urlLooksDownloadable) return url;

    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item, keyName);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    const priorityKeys = ['videoUrl', 'video_url', 'output_url', 'download_url', 'file_url', 'asset_url', 'signed_url', 'signed_urls', 'unsigned_url', 'unsigned_urls', 'play_url'];
    for (const key of priorityKeys) {
      const found = findVideoUrl(value[key], key);
      if (found) return found;
    }
    for (const key of Object.keys(value)) {
      const found = findVideoUrl(value[key], key);
      if (found) return found;
    }
  }

  return null;
}

function normalizeStatus(data) {
  return String(data?.status || data?.data?.status || data?.response?.status || data?.result?.status || '').toLowerCase();
}

function isCompletedStatus(status) {
  return ['completed', 'complete', 'succeeded', 'success', 'done'].includes(String(status || '').toLowerCase());
}

function isFailedStatus(status) {
  return ['failed', 'error', 'cancelled', 'canceled'].includes(String(status || '').toLowerCase());
}

// Looks up the generation_tasks record for this OpenRouter job, atomically marks
// it as failed (preventing concurrent calls from double-refunding), then refunds
// each credit pool back to where the credits were originally deducted from.
async function processRefundIfNeeded(db, jobId, jobStatus, errorMessage) {
  if (!db || !jobId || !isFailedStatus(jobStatus)) return;

  // Find the task — only eligible if still in a non-terminal state
  const { data: task } = await db
    .from('generation_tasks')
    .select('id,user_id,credit_cost,status')
    .eq('api_task_id', jobId)
    .in('status', ['queued', 'processing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!task) return; // Not found, already terminal, or no matching task

  // Atomic claim: update status to 'failed' only if still in non-terminal state.
  // If a concurrent polling call already claimed it, 0 rows are returned → skip.
  const { data: claimed } = await db
    .from('generation_tasks')
    .update({ status: 'failed', error_message: errorMessage || null, updated_at: new Date().toISOString() })
    .eq('id', task.id)
    .in('status', ['queued', 'processing'])
    .select('id');

  if (!claimed || claimed.length === 0) return; // Already handled by another request

  // Reconstruct deduction breakdown from credit_transactions
  const { data: deductions } = await db
    .from('credit_transactions')
    .select('credit_type,amount')
    .eq('related_task_id', task.id)
    .eq('reason', 'video_generation');

  if (!deductions || deductions.length === 0) return; // Nothing to refund

  let fromSub = 0, fromFree = 0, fromPurchased = 0;
  for (const tx of deductions) {
    const amount = Math.abs(Number(tx.amount || 0));
    if (tx.credit_type === 'subscription') fromSub += amount;
    else if (tx.credit_type === 'free') fromFree += amount;
    else if (tx.credit_type === 'purchased') fromPurchased += amount;
  }

  if (fromSub + fromFree + fromPurchased === 0) return;

  // Read current balance and add back to each pool
  const { data: bal } = await db
    .from('credit_balances')
    .select('free_credits,subscription_credits,purchased_credits')
    .eq('user_id', task.user_id)
    .maybeSingle();

  if (!bal) return;

  const updateFields = { updated_at: new Date().toISOString() };
  if (fromSub > 0) updateFields.subscription_credits = Number(bal.subscription_credits || 0) + fromSub;
  if (fromFree > 0) updateFields.free_credits = Number(bal.free_credits || 0) + fromFree;
  if (fromPurchased > 0) updateFields.purchased_credits = Number(bal.purchased_credits || 0) + fromPurchased;
  await db.from('credit_balances').update(updateFields).eq('user_id', task.user_id);

  // Record per-pool refund transactions
  const txRows = [];
  if (fromSub > 0) txRows.push({ user_id: task.user_id, amount: fromSub, credit_type: 'subscription', reason: 'generation_refund', related_task_id: task.id });
  if (fromFree > 0) txRows.push({ user_id: task.user_id, amount: fromFree, credit_type: 'free', reason: 'generation_refund', related_task_id: task.id });
  if (fromPurchased > 0) txRows.push({ user_id: task.user_id, amount: fromPurchased, credit_type: 'purchased', reason: 'generation_refund', related_task_id: task.id });
  if (txRows.length) await db.from('credit_transactions').insert(txRows);
}

function extFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('quicktime') || type.includes('mov')) return 'mov';
  return 'mp4';
}

function isSupabasePublicUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && String(url || '').includes('/storage/v1/object/public/');
}

function isOpenRouterUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && String(url || '').includes('openrouter.ai');
}

function effectiveJobId({ jobId, pollingUrl, rawVideoUrl }) {
  if (jobId) return jobId;

  for (const url of [pollingUrl, rawVideoUrl]) {
    try {
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const parsed = new URL(url);
      const queryId = parsed.searchParams.get('id') || parsed.searchParams.get('jobId') || parsed.searchParams.get('job_id');
      if (queryId) return String(queryId).trim();

      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const pathId = pathParts[pathParts.length - 1];
      if (pathId && !/^(download|output|video|file|public|content)$/i.test(pathId)) return pathId;
    } catch (_) {
      // Ignore malformed URLs and fall back below.
    }
  }

  return `video-${Date.now()}`;
}

function openRouterContentUrl(id) {
  const clean = String(id || '').trim();
  if (!clean) return null;
  return `${OPENROUTER_VIDEO_ENDPOINT}/${encodeURIComponent(clean)}/content`;
}

async function verifyPublicObject(publicUrl) {
  try {
    const response = await fetch(publicUrl, { method: 'GET' });
    const contentType = response.headers.get('content-type') || '';
    const bytes = Number(response.headers.get('content-length') || 0);
    const body = await response.arrayBuffer();
    const actualBytes = body.byteLength;

    if (!response.ok) {
      return { ok: false, status: response.status, contentType, bytes: actualBytes, error: 'public-url-not-readable' };
    }
    if (actualBytes < 1024) {
      return { ok: false, status: response.status, contentType, bytes: actualBytes, error: 'stored-file-too-small' };
    }
    if (!/video|octet-stream/i.test(contentType)) {
      return { ok: false, status: response.status, contentType, bytes: actualBytes || bytes, error: 'stored-file-is-not-video' };
    }

    return { ok: true, status: response.status, contentType, bytes: actualBytes || bytes };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function persistVideo({ jobId, videoUrl, apiKey }) {
  if (!videoUrl) {
    return { ok: false, videoUrl, error: 'No video URL found yet' };
  }

  if (isStatusEndpointUrl(videoUrl)) {
    return { ok: false, videoUrl, error: 'OpenRouter status URL is not a downloadable video yet' };
  }

  if (isSupabasePublicUrl(videoUrl)) {
    const publicCheck = await verifyPublicObject(videoUrl);
    return publicCheck.ok
      ? { ok: true, videoUrl, skipped: true, reason: 'already-persistent', publicCheck }
      : { ok: false, videoUrl, error: 'Existing public URL is not readable as video', publicCheck };
  }

  const db = dbClient();
  if (!db) return { ok: false, videoUrl, error: 'Missing Supabase key' };

  const headers = isOpenRouterUrl(videoUrl) ? { Authorization: `Bearer ${apiKey}` } : {};
  const upstream = await fetch(videoUrl, { method: 'GET', headers });
  const contentType = upstream.headers.get('content-type') || '';

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return { ok: false, videoUrl, error: `Video download failed: ${upstream.status}`, contentType, details: text.slice(0, 500) };
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.length < 1024 || !/video|octet-stream/i.test(contentType)) {
    return { ok: false, videoUrl, error: 'Downloaded file is not a valid video', contentType, bytes: buffer.length, preview: buffer.toString('utf8', 0, Math.min(buffer.length, 300)) };
  }

  const ext = extFromContentType(contentType);
  const safeJobId = String(jobId || Date.now()).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  const path = `generated-videos/${safeJobId}.${ext}`;

  const upload = await db.storage.from(VIDEO_BUCKET).upload(path, buffer, { contentType, cacheControl: '31536000', upsert: true });
  if (upload.error) return { ok: false, videoUrl, error: upload.error.message, bucket: VIDEO_BUCKET, path };

  const { data } = db.storage.from(VIDEO_BUCKET).getPublicUrl(path);
  const publicUrl = data?.publicUrl || videoUrl;
  const publicCheck = await verifyPublicObject(publicUrl);
  if (!publicCheck.ok) return { ok: false, videoUrl: publicUrl, originalUrl: videoUrl, error: 'Uploaded object is not publicly readable as video', bucket: VIDEO_BUCKET, path, publicCheck };

  let historySave = { ok: true };
  try {
    const { error } = await db.from(HISTORY_TABLE).upsert(
      { job_id: jobId, status: 'completed', video_url: publicUrl, updated_at: new Date().toISOString() },
      { onConflict: 'job_id' }
    );
    if (error) historySave = { ok: false, error: error.message };
  } catch (error) {
    historySave = { ok: false, error: error?.message || String(error) };
  }

  return { ok: true, videoUrl: publicUrl, originalUrl: videoUrl, bucket: VIDEO_BUCKET, path, contentType, bytes: buffer.length, publicCheck, historySave };
}

module.exports = async function handler(req, res) {
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'Missing OPENROUTER_API_KEY' });

  const jobId = String(req.query.id || req.query.jobId || '').trim();
  const pollingUrl = String(req.query.pollingUrl || req.query.polling_url || '').trim();

  if (!jobId && !pollingUrl) {
    return res.status(400).json({
      ok: false,
      error: 'id or pollingUrl query parameter is required',
      example: '/api/seedance-status?id=video_job_id&pollingUrl=https://...'
    });
  }

  const statusUrl = pollingUrl || `${OPENROUTER_VIDEO_ENDPOINT}/${encodeURIComponent(jobId)}`;

  try {
    const response = await fetch(statusUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://flowvid-studio.vercel.app',
        'X-Title': 'FlowVid Studio'
      }
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

    const jobStatus = normalizeStatus(data);
    const foundVideoUrl = findVideoUrl(data);
    const resolvedJobId = effectiveJobId({ jobId, pollingUrl, rawVideoUrl: foundVideoUrl });
    const fallbackContentUrl = !foundVideoUrl && isCompletedStatus(jobStatus) ? openRouterContentUrl(resolvedJobId) : null;
    const rawVideoUrl = foundVideoUrl || fallbackContentUrl;
    let videoUrl = null;
    let storage = null;

    if (rawVideoUrl) {
      storage = await persistVideo({ jobId: resolvedJobId, videoUrl: rawVideoUrl, apiKey });
      if (storage?.ok && storage.videoUrl) videoUrl = storage.videoUrl;
    }

    const done = Boolean(videoUrl);

    // Settle final credits on successful completion (once, via atomic task claim)
    const costUsd = extractCostUsd(data);
    let finalCreditsResult = null;
    if (done) {
      finalCreditsResult = await processFinalCredits(dbClient(), resolvedJobId, costUsd, videoUrl).catch(() => null);
    }

    // Apply watermark for free users on successful completion
    if (done && videoUrl) {
      try {
        const db2 = dbClient();
        if (db2) {
          const wmUserId = finalCreditsResult?.userId || (await db2
            .from('generation_tasks')
            .select('user_id')
            .eq('api_task_id', resolvedJobId)
            .maybeSingle()
          ).data?.user_id;
          console.log('[watermark] done:', done, 'resolvedJobId:', resolvedJobId, 'wmUserId:', wmUserId, 'WATERMARK_SERVER_URL:', process.env.WATERMARK_SERVER_URL);
          if (!wmUserId) {
            console.log('[watermark] SKIP: wmUserId is null/undefined. resolvedJobId used for lookup:', resolvedJobId);
          }
          if (wmUserId) {
            const PAID_PLANS = ['standard'];
            const { data: profile } = await db2
              .from('profiles')
              .select('plan')
              .eq('id', wmUserId)
              .maybeSingle();
            const isFreeUser = !profile || !PAID_PLANS.includes(profile.plan);
            console.log('[watermark] profile:', JSON.stringify(profile), 'isFreeUser:', isFreeUser);
            if (isFreeUser) {
              const wmUrl = `${process.env.WATERMARK_SERVER_URL}/watermark`;
              console.log('[watermark] sending request to:', wmUrl);
              const wmRes = await fetch(wmUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${process.env.WATERMARK_SECRET || ''}`
                },
                body: JSON.stringify({ videoUrl, jobId: resolvedJobId })
              });
              console.log('[watermark] wmRes.status:', wmRes.status, 'wmRes.ok:', wmRes.ok);
              if (wmRes.ok) {
                const wmData = await wmRes.json();
                console.log('[watermark] wmData:', JSON.stringify(wmData));
                if (wmData?.watermarkedUrl) {
                  await db2.from(HISTORY_TABLE).upsert(
                    { job_id: resolvedJobId, watermarked_url: wmData.watermarkedUrl, updated_at: new Date().toISOString() },
                    { onConflict: 'job_id' }
                  );
                  await db2.from('generation_tasks').update(
                    { watermarked_url: wmData.watermarkedUrl, updated_at: new Date().toISOString() }
                  ).eq('api_task_id', resolvedJobId);
                }
              } else {
                const wmErrText = await wmRes.text().catch(() => '');
                console.log('[watermark] error response:', wmErrText.slice(0, 300));
              }
            }
          }
        }
      } catch (wmErr) {
        console.log('[watermark] caught error:', wmErr?.message || String(wmErr));
      }
    }

    // Refund credits on terminal failure:
    // - response.ok + isFailedStatus: OpenRouter confirmed the job failed
    // - response.status === 404: job not found; client treats ≥400 as failed
    //   and stops polling, so this is the only chance to refund
    const terminalFailure = (response.ok && isFailedStatus(jobStatus)) || response.status === 404;
    if (terminalFailure && !done) {
      const orErrorMsg = (data && typeof data === 'object') ? (data.error || data.message || JSON.stringify(data).slice(0, 200)) : String(data || '').slice(0, 200);
      await processRefundIfNeeded(dbClient(), resolvedJobId, 'failed', orErrorMsg).catch(() => {});
    }

    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      status: response.status,
      provider: 'openrouter',
      jobId: resolvedJobId,
      originalJobId: jobId,
      pollingUrl,
      statusUrl,
      jobStatus,
      done,
      videoUrl,
      costUsd: costUsd ?? null,
      finalCredits: finalCreditsResult?.finalCredits ?? null,
      estimatedCredits: finalCreditsResult?.estimatedCredits ?? null,
      storage: storage ? { ...storage, rawVideoUrl, usedFallbackContentUrl: Boolean(fallbackContentUrl) } : null,
      response: data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error', statusUrl, checkedAt: new Date().toISOString() });
  }
};