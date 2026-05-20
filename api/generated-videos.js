function getConfig() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serverKey = process.env['SUPABASE_' + 'SERVICE_ROLE_KEY'] || '';
  return { url, serverKey };
}

function findVideoUri(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (obj.video && obj.video.uri) return obj.video.uri;
  if (obj.uri && String(obj.uri).includes('/files/')) return obj.uri;
  for (const key of Object.keys(obj)) {
    const found = findVideoUri(obj[key]);
    if (found) return found;
  }
  return '';
}

async function supabaseRequest(path, options = {}) {
  const { url, serverKey } = getConfig();
  if (!url || !serverKey) throw new Error('Missing Supabase environment variables');
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serverKey,
      Authorization: `Bearer ${serverKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const error = new Error(typeof data === 'string' ? data : JSON.stringify(data));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function markMatchingTaskCompleted(row) {
  if (!row?.video_uri || !row?.prompt || !row?.user_email) {
    return { taskSynced: false, reason: 'video_uri, prompt, or user_email missing' };
  }

  const profiles = await supabaseRequest(`profiles?select=id&email=eq.${encodeURIComponent(row.user_email)}&limit=1`);
  const userId = profiles?.[0]?.id;
  if (!userId) return { taskSynced: false, reason: 'profile not found' };

  const path = `generation_tasks?user_id=eq.${encodeURIComponent(userId)}&prompt=eq.${encodeURIComponent(row.prompt)}&status=eq.processing`;
  const updated = await supabaseRequest(path, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'completed' })
  });

  return { taskSynced: true, updatedCount: Array.isArray(updated) ? updated.length : 0 };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);
      const email = String(req.query.email || req.query.user_email || '').trim().toLowerCase();
      const status = String(req.query.status || '').trim();
      const filters = ['select=*'];
      if (email) filters.push(`user_email=eq.${encodeURIComponent(email)}`);
      if (status) filters.push(`status=eq.${encodeURIComponent(status)}`);
      filters.push('order=created_at.desc');
      filters.push(`limit=${limit}`);
      const rows = await supabaseRequest(`generated_videos?${filters.join('&')}`);
      return res.status(200).json({ ok: true, rows, checkedAt: new Date().toISOString() });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, error: 'Method not allowed' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const operationName = String(body.operationName || body.operation_name || '').trim();
    if (!operationName) {
      return res.status(400).json({ ok: false, error: 'operationName is required' });
    }

    const existingRows = await supabaseRequest(`generated_videos?select=*&operation_name=eq.${encodeURIComponent(operationName)}&limit=1`);
    const existing = existingRows?.[0] || null;
    const videoUri = String(body.videoUri || body.video_uri || findVideoUri(body.response) || existing?.video_uri || '').trim();

    const payload = {
      user_email: String(existing?.user_email || body.userEmail || body.user_email || '').trim().toLowerCase() || null,
      provider: existing?.provider || body.provider || 'veo',
      model: existing?.model || body.model || null,
      operation_name: operationName,
      prompt: existing?.prompt || body.prompt || null,
      aspect_ratio: existing?.aspect_ratio || body.aspectRatio || body.aspect_ratio || null,
      duration_seconds: Number(existing?.duration_seconds || body.durationSeconds || body.duration_seconds || 5),
      video_uri: videoUri || null,
      credit_cost: Number(existing?.credit_cost || body.creditCost || body.credit_cost || 128),
      status: videoUri ? 'completed' : (body.status || existing?.status || 'processing')
    };

    let rows;
    if (existing?.id) {
      rows = await supabaseRequest(`generated_videos?id=eq.${existing.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload)
      });
    } else {
      rows = await supabaseRequest('generated_videos', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload)
      });
    }

    const row = rows?.[0] || null;
    let taskSync = { taskSynced: false, reason: 'not completed' };
    if (row?.status === 'completed') {
      try {
        taskSync = await markMatchingTaskCompleted(row);
      } catch (error) {
        taskSync = { taskSynced: false, error: error?.message || 'task sync failed' };
      }
    }

    return res.status(200).json({ ok: true, row, taskSync, checkedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error?.message || 'Unknown error',
      checkedAt: new Date().toISOString()
    });
  }
}
