// GET /api/video-edit-history?limit=&offset= — read-only list of the
// current user's completed video edits (video_edit_tasks rows with
// status='completed' and a non-null edited_url). Used by the "編集済み動画"
// section in flowvid-video-edit-vllo.js.
//
// This endpoint is intentionally read-only: it never calls any RPC, never
// INSERTs/UPDATEs/DELETEs, never touches Storage, never calls Railway, and
// never invokes reconcileVideoEditTask(). It only SELECTs from
// video_edit_tasks, scoped to the authenticated user, and returns a reduced
// set of fields — internal-only columns (input_manifest, client_request_id,
// storage_path, deducted_*, railway_error_code, failure_code) are never
// included in the response.
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

const SELECT_FIELDS =
  'id,edited_url,created_at,completed_at,updated_at,clip_count,requested_output_duration,actual_output_duration,transition,credit_cost';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const db = auth.supabase;
  if (!db) return res.status(500).json({ ok: false, error: 'SERVER_NOT_CONFIGURED' });

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, Math.trunc(rawLimit))) : 5;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;

  // completed_atを主ソートキーとし、万一nullの行があってもupdated_at→created_at→id
  // の順でタイブレークする。PostgRESTのクエリビルダーはCOALESCEによる単一ソート
  // キー化をサポートしないため、複数order()チェーンで近似している。video-edit.js
  // がstatus='completed'への遷移時に必ずcompleted_atを設定するため、実運用では
  // completed_atが欠けるケースはほぼ発生しない想定(防御的なフォールバック)。
  const { data, error } = await db
    .from('video_edit_tasks')
    .select(SELECT_FIELDS)
    .eq('user_id', auth.user.id) // ownership check, defense-in-depth alongside the service-role client
    .eq('status', 'completed')
    .not('edited_url', 'is', null)
    .order('completed_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit); // limit+1件取得してhasMoreを判定するため

  if (error) {
    console.error('[video-edit-history] query error:', error.message);
    return res.status(500).json({ ok: false, error: 'history_lookup_failed' });
  }

  const rows = Array.isArray(data) ? data : [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((row) => ({
    id: row.id,
    editedUrl: row.edited_url,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    clipCount: row.clip_count,
    requestedOutputDuration: row.requested_output_duration,
    actualOutputDuration: row.actual_output_duration,
    transition: row.transition,
    creditCost: row.credit_cost
  }));

  return res.status(200).json({
    ok: true,
    rows: page,
    hasMore,
    limit,
    offset
  });
};
