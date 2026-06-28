const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const FAL_JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const JWKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _jwksCache = null;
let _jwksCachedAt = 0;

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

// With bodyParser disabled, req is always an unconsumed stream.
async function getRawBody(req) {
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

function verifyED25519(message, signatureHex, jwkX) {
  try {
    const pubKeyBytes = Buffer.from(jwkX, 'base64url');
    if (pubKeyBytes.length !== 32) return false;
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

  const tsSeconds = Number(timestamp);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) {
    return { valid: false, reason: 'timestamp_out_of_window' };
  }

  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
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

// Returns true if refund succeeded (or was already done), false if it should be retried.
async function refundCreditsForTask(db, task) {
  try {
    // Idempotency: skip if refund transaction already recorded
    const { data: existing } = await db.from('credit_transactions')
      .select('id').eq('related_task_id', task.id).eq('reason', 'generation_refund').limit(1);
    if (existing && existing.length > 0) {
      console.log('[fal-webhook] refund already recorded, taskId:', task.id);
      return true;
    }

    const { data: txs } = await db.from('credit_transactions')
      .select('amount,credit_type')
      .eq('related_task_id', task.id)
      .eq('reason', 'video_generation');
    if (!txs || txs.length === 0) {
      // No charge found — nothing to refund, treat as success
      console.log('[fal-webhook] no charge TX found, skipping refund, taskId:', task.id);
      return true;
    }

    let fromSub = 0, fromFree = 0, fromPurchased = 0;
    for (const tx of txs) {
      const amt = Math.abs(Number(tx.amount || 0));
      if (tx.credit_type === 'subscription') fromSub += amt;
      else if (tx.credit_type === 'free') fromFree += amt;
      else if (tx.credit_type === 'purchased') fromPurchased += amt;
    }

    // Insert ledger FIRST so that a balance-update failure on the first attempt
    // is caught by the idempotency check on retry, preventing a double balance update.
    // Trade-off: if ledger succeeds but balance update fails, the next retry finds the
    // ledger and returns true without updating the balance (a missed-refund edge case).
    // This is preferable to a double-refund. Note: without a UNIQUE constraint on
    // (related_task_id, reason, credit_type) in credit_transactions, truly concurrent
    // simultaneous calls could still double-insert; a DB-level constraint or RPC would
    // be needed to fully prevent that rarer case.
    const txRows = [];
    if (fromSub > 0) txRows.push({ user_id: task.user_id, amount: fromSub, credit_type: 'subscription', reason: 'generation_refund', related_task_id: task.id });
    if (fromFree > 0) txRows.push({ user_id: task.user_id, amount: fromFree, credit_type: 'free', reason: 'generation_refund', related_task_id: task.id });
    if (fromPurchased > 0) txRows.push({ user_id: task.user_id, amount: fromPurchased, credit_type: 'purchased', reason: 'generation_refund', related_task_id: task.id });
    if (txRows.length) {
      const { error: txErr } = await db.from('credit_transactions').insert(txRows);
      if (txErr) {
        console.error('[fal-webhook] refund TX insert failed:', txErr.message, 'taskId:', task.id);
        return false;
      }
    }

    const { data: bal } = await db.from('credit_balances')
      .select('free_credits,subscription_credits,purchased_credits')
      .eq('user_id', task.user_id).maybeSingle();
    if (!bal) {
      console.error('[fal-webhook] credit_balances row not found, taskId:', task.id);
      // Ledger already committed; next retry will find it and return true (idempotent).
      return false;
    }

    const updateFields = { updated_at: new Date().toISOString() };
    if (fromSub > 0) updateFields.subscription_credits = Number(bal.subscription_credits || 0) + fromSub;
    if (fromFree > 0) updateFields.free_credits = Number(bal.free_credits || 0) + fromFree;
    if (fromPurchased > 0) updateFields.purchased_credits = Number(bal.purchased_credits || 0) + fromPurchased;
    const { error: balErr } = await db.from('credit_balances').update(updateFields).eq('user_id', task.user_id);
    if (balErr) {
      console.error('[fal-webhook] credit_balances update failed:', balErr.message, 'taskId:', task.id);
      // Ledger already committed; next retry will find it and return true (idempotent).
      return false;
    }

    console.log('[fal-webhook] refund complete, taskId:', task.id, 'total:', fromSub + fromFree + fromPurchased);
    return true;
  } catch (e) {
    console.error('[fal-webhook] refund exception:', e?.message, 'taskId:', task.id);
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  let rawBody;
  try { rawBody = await getRawBody(req); } catch (e) {
    console.error('[fal-webhook] raw body read error:', e?.message);
    return res.status(500).json({ ok: false, error: 'body_read_error' });
  }

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
  const status = String(body.status || '').trim();
  if (!requestId) return res.status(400).json({ ok: false, error: 'missing request_id' });

  console.log('[fal-webhook] received, request_id:', requestId, 'status:', status);

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'DB not configured' });

  const { data: task, error: findErr } = await db.from('generation_tasks')
    .select('id,user_id,status,output_url,polling_url,api_task_id,api_provider')
    .eq('api_task_id', requestId)
    .eq('api_provider', 'fal')
    .maybeSingle();

  if (findErr) {
    console.error('[fal-webhook] DB find error:', findErr.message, 'request_id:', requestId);
    return res.status(500).json({ ok: false, error: 'db_error' });
  }
  if (!task) {
    console.warn('[fal-webhook] no task for request_id:', requestId);
    return res.status(200).json({ ok: true, message: 'task_not_found_acknowledged' });
  }

  // ── ERROR path ──────────────────────────────────────────────────────────────
  if (status === 'ERROR') {
    const errMsg = String(body.error || 'fal generation failed').slice(0, 500);
    console.log('[fal-webhook] fal ERROR, taskId:', task.id, 'status:', task.status, 'error:', errMsg);

    // Already completed — no action needed
    if (task.status === 'completed') {
      return res.status(200).json({ ok: true, message: 'already_completed' });
    }

    // Attempt refund FIRST — if it fails, return 500 so fal retries the webhook
    const refunded = await refundCreditsForTask(db, task);
    if (!refunded) {
      console.error('[fal-webhook] refund failed, returning 500 for retry, taskId:', task.id);
      return res.status(500).json({ ok: false, error: 'refund_failed_will_retry' });
    }

    // Refund succeeded — now mark terminal (idempotent: WHERE status IN non-terminal)
    if (task.status !== 'failed') {
      await db.from('generation_tasks')
        .update({ status: 'failed', error_message: errMsg, finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .in('status', ['queued', 'processing']);
    }

    return res.status(200).json({ ok: true });
  }

  // ── Unexpected status ────────────────────────────────────────────────────────
  if (status !== 'OK') {
    console.warn('[fal-webhook] unexpected status:', status, 'taskId:', task.id);
    return res.status(200).json({ ok: true, message: 'unhandled_status_acknowledged' });
  }

  // ── OK path ──────────────────────────────────────────────────────────────────

  // Idempotency: already completed with a persistent URL
  if (task.status === 'completed' && task.output_url && isSupabasePublicUrl(task.output_url)) {
    console.log('[fal-webhook] already completed, taskId:', task.id);
    return res.status(200).json({ ok: true, message: 'already_completed' });
  }

  const videoUrl = body.payload?.video?.url;
  if (!videoUrl || typeof videoUrl !== 'string') {
    console.error('[fal-webhook] no video URL in payload, taskId:', task.id);
    // No URL = unrecoverable. Refund then mark failed.
    const refunded = await refundCreditsForTask(db, task);
    if (!refunded) {
      console.error('[fal-webhook] refund failed for missing URL case, returning 500, taskId:', task.id);
      return res.status(500).json({ ok: false, error: 'refund_failed_will_retry' });
    }
    if (task.status !== 'failed') {
      await db.from('generation_tasks')
        .update({ status: 'failed', error_message: 'no video URL in webhook payload', finished_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', task.id)
        .in('status', ['queued', 'processing']);
    }
    return res.status(200).json({ ok: true });
  }

  // Idempotency: polling_url already set to the same URL
  if (task.polling_url === videoUrl) {
    console.log('[fal-webhook] polling_url already set, taskId:', task.id);
    return res.status(200).json({ ok: true, message: 'polling_url_already_set' });
  }

  // Save the fal CDN URL as polling_url and mark processing.
  // fal-status.js will download+upload to Supabase Storage on the next client poll.
  const { error: saveErr } = await db.from('generation_tasks')
    .update({ polling_url: videoUrl, status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', task.id)
    .in('status', ['queued', 'processing']);

  if (saveErr) {
    console.error('[fal-webhook] save polling_url failed:', saveErr.message, 'taskId:', task.id);
    return res.status(500).json({ ok: false, error: 'db_save_error' });
  }

  console.log('[fal-webhook] polling_url saved, taskId:', task.id);
  return res.status(200).json({ ok: true });
};

// Disable Vercel's automatic body parsing so we receive the raw stream for
// ED25519 signature verification (SHA-256 of raw bytes must match).
module.exports.config = { api: { bodyParser: false } };
