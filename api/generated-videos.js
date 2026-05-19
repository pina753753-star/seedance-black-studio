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

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);
      const rows = await supabaseRequest(`generated_videos?select=*&order=created_at.desc&limit=${limit}`);
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

    const existing = await supabaseRequest(`generated_videos?select=id&operation_name=eq.${encodeURIComponent(operationName)}&limit=1`);
    const videoUri = String(body.videoUri || body.video_uri || findVideoUri(body.response) || '').trim();
    const payload = {
      user_email: body.userEmail || body.user_email || null,
      provider: body.provider || 'veo',
      model: body.model || null,
      operation_name: operationName,
      prompt: body.prompt || null,
      aspect_ratio: body.aspectRatio || body.aspect_ratio || null,
      duration_seconds: Number(body.durationSeconds || body.duration_seconds || 5),
      video_uri: videoUri || null,
      credit_cost: Number(body.creditCost || body.credit_cost || 128),
      status: videoUri ? 'completed' : (body.status || 'processing')
    };

    let rows;
    if (existing?.[0]?.id) {
      rows = await supabaseRequest(`generated_videos?id=eq.${existing[0].id}`, {
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

    return res.status(200).json({ ok: true, row: rows?.[0] || null, checkedAt: new Date().toISOString() });
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error?.message || 'Unknown error',
      checkedAt: new Date().toISOString()
    });
  }
}
