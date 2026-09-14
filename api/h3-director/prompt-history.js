'use strict';

const { requireConfirmedAuth } = require('../_lib/confirmed-auth.js');
const { isUuid } = require('../_lib/h3-director-store.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const sessionId = String(req.query?.sessionId || '').trim();
  const rawLimit = Number.parseInt(req.query?.limit, 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, rawLimit)) : 20;
  if (!isUuid(sessionId)) return res.status(400).json({ ok: false, error: 'invalid_session_id' });

  const { data: commands, error } = await auth.supabase
    .from('h3_director_prompt_commands')
    .select('command_id,session_id,prompt_version,original_prompt,current_status,last_reason,checked_at,sent_at,accepted_at,used_for_generation_at,visible_at,rejected_at,superseded_at,unknown_at,created_at,updated_at')
    .eq('session_id', sessionId)
    .eq('user_id', auth.user.id)
    .order('prompt_version', { ascending: true })
    .limit(limit);
  if (error) return res.status(500).json({ ok: false, error: 'prompt_history_lookup_failed' });

  const commandIds = (commands || []).map((row) => row.command_id);
  let events = [];
  if (commandIds.length) {
    const eventResult = await auth.supabase
      .from('h3_director_prompt_command_events')
      .select('id,command_id,event_type,reason,created_at')
      .in('command_id', commandIds)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (eventResult.error) {
      return res.status(500).json({ ok: false, error: 'prompt_history_lookup_failed' });
    }
    events = eventResult.data || [];
  }

  const eventsByCommand = Object.create(null);
  events.forEach((event) => {
    if (!eventsByCommand[event.command_id]) eventsByCommand[event.command_id] = [];
    eventsByCommand[event.command_id].push({
      type: event.event_type,
      reason: event.reason || null,
      createdAt: event.created_at || null
    });
  });

  return res.status(200).json({
    ok: true,
    commands: (commands || []).map((row) => ({
      commandId: row.command_id,
      sessionId: row.session_id,
      promptVersion: Number(row.prompt_version),
      prompt: row.original_prompt,
      status: row.current_status,
      reason: row.last_reason || null,
      checkedAt: row.checked_at || null,
      sentAt: row.sent_at || null,
      acceptedAt: row.accepted_at || null,
      usedForGenerationAt: row.used_for_generation_at || null,
      visibleAt: row.visible_at || null,
      rejectedAt: row.rejected_at || null,
      supersededAt: row.superseded_at || null,
      unknownAt: row.unknown_at || null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      events: eventsByCommand[row.command_id] || []
    }))
  });
};
