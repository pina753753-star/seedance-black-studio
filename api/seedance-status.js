const { createClient } = require('@supabase/supabase-js');

const OPENROUTER_VIDEO_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';
const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';
const HISTORY_TABLE = 'flowvid_video_history';
const CREDIT_RATE = 110;
const RESULT_WAIT_MIN_MS = 5 * 60 * 1000;
const RESULT_WAIT_MIN_ATTEMPTS = 5;
const RESULT_ATTEMPT_MIN_INTERVAL_MS = 10 * 1000;

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

// Refund delta back to the pools it was originally consumed from, in reverse
// consumption order (purchased → free → subscription).
// Only video_generation transactions with negative amounts are used to reconstruct
// the original breakdown; any other reason is excluded.
// If the breakdown cannot be determined, the balance is left unchanged.
async function creditDeltaRefund(db, userId, taskId, amount) {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) return;

  // Reconstruct original consumption breakdown from credit_transactions
  const { data: origTx, error: txError } = await db
    .from('credit_transactions')
    .select('credit_type,amount')
    .eq('related_task_id', taskId)
    .eq('reason', 'video_generation');

  if (txError || !origTx || origTx.length === 0) {
    console.warn('[seedance-status] credit_delta_refund_skipped', {
      taskId,
      reason: 'usage_breakdown_unavailable'
    });
    return;
  }

  // Accumulate per-pool consumption (negative amounts only)
  let usedSub = 0, usedFree = 0, usedPurchased = 0;
  for (const tx of origTx) {
    const a = Number(tx.amount || 0);
    if (!Number.isFinite(a) || a >= 0) continue; // skip non-negative rows
    const abs = Math.abs(a);
    if (tx.credit_type === 'subscription') usedSub      += abs;
    else if (tx.credit_type === 'free')    usedFree     += abs;
    else if (tx.credit_type === 'purchased') usedPurchased += abs;
  }

  const usedTotal = usedSub + usedFree + usedPurchased;
  if (usedTotal === 0) {
    console.warn('[seedance-status] credit_delta_refund_skipped', {
      taskId,
      reason: 'usage_breakdown_unavailable'
    });
    return;
  }

  // Guard: refund must not exceed what was originally consumed
  if (amount > usedTotal) {
    console.warn('[seedance-status] credit_delta_refund_skipped', {
      taskId,
      reason: 'usage_breakdown_unavailable'
    });
    return;
  }

  // Distribute refund in reverse consumption order: purchased → free → subscription
  let remaining = amount;
  const refundPurchased    = Math.min(remaining, usedPurchased); remaining -= refundPurchased;
  const refundFree         = Math.min(remaining, usedFree);      remaining -= refundFree;
  const refundSubscription = Math.min(remaining, usedSub);       remaining -= refundSubscription;

  // Integrity check: remaining must be 0 after distribution
  if (remaining !== 0) {
    console.warn('[seedance-status] credit_delta_refund_skipped', {
      taskId,
      reason: 'usage_breakdown_unavailable'
    });
    return;
  }

  // Read current balance
  const { data: bal, error: balError } = await db
    .from('credit_balances')
    .select('subscription_credits,free_credits,purchased_credits')
    .eq('user_id', userId)
    .maybeSingle();
  if (balError || !bal) {
    console.warn('[seedance-status] credit_delta_refund_skipped', {
      taskId,
      reason: 'usage_breakdown_unavailable'
    });
    return;
  }

  // Build update payload — only touch pools that receive a refund
  const updateFields = { updated_at: new Date().toISOString() };
  if (refundSubscription > 0) updateFields.subscription_credits = Number(bal.subscription_credits || 0) + refundSubscription;
  if (refundFree         > 0) updateFields.free_credits          = Number(bal.free_credits          || 0) + refundFree;
  if (refundPurchased    > 0) updateFields.purchased_credits     = Number(bal.purchased_credits     || 0) + refundPurchased;

  const { error: updateError } = await db
    .from('credit_balances')
    .update(updateFields)
    .eq('user_id', userId);

  if (updateError) {
    console.warn('[seedance-status] credit_delta_refund_skipped', {
      taskId,
      reason: 'usage_breakdown_unavailable'
    });
    return;
  }

  // Record per-pool refund transactions (only for pools with a positive refund)
  const txRows = [];
  if (refundSubscription > 0) txRows.push({ user_id: userId, amount: refundSubscription, credit_type: 'subscription', reason: 'cost_based_refund', related_task_id: taskId });
  if (refundFree         > 0) txRows.push({ user_id: userId, amount: refundFree,         credit_type: 'free',         reason: 'cost_based_refund', related_task_id: taskId });
  if (refundPurchased    > 0) txRows.push({ user_id: userId, amount: refundPurchased,     credit_type: 'purchased',    reason: 'cost_based_refund', related_task_id: taskId });
  if (txRows.length) await db.from('credit_transactions').insert(txRows);
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
      .select('id,user_id,credit_cost,status,prompt,mode,settings')
      .eq('api_task_id', resolvedJobId)
      .in('status', ['queued', 'processing'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!task) return null;

    // Remove result_wait from settings on successful completion (only if present)
    const settingsUpdate = task.settings && typeof task.settings === 'object' && !Array.isArray(task.settings) && 'result_wait' in task.settings
      ? { settings: (({ result_wait, ...rest }) => rest)(task.settings) }
      : {};

    // Atomic claim — prevents double-settlement on concurrent polls
    const { data: claimed } = await db
      .from('generation_tasks')
      .update({ status: 'completed', output_url: videoUrl, ...settingsUpdate, updated_at: new Date().toISOString() })
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
    .in('reason', ['video_generation', 'cost_based_adjustment']);

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

// ---- result-wait grace period helpers ----

function isResultWaitExpired(wait) {
  if (!wait || !wait.started_at) return false;
  const startedMs = new Date(wait.started_at).getTime();
  if (!Number.isFinite(startedMs)) return false;
  const elapsed = Date.now() - startedMs;
  const attempts = Number(wait.attempts);
  if (!Number.isFinite(attempts) || !Number.isInteger(attempts) || attempts < 0) return false;
  return elapsed >= RESULT_WAIT_MIN_MS && attempts >= RESULT_WAIT_MIN_ATTEMPTS;
}

// Read-modify-write settings.result_wait for a queued/processing task.
// Returns structured state: { state: 'ok'|'not_found'|'db_error'|'stale', taskId?, wait? }
// Only increments attempts and last_attempt_at when ≥10 s have passed (prevents rapid-fire inflation).
// When < 10 s since last attempt: returns current wait state without any DB write.
async function recordResultWait(db, resolvedJobId, reason) {
  if (!db || !resolvedJobId) return { state: 'not_found' };

  const { data: task, error: selectError } = await db
    .from('generation_tasks')
    .select('id,settings')
    .eq('api_task_id', resolvedJobId)
    .in('status', ['queued', 'processing'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (selectError) return { state: 'db_error' };
  if (!task) return { state: 'not_found' };

  const now = new Date().toISOString();
  const existingSettings = task.settings && typeof task.settings === 'object' && !Array.isArray(task.settings)
    ? task.settings : {};
  const existingWait = existingSettings.result_wait && typeof existingSettings.result_wait === 'object' && !Array.isArray(existingSettings.result_wait)
    ? existingSettings.result_wait : {};

  const startedAt = existingWait.started_at || now;
  const lastAttemptAt = existingWait.last_attempt_at || null;
  const msSinceLast = lastAttemptAt ? (Date.now() - new Date(lastAttemptAt).getTime()) : Infinity;
  const currentAttempts = Number(existingWait.attempts || 0);

  if (msSinceLast < RESULT_ATTEMPT_MIN_INTERVAL_MS) {
    // Too soon — return current state without any DB write
    return { state: 'ok', taskId: task.id, wait: existingWait };
  }

  const newAttempts = currentAttempts + 1;
  const newWait = {
    started_at: startedAt,
    attempts: newAttempts,
    last_attempt_at: now,
    last_error: String(reason || 'unknown').slice(0, 100)
  };

  const newSettings = { ...existingSettings, result_wait: newWait };
  const { data: updated, error: updateError } = await db
    .from('generation_tasks')
    .update({ settings: newSettings, updated_at: now })
    .eq('id', task.id)
    .in('status', ['queued', 'processing'])
    .select('id');

  if (updateError) return { state: 'db_error' };
  if (!updated || updated.length === 0) return { state: 'stale', taskId: task.id, wait: existingWait };

  return { state: 'ok', taskId: task.id, wait: newWait };
}

// ---- end result-wait grace period helpers ----

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
    // Try HEAD first to avoid downloading the full video body
    const headRes = await fetch(publicUrl, { method: 'HEAD' });
    const headContentType = headRes.headers.get('content-type') || '';
    const headContentLength = Number(headRes.headers.get('content-length') || 0);
    if (headRes.ok && /video|octet-stream/i.test(headContentType) && headContentLength >= 1024) {
      return { ok: true, status: headRes.status, contentType: headContentType, bytes: headContentLength, checkMethod: 'HEAD', sampledBytes: 0 };
    }

    // HEAD insufficient — fall back to Range GET, headers only (no body reading)
    const rangeRes = await fetch(publicUrl, { method: 'GET', headers: { Range: 'bytes=0-1023' } });
    const contentType = rangeRes.headers.get('content-type') || '';

    // Discard body immediately without reading
    await rangeRes.body?.cancel().catch(() => {});

    // Parse total file size: prefer Content-Range (206), fall back to Content-Length (200)
    const contentRange = rangeRes.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const totalBytes = totalMatch ? Number(totalMatch[1]) : Number(rangeRes.headers.get('content-length') || 0);

    if (!rangeRes.ok && rangeRes.status !== 206) {
      return { ok: false, status: rangeRes.status, contentType, bytes: totalBytes, error: 'public-url-not-readable', checkMethod: 'RANGE', sampledBytes: 0 };
    }
    if (!totalBytes) {
      return { ok: false, status: rangeRes.status, contentType, bytes: 0, error: 'stored-file-size-unknown', checkMethod: 'RANGE', sampledBytes: 0 };
    }
    if (totalBytes < 1024) {
      return { ok: false, status: rangeRes.status, contentType, bytes: totalBytes, error: 'stored-file-too-small', checkMethod: 'RANGE', sampledBytes: 0 };
    }
    if (!/video|octet-stream/i.test(contentType)) {
      return { ok: false, status: rangeRes.status, contentType, bytes: totalBytes, error: 'stored-file-is-not-video', checkMethod: 'RANGE', sampledBytes: 0 };
    }

    return { ok: true, status: rangeRes.status, contentType, bytes: totalBytes, checkMethod: 'RANGE', sampledBytes: 0 };
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

    // Before hitting OpenRouter content URL, check if a Supabase-hosted video already exists in DB
    if (isCompletedStatus(jobStatus)) {
      const dbCheck = dbClient();
      if (dbCheck) {
        const { data: task } = await dbCheck.from('generation_tasks').select('output_url').eq('api_task_id', resolvedJobId).maybeSingle();
        if (task?.output_url && isSupabasePublicUrl(task.output_url)) {
          const publicCheck = await verifyPublicObject(task.output_url);
          if (publicCheck.ok) {
            videoUrl = task.output_url;
            storage = { ok: true, videoUrl: task.output_url, skipped: true, reason: 'already-persistent-db', source: 'generation_tasks.output_url', publicCheck };
          }
        }
      }
    }

    if (!videoUrl && rawVideoUrl) {
      storage = await persistVideo({ jobId: resolvedJobId, videoUrl: rawVideoUrl, apiKey });
      if (storage?.ok && storage.videoUrl) videoUrl = storage.videoUrl;
    }

    // ---- Recoverable-failure grace period ----
    // Applies when: status endpoint returned 404, OR OpenRouter says completed but no video URL
    // yet available. We track wait state in generation_tasks.settings.result_wait and only
    // trigger a refund after both 5 min elapsed AND 5 failed attempts.
    if (!videoUrl && (isCompletedStatus(jobStatus) || response.status === 404)) {
      const waitReason = response.status === 404 ? 'status-404' : 'completed-no-url';
      const dbWait = dbClient();
      let waitResult = { state: 'db_error' };
      if (dbWait) waitResult = await recordResultWait(dbWait, resolvedJobId, waitReason).catch(() => ({ state: 'db_error' }));

      if (waitResult.state === 'db_error' || waitResult.state === 'stale') {
        // DB unreachable or task status changed under us — don't refund, keep client polling
        return res.status(200).json({
          ok: true,
          done: false,
          jobStatus: 'processing',
          resultPending: true,
          jobId: resolvedJobId,
          originalJobId: jobId,
          pollingUrl,
          statusUrl,
          checkedAt: new Date().toISOString()
        });
      }

      if (waitResult.state === 'ok') {
        if (!isResultWaitExpired(waitResult.wait)) {
          // Still within grace period — return HTTP 200 so client keeps polling.
          // This prevents a 404 status code from causing the client to stop immediately.
          return res.status(200).json({
            ok: true,
            done: false,
            jobStatus: 'processing',
            resultPending: true,
            jobId: resolvedJobId,
            originalJobId: jobId,
            pollingUrl,
            statusUrl,
            checkedAt: new Date().toISOString()
          });
        }

        // Grace period expired: final re-check by task ID before committing to a refund
        const dbFinal = dbClient();
        let finalCheckOk = false;
        if (dbFinal) {
          const { data: tFinal, error: finalSelectError } = await dbFinal
            .from('generation_tasks')
            .select('id,status,output_url,settings')
            .eq('id', waitResult.taskId)
            .maybeSingle();

          if (finalSelectError || !tFinal) {
            // DB error or task gone — can't confirm expiry, keep client polling
            return res.status(200).json({
              ok: true,
              done: false,
              jobStatus: 'processing',
              resultPending: true,
              jobId: resolvedJobId,
              originalJobId: jobId,
              pollingUrl,
              statusUrl,
              checkedAt: new Date().toISOString()
            });
          }

          // Re-check DB output_url first
          if (tFinal.output_url && isSupabasePublicUrl(tFinal.output_url)) {
            const pc = await verifyPublicObject(tFinal.output_url);
            if (pc.ok) {
              videoUrl = tFinal.output_url;
              storage = { ok: true, videoUrl, skipped: true, reason: 'recovered-on-expiry-db' };
              finalCheckOk = true;
            }
          }

          // Re-check OpenRouter content URL if DB check did not recover
          if (!videoUrl) {
            const expiredContentUrl = openRouterContentUrl(resolvedJobId);
            if (expiredContentUrl) {
              const expiredStorage = await persistVideo({ jobId: resolvedJobId, videoUrl: expiredContentUrl, apiKey });
              if (expiredStorage?.ok && expiredStorage.videoUrl) {
                videoUrl = expiredStorage.videoUrl;
                storage = expiredStorage;
                finalCheckOk = true;
              }
            }
          }
        }

        if (!finalCheckOk) {
          // All re-checks failed — attempt refund
          await processRefundIfNeeded(dbClient(), resolvedJobId, 'failed', `${waitReason}-timeout`).catch(() => {});

          // Verify refund was committed before returning a failure response
          const dbVerify = dbClient();
          if (dbVerify) {
            const { data: taskAfter, error: verifyError } = await dbVerify
              .from('generation_tasks')
              .select('id,status')
              .eq('id', waitResult.taskId)
              .maybeSingle();

            if (!verifyError && taskAfter?.status === 'failed') {
              return res.status(200).json({
                ok: false,
                done: false,
                jobStatus: 'failed',
                resultPending: false,
                error: 'video_result_unavailable_after_wait',
                jobId: resolvedJobId,
                originalJobId: jobId,
                pollingUrl,
                statusUrl,
                checkedAt: new Date().toISOString()
              });
            }
          }
          // DB verify error or status not yet 'failed' — keep client polling
          return res.status(200).json({
            ok: true,
            done: false,
            jobStatus: 'processing',
            resultPending: true,
            jobId: resolvedJobId,
            originalJobId: jobId,
            pollingUrl,
            statusUrl,
            checkedAt: new Date().toISOString()
          });
        }
        // If videoUrl was recovered above, fall through to normal done=true path
      }
      // state === 'not_found': no matching queued/processing task
      // For 404: fall through to res.status(404) response (invalid jobId behavior maintained)
      // For completed-no-url: fall through to done=false response
    }
    // ---- End recoverable-failure grace period ----

    const done = Boolean(videoUrl);

    // Settle final credits on successful completion (once, via atomic task claim)
    const costUsd = extractCostUsd(data);
    let finalCreditsResult = null;
    if (done) {
      finalCreditsResult = await processFinalCredits(dbClient(), resolvedJobId, costUsd, videoUrl).catch(() => null);
    }

    // Detect late completion: video found but task was already refunded (status='failed')
    if (done && finalCreditsResult === null) {
      try {
        const dbLate = dbClient();
        if (dbLate) {
          const { data: taskLate } = await dbLate
            .from('generation_tasks')
            .select('id,status')
            .eq('api_task_id', resolvedJobId)
            .maybeSingle();
          if (taskLate?.status === 'failed') {
            console.warn('[seedance-status] late_completed_after_refund', {
              jobId: resolvedJobId,
              taskId: taskLate.id
            });
          }
        }
      } catch (_) {}
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

    // Refund credits on explicit terminal failure (failed/error/cancelled from OpenRouter).
    // HTTP 404 is now handled by the recoverable-failure grace period block above,
    // which delays refunds until both 5 min elapsed AND 5 failed attempts.
    if (response.ok && isFailedStatus(jobStatus) && !done) {
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