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

  // 安全上限。1ユーザーの完了済み動画編集がこれを超える運用は現状想定していないため、
  // ここではDB全件取得+JS側での正確な並び替えを選ぶ(下記コメント参照)。
  const HARD_FETCH_CAP = 500;

  // completed_at || updated_at || created_at の優先順で並べたいが、PostgRESTの
  // クエリビルダーはCOALESCEによる単一ソートキー化をサポートしない。複数order()を
  // チェーンする方式だと「completed_atがある行が全て先、無い行が全て後」という
  // 2グループに分かれてしまい、意図した「無い場合だけ次のカラムで代用する」動きに
  // ならないため、DB側では参考程度の粗いソート(created_at)だけ行い、正確な並びは
  // 全件取得したうえでJS側でsortTime=completed_at||updated_at||created_atを計算して
  // ソートし、その後でoffset/limitに応じたスライスを行う。
  const { data, error } = await db
    .from('video_edit_tasks')
    .select(SELECT_FIELDS)
    .eq('user_id', auth.user.id) // ownership check, defense-in-depth alongside the service-role client
    .eq('status', 'completed')
    .not('edited_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(HARD_FETCH_CAP);

  if (error) {
    console.error('[video-edit-history] query error:', error.message);
    return res.status(500).json({ ok: false, error: 'history_lookup_failed' });
  }

  const rows = Array.isArray(data) ? data : [];
  const sorted = rows
    .map((row) => {
      const sortTime = row.completed_at || row.updated_at || row.created_at;
      return { row, sortMs: sortTime ? new Date(sortTime).getTime() : 0 };
    })
    .sort((a, b) => {
      if (b.sortMs !== a.sortMs) return b.sortMs - a.sortMs;
      // 同時刻のタイブレーク: idの文字列比較で降順にするだけで良く、
      // 意味のある順序ではなく単にページ間で結果が安定していれば十分
      return String(b.row.id).localeCompare(String(a.row.id));
    })
    .map((x) => x.row);

  const total = sorted.length;
  const page = sorted.slice(offset, offset + limit).map((row) => ({
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
  const hasMore = offset + limit < total;

  return res.status(200).json({
    ok: true,
    rows: page,
    hasMore,
    limit,
    offset
  });
};
