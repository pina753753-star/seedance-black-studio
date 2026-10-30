'use strict';

const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { REFERENCE_DANCE_TABLE, authorizeReferenceDanceAdmin } = require('./_lib/reference-dance.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    if (!access.ok) return res.status(403).json({ ok: false, error: 'reference_dance_beta_forbidden' });
    const { data, error } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
      .select('id,status,original_filename,inspection_error,expires_at,duration_ms,billable_seconds')
      .eq('user_id', auth.user.id)
      .in('status', ['uploading', 'checking', 'ready'])
      .is('last_task_id', null)
      // Motion assets of 16-20 s exist only for the motion tab; they must not be restored into the Seedance panel.
      .or('duration_ms.is.null,duration_ms.lte.15000')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(200).json({ ok: true, asset: null });
    return res.status(200).json({
      ok: true,
      asset: {
        id: data.id,
        status: data.status,
        durationMs: data.status === 'ready' ? data.duration_ms : null,
        billableSeconds: data.status === 'ready' ? data.billable_seconds : null,
        expiresAt: data.expires_at,
        name: String(data.original_filename || '前回の参考動画').slice(0, 180),
        reason: data.status === 'ready' ? '' : String(data.inspection_error || '').slice(0, 80)
      }
    });
  } catch (error) {
    console.error('[reference-dance-latest] failed', error?.message || String(error));
    return res.status(500).json({ ok: false, error: 'reference_video_restore_failed' });
  }
};

