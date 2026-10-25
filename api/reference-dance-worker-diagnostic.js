'use strict';
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { authorizeReferenceDanceAdmin } = require('./_lib/reference-dance.js');

// Verified production service origin; never derive the target from request input.
const PRODUCTION_WORKER_ORIGIN = 'https://seedance-black-studio-production.up.railway.app';
const PREVIEW_ORIGIN = 'https://flowvid-studio-git-verify-pina-worker-au-4f7aef-pina-s-projects.vercel.app';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const reply = (status, value) => res.status(status).json(value);
  if (process.env.VERCEL_ENV !== 'preview') return reply(404, { ok: false });
  if (req.method !== 'POST') return reply(405, { ok: false });
  if (req.headers?.origin !== PREVIEW_ORIGIN
      || req.headers?.['x-pina-diagnostic'] !== '1'
      || !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) {
    return reply(403, { ok: false });
  }
  let timer;
  try {
    const auth = await requireConfirmedAuth(req);
    if (!auth.ok) return reply(auth.status === 403 ? 403 : 401, { ok: false });
    const access = await authorizeReferenceDanceAdmin(auth);
    if (!access.ok) return reply(403, { ok: false });
    // Nonempty bodies are rejected so URL, payload and credentials cannot be supplied.
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length) {
      return reply(400, { ok: false });
    }
    if (!PRODUCTION_WORKER_ORIGIN) return reply(503, { ok: false, status: 'target_unconfigured' });
    const target = new URL(PRODUCTION_WORKER_ORIGIN);
    if (target.protocol !== 'https:' || target.origin !== PRODUCTION_WORKER_ORIGIN
        || target.username || target.password || target.port) return reply(503, { ok: false, status: 'target_unconfigured' });
    const project = new URL(process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(project.href)) {
      return reply(503, { ok: false, status: 'project_unconfigured' });
    }
    const secret = process.env.WATERMARK_SECRET;
    if (typeof secret !== 'string' || !secret.trim() || /[\r\n]/.test(secret)) {
      return reply(503, { ok: false, status: 'auth_unconfigured' });
    }
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), 5000);
    // Baseline ec9190f authenticates, then rejects this empty body BEFORE queue/media/storage.
    // Never follow redirects with the credential or retry a failed probe.
    const response = await fetch(`${PRODUCTION_WORKER_ORIGIN}/watermark`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: '{}'
    });
    const data = await response.json();
    const authenticated = response.status === 400 && data?.ok === false && data?.error === 'videoUrl is required';
    return reply(200, { ok: authenticated, authenticated, projectOrigin: project.origin,
      status: authenticated ? 'authenticated_without_processing' : 'not_verified' });
  } catch (_) {
    // Never echo upstream errors, URLs, headers, tokens, or authentication exceptions.
    return reply(503, { ok: false, status: 'not_verified' });
  } finally {
    if (timer) clearTimeout(timer);
  }
};
