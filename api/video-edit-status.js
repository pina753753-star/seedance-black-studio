// GET /api/video-edit-status?taskId=... — status-check endpoint for the
// video editing feature (stage 1). Paired with api/video-edit.js: since
// video-edit.js calls Railway's /edit synchronously and only returns once
// Railway responds (or its own timeout is hit), this endpoint lets the
// client re-check a task's state independently — including after a dropped
// connection, where video-edit.js intentionally leaves the task in
// 'processing' rather than guessing at a refund (see the "unclear
// disconnect" handling in video-edit.js's catch block).
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const taskId = String(req.query.taskId || req.query.id || '').trim();
  if (!taskId) {
    return res.status(400).json({ ok: false, error: 'invalid_task_id', message: 'taskIdが必要です。' });
  }

  const db = auth.supabase;
  if (!db) return res.status(500).json({ ok: false, error: 'SERVER_NOT_CONFIGURED' });

  const { data: task, error } = await db
    .from('video_edit_tasks')
    .select('id,user_id,status,edited_url,actual_output_duration,requested_output_duration,credit_cost,failure_code,created_at,started_at,completed_at,failed_at')
    .eq('id', taskId)
    .eq('user_id', auth.user.id) // ownership check, defense-in-depth alongside the service-role client
    .maybeSingle();

  if (error) {
    console.error('[video-edit-status] lookup error:', error.message, 'taskId:', taskId);
    return res.status(500).json({ ok: false, error: 'status_lookup_failed' });
  }
  if (!task) {
    return res.status(404).json({ ok: false, error: 'task_not_found' });
  }

  return res.status(200).json({
    ok: true,
    taskId: task.id,
    status: task.status,
    editedUrl: task.status === 'completed' ? (task.edited_url || null) : null,
    actualOutputDuration: task.actual_output_duration ?? null,
    requestedOutputDuration: task.requested_output_duration ?? null,
    creditCost: task.credit_cost,
    failureCode: task.status === 'failed' ? (task.failure_code || null) : null,
    createdAt: task.created_at,
    startedAt: task.started_at,
    completedAt: task.completed_at,
    failedAt: task.failed_at
  });
};
