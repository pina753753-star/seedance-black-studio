'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { jsonBody, isUuid } = require('../_lib/h3-director-store.js');

const EVENT_TYPES = new Set([
  'sent',
  'accepted',
  'used_for_generation',
  'visible',
  'rejected',
  'superseded',
  'unknown'
]);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const body = jsonBody(req);
  const sessionId = String(body.sessionId || '').trim();
  const commandId = String(body.commandId || '').trim();
  const promptVersion = Number(body.promptVersion);
  const eventType = String(body.eventType || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 500);

  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });
  if (!isUuid(commandId)) return res.status(400).json({ ok: false, error: 'invalid_command_id' });
  if (!Number.isInteger(promptVersion) || promptVersion < 2) {
    return res.status(400).json({ ok: false, error: 'invalid_prompt_version' });
  }
  if (!EVENT_TYPES.has(eventType)) return res.status(400).json({ ok: false, error: 'invalid_event_type' });

  const { data: rows, error } = await auth.supabase.rpc(
    'record_h3_director_prompt_event_atomic',
    {
      p_session_id: sessionId,
      p_user_id: auth.user.id,
      p_command_id: commandId,
      p_prompt_version: promptVersion,
      p_event_type: eventType,
      p_reason: reason || null
    }
  );
  if (error) return res.status(500).json({ ok: false, error: 'prompt_event_state_failed' });

  const result = Array.isArray(rows) ? rows[0] : rows;
  const code = String(result?.code || 'prompt_event_state_failed');
  if (code === 'command_not_found') return res.status(404).json({ ok: false, error: code });
  if (code === 'invalid_event') return res.status(400).json({ ok: false, error: code });
  if (code === 'invalid_transition') {
    return res.status(409).json({ ok: false, error: code, currentStatus: result?.current_status || null });
  }
  if (!['recorded', 'already_recorded'].includes(code)) {
    return res.status(500).json({ ok: false, error: 'prompt_event_state_failed' });
  }

  return res.status(200).json({
    ok: true,
    recorded: code === 'recorded',
    replay: code === 'already_recorded',
    currentStatus: result?.current_status || null
  });
};
