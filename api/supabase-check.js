export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({
      ok: false,
      error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
      checks: {
        SUPABASE_URL: Boolean(supabaseUrl),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(serviceRoleKey)
      }
    });
  }

  try {
    const endpoint = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/profiles?select=id`;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'count=exact',
        Range: '0-0'
      }
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = text;
    }

    return res.status(response.ok ? 200 : 500).json({
      ok: response.ok,
      status: response.status,
      supabaseConnected: response.ok,
      table: 'profiles',
      contentRange: response.headers.get('content-range'),
      sampleRowsReturned: Array.isArray(data) ? data.length : null,
      error: response.ok ? null : data,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      supabaseConnected: false,
      error: error?.message || 'Unknown error',
      checkedAt: new Date().toISOString()
    });
  }
}
