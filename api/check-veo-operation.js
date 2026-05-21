function config() {
  return {
    supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    serviceRoleKey: process.env['SUPABASE_' + 'SERVICE_ROLE_KEY'] || '',
    googleApiKey: process.env.GOOGLE_API_KEY || ''
  };
}

async function supabaseRequest(path, options = {}) {
  const { supabaseUrl, serviceRoleKey } = config();
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Missing Supabase environment variables');
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
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

async function getOperation(operationName) {
  const { googleApiKey } = config();
  if (!googleApiKey) throw new Error('Missing GOOGLE_API_KEY');
  const cleanName = String(operationName || '').replace(/^\/+/, '');
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/${cleanName}?key=${encodeURIComponent(googleApiKey)}`;
  const response = await fetch(endpoint, { method: 'GET' });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!response.ok) {
    const error = new Error(typeof data === 'string' ? data : JSON.stringify(data));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function upsertGeneratedVideo({ operationName, operation, userEmail }) {
  const existingRows = await supabaseRequest(`generated_videos?select=*&operation_name=eq.${encodeURIComponent(operationName)}&limit=1`);
  const existing = existingRows?.[0] || null;
  const videoUri = findVideoUri(operation);
  const status = videoUri ? 'completed' : 'processing';

  const payload = {
    user_email: String(existing?.user_email || userEmail || '').trim().toLowerCase() || null,
    provider: existing?.provider || 'veo',
    model: existing?.model || null,
    operation_name: operationName,
    prompt: existing?.prompt || null,
    aspect_ratio: existing?.aspect_ratio || null,
    duration_seconds: Number(existing?.duration_seconds || 5),
    video_uri: videoUri || existing?.video_uri || null,
    credit_cost: Number(existing?.credit_cost || 128),
    status: videoUri ? 'completed' : status
  };

  let rows;
  if (existing?.id) {
    rows = await supabaseRequest(`generated_videos?id=eq.${encodeURIComponent(existing.id)}`, {
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
  if (row?.status === 'completed' && row?.prompt && row?.user_email) {
    try {
      const profiles = await supabaseRequest(`profiles?select=id&email=eq.${encodeURIComponent(row.user_email)}&limit=1`);
      const userId = profiles?.[0]?.id;
      if (userId) {
        await supabaseRequest(`generation_tasks?user_id=eq.${encodeURIComponent(userId)}&prompt=eq.${encodeURIComponent(row.prompt)}&status=eq.processing`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'completed' })
        });
      }
    } catch (_) {}
  }

  return row;
}

export default async function handler(req, res) {
  try {
    const operationName = String(req.query.operationName || req.query.operation_name || '').trim();
    const userEmail = String(req.query.userEmail || req.query.user_email || '').trim().toLowerCase();
    if (!operationName) return res.status(400).json({ ok: false, error: 'operationName is required' });

    const operation = await getOperation(operationName);
    const row = await upsertGeneratedVideo({ operationName, operation, userEmail });

    return res.status(200).json({
      ok: true,
      done: Boolean(operation?.done),
      completed: Boolean(row?.video_uri),
      operationName,
      row,
      operation,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error?.message || 'Unknown error',
      details: error?.data || null,
      checkedAt: new Date().toISOString()
    });
  }
}
