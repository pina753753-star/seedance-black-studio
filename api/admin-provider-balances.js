'use strict';
const { createHash } = require('node:crypto');
const TTL_MS = 30000;
const MAX_BYTES = 16384;
const TARGETS = Object.freeze({
  wavespeed: 'https://api.wavespeed.ai/api/v3/balance',
  fal: 'https://api.fal.ai/v1/account/billing?expand=credits',
  // Official account credits endpoint; it requires an OpenRouter management key.
  openrouter: 'https://openrouter.ai/api/v1/credits'
});
const fail = code => Object.assign(new Error(code), { category: code });
async function smallJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw fail('invalid_response');
  if (!response.body) throw fail('invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw fail('invalid_response');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
function createHandler({ requireAuth, fetchImpl = globalThis.fetch, env = process.env, now = Date.now, timeoutMs = 5000 } = {}) {
  const slots = new Map(); // At most one slot per provider; identities never share a result.
  const authenticate = requireAuth || (req => require('./_lib/confirmed-auth.js').requireConfirmedAuth(req));
  async function readProvider(id, key, userId) {
    if (!key) { slots.delete(id); return { id, state: 'unconfigured', balance: null, currency: null, fetchedAt: null, checkedAt: null, error: 'not_configured' }; }
    const identity = createHash('sha256').update(JSON.stringify([id, key, userId])).digest('hex');
    let slot = slots.get(id);
    if (!slot || slot.identity !== identity) {
      slot = { identity, nextAt: 0, value: null, pending: null };
      slots.set(id, slot);
    }
    if (slot.pending) return slot.pending;
    if (slot.value && now() < slot.nextAt) return slot.value;
    slot.pending = Promise.resolve().then(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const checkedAt = new Date(now()).toISOString();
      try {
        const response = await fetchImpl(TARGETS[id], { method: 'GET', redirect: 'error', cache: 'no-store', signal: controller.signal,
          headers: { Authorization: `${id === 'fal' ? 'Key' : 'Bearer'} ${key}`, Accept: 'application/json' } });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw fail([401, 403].includes(response.status) ? 'access_unavailable' : response.status === 429 ? 'rate_limited' : 'provider_unavailable');
        }
        const json = await smallJson(response);
        let balance, currency;
        if (id === 'openrouter') {
          // Remaining balance = total purchased credits - total usage (both USD).
          // A negative difference is a real, reportable state, never clamped to zero.
          const purchased = json?.data?.total_credits, used = json?.data?.total_usage;
          if (![purchased, used].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw fail('invalid_response');
          balance = Math.round((purchased - used) * 1e6) / 1e6; currency = 'USD';
          if (!Number.isFinite(balance)) throw fail('invalid_response');
        } else {
          balance = id === 'fal' ? json?.credits?.current_balance : json?.data?.balance;
          currency = id === 'fal' ? json?.credits?.currency : 'USD';
          if ((id === 'wavespeed' && json?.code !== 200) || typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0
            || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw fail('invalid_response');
        }
        slot.value = { id, state: 'current', balance, currency, fetchedAt: new Date(now()).toISOString(), checkedAt, error: null };
      } catch (error) {
        const category = controller.signal.aborted ? 'timeout' : ['access_unavailable','rate_limited','provider_unavailable','invalid_response'].includes(error.category) ? error.category : 'provider_unavailable';
        const previous = slot.value;
        slot.value = { id, state: previous?.fetchedAt ? 'stale' : 'unknown', balance: previous?.balance ?? null,
          currency: previous?.currency ?? null, fetchedAt: previous?.fetchedAt ?? null, checkedAt, error: category };
      } finally { clearTimeout(timer); slot.nextAt = now() + TTL_MS; slot.pending = null; }
      return slot.value;
    });
    return slot.pending;
  }
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Authorization');
    res.setHeader('Allow', 'GET');
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
    try {
      // Never read even a cached balance until current authentication AND role are checked.
      const auth = await authenticate(req);
      if (!auth?.ok) return res.status([401,403].includes(auth?.status) ? auth.status : 503).json({ ok: false, error: 'authentication_unavailable' });
      const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase();
      if (!adminEmail || !auth.user?.id || String(auth.user.email || '').trim().toLowerCase() !== adminEmail)
        return res.status(403).json({ ok: false, error: 'forbidden' });
      const profile = await auth.supabase.from('profiles').select('id,email,role').eq('id', auth.user.id).maybeSingle();
      if (profile.error || profile.data?.id !== auth.user.id || profile.data?.role !== 'admin' || String(profile.data.email || '').trim().toLowerCase() !== adminEmail)
        return res.status(403).json({ ok: false, error: 'forbidden' });
      const providers = await Promise.all([
        readProvider('wavespeed', String(env.WAVESPEED_API_KEY || '').trim(), auth.user.id),
        readProvider('fal', String(env.FAL_BILLING_KEY || '').trim() || String(env.FAL_KEY || env.FAL_API_KEY || '').trim(), auth.user.id),
        // Management key only: never substitute the generation key (OPENROUTER_API_KEY).
        readProvider('openrouter', String(env.OPENROUTER_MANAGEMENT_KEY || '').trim(), auth.user.id)
      ]);
      return res.status(200).json({ ok: true, providers, cacheSeconds: TTL_MS / 1000 });
    } catch { return res.status(503).json({ ok: false, error: 'verification_unavailable' }); }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
