'use strict';

const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const {
  REFERENCE_DANCE_BUCKET,
  REFERENCE_DANCE_TABLE,
  isUuid,
  validateOwnedPath,
  approvedPath,
  reviewFramePath,
  authorizeReferenceDanceAdmin
} = require('./_lib/reference-dance.js');

function ownedObjectPaths(row, userId) {
  const paths = [];
  if (validateOwnedPath('staging', userId, row.id, row.staging_path)) paths.push(row.staging_path);
  // Include deterministic server-owned paths even when inspection failed
  // before their metadata could be committed to the registry row.
  paths.push(approvedPath(userId, row.id));
  for (let index = 1; index <= 5; index++) paths.push(reviewFramePath(userId, row.id, index));
  if (validateOwnedPath('approved', userId, row.id, row.approved_path)) paths.push(row.approved_path);
  for (const path of Array.isArray(row.review_paths) ? row.review_paths : []) {
    if (validateOwnedPath('review', userId, row.id, path)) paths.push(path);
  }
  return [...new Set(paths)];
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  try {
    const access = await authorizeReferenceDanceAdmin(auth);
    if (!access.ok) return res.status(403).json({ ok: false, error: 'reference_dance_beta_forbidden' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const assetId = String(body.assetId || '').trim();
    if (!isUuid(assetId)) return res.status(400).json({ ok: false, error: 'invalid_reference_video_id' });
    const { data: row, error: rowError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
      .select('id,user_id,status,staging_path,approved_path,review_paths,last_task_id')
      .eq('id', assetId).eq('user_id', auth.user.id).maybeSingle();
    if (rowError) throw rowError;
    if (!row) return res.status(200).json({ ok: true, deleted: true });
    // Keep the sealed object while a provider task may still fetch or process
    // its signed URL. A failed/cancelled task is terminal and can be deleted.
    if (row.status === 'checking') {
      return res.status(200).json({ ok: true, deleted: false, retained: true });
    }
    if (row.last_task_id) {
      const { data: task, error: taskError } = await auth.supabase.from('generation_tasks')
        .select('status').eq('id', row.last_task_id).eq('user_id', auth.user.id).maybeSingle();
      if (taskError || !task || !['failed', 'cancelled'].includes(task.status)) {
        return res.status(200).json({ ok: true, deleted: false, retained: true });
      }
    }
    const paths = ownedObjectPaths(row, auth.user.id);
    if (paths.length) {
      const { error: storageError } = await auth.supabase.storage.from(REFERENCE_DANCE_BUCKET).remove(paths);
      if (storageError) {
        return res.status(503).json({ ok: false, error: 'reference_video_delete_failed', message: '参考動画をすぐに削除できませんでした。自動削除でもう一度処理します。' });
      }
    }
    const { error: deleteError } = await auth.supabase.from(REFERENCE_DANCE_TABLE)
      .delete().eq('id', assetId).eq('user_id', auth.user.id);
    if (deleteError) throw deleteError;
    return res.status(200).json({ ok: true, deleted: true });
  } catch (error) {
    console.error('[reference-dance-delete] failed', error?.message || String(error));
    return res.status(500).json({ ok: false, error: 'reference_video_delete_failed', message: '参考動画を削除できませんでした。自動削除でもう一度処理します。' });
  }
};

module.exports._test = { ownedObjectPaths };
