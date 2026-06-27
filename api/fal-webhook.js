const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const VIDEO_BUCKET = process.env.FLOWVID_VIDEO_BUCKET || 'reference-images';

const FAL_JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-process JWKS cache (ephemeral; resets on cold start, which triggers a fresh fetch)
let _jwksCache = null;
let _jwksCachedAt = 0;

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// Read the raw request body as a Buffer for signature verification.
// Vercel Functions (non-Next.js) expose req as a Node IncomingMessage stream;
// the body has not been consumed before the handler is called.
async function getRawBody(req) {
  // If Vercel has already buffered the body as a string or Buffer, use that directly.
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body, 'utf-8');
  if (req.body && typeof req.body === 'object') {
    // Already parsed as an object — cannot recover exact raw bytes.
    return null;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function fetchJwks() {
  const now = Date.now();
  if (_jwksCache && now - _jwksCachedAt < JWKS_CACHE_TTL_MS) return _jwksCache;
  const res = await fetch(FAL_JWKS_URL, {
    headers: { 'User-Agent': 'flowvid-studio-webhook/1.0' },
    signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined
  });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = await res.json();
  const keys = data.keys || [];
  _jwksCache = keys;
  _jwksCachedAt = now;
  return keys;
}

// Verify an Ed25519 signature using Node.js built-in crypto.
// jwkX is the base64url-encoded 32-byte public key from the JWK.
function verifyED25519(message, signatureHex, jwkX) {
  try {
    const pubKeyBytes = Buffer.from(jwkX, 'base64url');
    if (pubKeyBytes.length !== 32) return false;
    // Build DER SubjectPublicKeyInfo for Ed25519 (OID 1.3.101.112 = 06 03 2b 65 70)
    const derPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const pubKeyDer = Buffer.concat([derPrefix, pubKeyBytes]);
    const pubKey = crypto.createPublicKey({ key: pubKeyDer, format: 'der', type: 'spki' });
    const sigBytes = Buffer.from(signatureHex, 'hex');
    return crypto.verify(null, Buffer.from(message, 'utf-8'), pubKey, sigBytes);
  } catch (_) { return false; }
}

async function verifySignature(req, rawBody) {
  const requestId = String(req.headers['x-fal-webhook-request-id'] || '').trim();
  const userId = String(req.headers['x-fal-webhook-user-id'] || '').trim();
  const timestamp = String(req.headers['x-fal-webhook-timestamp'] || '').trim();
  const signature = String(req.headers['x-fal-webhook-signature'] || '').trim();

  if (!requestId || !userId || !timestamp || !signature) {
    return { valid: false, reason: 'missing_required_headers' };
  }

  // Reject requests outside the ±300-second window
  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    return { valid: false, reason: 'timestamp_out_of_window' };
  }

  // SHA-256 of raw body (hex digest)
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  // Message is the four fields joined by newlines (per fal.ai spec)
  const message = [requestId, userId, timestamp, bodyHash].join('\n');

  let keys;
  try { keys = await fetchJwks(); } catch (e) {
    return { valid: false, reason: 'jwks_fetch_failed', detail: String(e?.message) };
  }

  for (const key of keys) {
    if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || !key.x) continue;
    if (verifyED25519(message, signature, key.x)) return { valid: true };
  }

  return { valid: false, reason: 'no_key_matched' };
}

function isSupabasePublicUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && String(url || '').includes('/storage/v1/object/public/');
}

async function downloadAndUpload(db, videoUrl, taskId) {
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    return { ok: false, error: 'invalid video URL' };
  }
  // Reject fal status/cancel/result endpoint URLs masquerading as video URLs
  if (/queue\.fal\.run\/.*\/(status|cancel|result)\b/i.test(videoUrl)) {
    return { ok: false, error: 'URL is a fal status endpoint, not a downloadable video' };
  }

  let videoBuffer, contentType;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s download timeout
    try {
      const dlRes = await fetch(videoUrl, { signal: controller.signal, headers: { 'User-Agent': 'flowvid-studio-webhook/1.0' } });
      if (!dlRes.ok) return { ok: false, error: `video download HTTP ${dlRes.status}` };
      contentType = dlRes.headers.get('content-type') || 'video/mp4';
      const arrayBuf = await dlRes.arrayBuffer();
      videoBuffer = Buffer.from(arrayBuf);
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    return { ok: false, error: `video download failed: ${e?.message}` };
  }

  if (!videoBuffer || videoBuffer.length < 1000) {
    return { ok: false, error: `video file too small: ${videoBuffer?.length ?? 0} bytes` };
  }

  // Use task ID as filename (safe characters only)
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

