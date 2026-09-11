'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const {
  jsonBody, isUuid, checkDirectorEnabled, getDirectorEntitlement
} = require('../_lib/h3-director-store.js');
const { moderateDirectorPrompt } = require('../_lib/h3-director-moderation.js');
const { PROMPT_MAX_CHARS, ALLOWED_PLANS } = require('../_lib/h3-director-config.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  const body = jsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const prompt = String(body.prompt || '').trim();
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
  if (prompt.length < 1 || prompt.length > PROMPT_MAX_CHARS) {
    return res.status(400).json({ ok: false, error: 'invalid_prompt' });
  }

  const { data: session, error } = await auth.supabase.from('h3_director_sessions')
    .select('id,status,prompt_version,expires_at').eq('id', sessionId).eq('user_id', auth.user.id).maybeSingle();
  if (error) return res.status(500).json({ ok: false, error: 'session_lookup_failed' });
  if (!session) return res.status(404).json({ ok: false, error: 'session_not_found' });
  if (!['connecting', 'live'].includes(session.status) || Date.now() >= Date.parse(String(session.expires_at || ''))) {
    return res.status(409).json({ ok: false, error: 'session_not_live' });
  }

  // Same Preview-only relaxation as start-session.js / heartbeat.js.
  const isVercelPreview = process.env.VERCEL_ENV === 'preview';

  const [control, entitlement] = await Promise.all([
    checkDirectorEnabled(auth.supabase),
    getDirectorEntitlement(auth.supabase, auth.user.id, ALLOWED_PLANS)
  ]);
  if (
    (!control.ok && !isVercelPreview) ||
    !entitlement.ok ||
    !entitlement.allowed ||
    entitlement.accountStatus !== 'active'
  ) {
    return res.status(403).json({ ok: false, error: entitlement.accountStatus !== 'active' ? 'account_restricted' : 'access_revoked' });
  }

  const moderation = await moderateDirectorPrompt(prompt);
  if (!moderation.ok) return res.status(503).json({ ok: false, error: 'content_safety_unavailable' });
  if (!moderation.allow) return res.status(422).json({ ok: false, error: 'content_not_allowed' });

  const currentVersion = Number(session.prompt_version || 1);
  const nextVersion = currentVersion + 1;
  const { data: rows, error: updateError } = await auth.supabase.from('h3_director_sessions')
    .update({ prompt_version: nextVersion, updated_at: new Date().toISOString() })
    .eq('id', sessionId).eq('prompt_version', currentVersion).in('status', ['connecting', 'live'])
    .select('prompt_version');
  if (updateError) return res.status(500).json({ ok: false, error: 'prompt_state_failed' });
  if (!Array.isArray(rows) || rows.length !== 1) return res.status(409).json({ ok: false, error: 'prompt_version_conflict' });
  return res.status(200).json({ ok: true, prompt, promptVersion: nextVersion });
};