async function refundCreditsForTask(db, task) {
  try {
    const { data: txs } = await db.from('credit_transactions')
      .select('amount,credit_type')
      .eq('related_task_id', task.id)
      .eq('reason', 'video_generation');
    if (!txs || txs.length === 0) return;

    let fromSub = 0, fromFree = 0, fromPurchased = 0;
    for (const tx of txs) {
      const amt = Math.abs(Number(tx.amount || 0));
      if (tx.credit_type === 'subscription') fromSub += amt;
      else if (tx.credit_type === 'free') fromFree += amt;
      else if (tx.credit_type === 'purchased') fromPurchased += amt;
    }

    const { data: bal } = await db.from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', task.user_id).maybeSingle();
    if (!bal) return;

    const updateFields = { updated_at: new Date().toISOString() };
    if (fromSub > 0) updateFields.subscription_credits = Number(bal.subscription_credits || 0) + fromSub;
    if (fromFree > 0) updateFields.free_credits = Number(bal.free_credits || 0) + fromFree;
    if (fromPurchased > 0) updateFields.purchased_credits = Number(bal.purchased_credits || 0) + fromPurchased;
    await db.from('credit_balances').update(updateFields).eq('user_id', task.user_id);

    const txRows = [];
    if (fromSub > 0) txRows.push({ user_id: task.user_id, amount: fromSub, credit_type: 'subscription', reason: 'generation_refund', related_task_id: task.id });
    if (fromFree > 0) txRows.push({ user_id: task.user_id, amount: fromFree, credit_type: 'free', reason: 'generation_refund', related_task_id: task.id });
    if (fromPurchased > 0) txRows.push({ user_id: task.user_id, amount: fromPurchased, credit_type: 'purchased', reason: 'generation_refund', related_task_id: task.id });
    if (txRows.length) await db.from('credit_transactions').insert(txRows);
    console.log('[fal-webhook] refund complete, taskId:', task.id, 'total:', fromSub + fromFree + fromPurchased);
  } catch (e) {
    console.error('[fal-webhook] refund error:', e?.message, 'taskId:', task.id);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // Read raw body before any other processing (needed for SHA-256 in signature check)
  let rawBody;
  try { rawBody = await getRawBody(req); } catch (e) {
    console.error('[fal-webhook] raw body read error:', e?.message);
    return res.status(500).json({ ok: false, error: 'body_read_error' });
  }
  if (!rawBody) {
    // Body was already parsed as an object by middleware — cannot verify signature
    console.error('[fal-webhook] raw body unavailable (already parsed as object)');
    return res.status(500).json({ ok: false, error: 'raw_body_unavailable' });
  }

  // Verify ED25519 signature before processing payload
  const sigResult = await verifySignature(req, rawBody).catch(e => ({ valid: false, reason: String(e?.message) }));
  if (!sigResult.valid) {
    console.warn('[fal-webhook] signature verification failed:', sigResult.reason);
    return res.status(401).json({ ok: false, error: 'invalid_signature', reason: sigResult.reason });
  }

  let body;
  try { body = JSON.parse(rawBody.toString('utf-8')); } catch (_) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  const requestId = String(body.request_id || '').trim();
  const status = String(body.status || '').trim(); // 'OK' or 'ERROR'
  if (!requestId) return res.status(400).json({ ok: false, error: 'missing request_id' });

  console.log('[fal-webhook] received, request_id:', requestId, 'status:', status);

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'DB not configured' });

  // Find task by fal request_id stored as api_task_id
  const { data: task, error: findErr } = await db.from('generation_tasks')
    .select('id,user_id,status,output_url,api_task_id,api_provider')
    .eq('api_task_id', requestId)
    .eq('api_provider', 'fal')
    .maybeSingle();

  if (findErr) {
    console.error('[fal-webhook] DB find error:', findErr.message, 'request_id:', requestId);
    return res.status(500).json({ ok: false, error: 'db_error' });
  }
  if (!task) {
    // Not found — could be a stale retry for an already-deleted task. Acknowledge to stop retries.
    console.warn('[fal-webhook] no task for request_id:', requestId);
    return res.status(200).json({ ok: true, message: 'task_not_found_acknowledged' });
  }

  // Idempotency: task already in a terminal state
  if (task.status === 'completed' || task.status === 'failed') {
    console.log('[fal-webhook] task already finalized:', task.status, 'taskId:', task.id);
    return res.status(200).json({ ok: true, message: 'already_finalized' });
  }

  // ── ERROR path ──────────────────────────────────────────────────────────────
  if (status === 'ERROR') {
    const errMsg = String(body.error || 'fal generation failed').slice(0, 500);
    console.log('[fal-webhook] fal ERROR, taskId:', task.id, 'error:', errMsg);

    // Atomic claim: only update if still non-terminal (prevents race with concurrent webhook)
    const { data: claimed } = await db.from('generation_tasks')
      .update({ status: 'failed', error_message: errMsg, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', task.id)
      .in('status', ['queued', 'processing'])
      .select('id');

    if (claimed && claimed.length > 0) {
      await refundCreditsForTask(db, task);
    }
    return res.status(200).json({ ok: true });
  }

  // ── Unexpected status ────────────────────────────────────────────────────────
  if (status !== 'OK') {
    console.warn('[fal-webhook] unexpected status:', status, 'taskId:', task.id);
    return res.status(200).json({ ok: true, message: 'unhandled_status_acknowledged' });
  }

  // ── OK path ──────────────────────────────────────────────────────────────────
  const videoUrl = body.payload?.video?.url;
  if (!videoUrl || typeof videoUrl !== 'string') {
    console.error('[fal-webhook] no video URL in payload, taskId:', task.id, 'payload keys:', Object.keys(body.payload || {}));
    // Mark failed and refund — video is unrecoverable without a URL
    const { data: claimed } = await db.from('generation_tasks')
      .update({ status: 'failed', error_message: 'no video URL in webhook payload', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', task.id)
      .in('status', ['queued', 'processing'])
      .select('id');
    if (claimed && claimed.length > 0) await refundCreditsForTask(db, task);
    return res.status(200).json({ ok: true });
  }

  // Idempotency: output_url already set to a persistent Supabase URL
  if (task.output_url && isSupabasePublicUrl(task.output_url)) {
    console.log('[fal-webhook] output_url already persisted, ensuring completed status. taskId:', task.id);
    await db.from('generation_tasks')
      .update({ status: 'completed', updated_at: new Date().toISOString() })
      .eq('id', task.id)
      .in('status', ['queued', 'processing']);
    return res.status(200).json({ ok: true, message: 'already_uploaded' });
  }

  // Download fal video and upload to Supabase Storage for permanent hosting
  console.log('[fal-webhook] uploading video, taskId:', task.id, 'falUrl:', videoUrl.slice(0, 120));
  const uploadResult = await downloadAndUpload(db, videoUrl, task.id);
  if (!uploadResult.ok) {
    console.error('[fal-webhook] upload failed:', uploadResult.error, 'taskId:', task.id);
    // Return 500 so fal retries (up to 10 times in 2h per fal retry policy)
    return res.status(500).json({ ok: false, error: 'upload_failed', detail: uploadResult.error });
  }
  console.log('[fal-webhook] upload success, bytes:', uploadResult.bytes, 'taskId:', task.id);

  // Atomic complete claim (WHERE status IN queued/processing prevents double-complete)
  const { data: claimed } = await db.from('generation_tasks')
    .update({
      status: 'completed',
      output_url: uploadResult.publicUrl,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq('id', task.id)
    .in('status', ['queued', 'processing'])
    .select('id');

  if (!claimed || claimed.length === 0) {
    console.warn('[fal-webhook] complete claim found 0 rows (race condition?) taskId:', task.id);
  } else {
    console.log('[fal-webhook] task completed, taskId:', task.id, 'url:', uploadResult.publicUrl.slice(0, 80));
  }

  // Watermark is handled lazily by fal-status.js on the next client poll
  return res.status(200).json({ ok: true });
};
