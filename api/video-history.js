const { createClient } = require('@supabase/supabase-js');

const TABLE = 'flowvid_video_history';
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || '';

function client() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

function cleanString(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function cleanArray(value) {
  return Array.isArray(value) ? value.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 10) : [];
}

function toRow(body) {
  const jobId = cleanString(body.jobId || body.job_id, 300);
  const deviceId = cleanString(body.deviceId || body.device_id || 'anonymous', 300);
  return {
    job_id: jobId,
    device_id: deviceId,
    status: cleanString(body.status || 'processing', 80),
    mode: cleanString(body.mode || 'reference_to_video', 80),
    prompt: cleanString(body.prompt, 8000),
    video_url: cleanString(body.videoUrl || body.video_url, 4000) || null,
    reference_urls: cleanArray(body.referenceUrls || body.reference_urls),
    settings: body.settings && typeof body.settings === 'object' ? body.settings : {},
    updated_at: new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  const db = client();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase server key' });

  if (req.method === 'GET') {
    const deviceId = cleanString(req.query.deviceId || req.query.device_id || '', 300);
    if (!deviceId) return res.status(200).json({ ok: true, rows: [] });
    const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
    let query = db.from(TABLE).select('*').order('created_at', { ascending: false }).limit(limit);
    query = query.eq('device_id', deviceId);
    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error: error.message, table: TABLE });
    return res.status(200).json({ ok: true, rows: data || [] });
  }

  if (!['POST', 'DELETE'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = cleanString(body.action, 80).toLowerCase();
    const shouldDelete = req.method === 'DELETE' || action === 'delete';

    if (shouldDelete) {
      const jobId = cleanString(body.jobId || body.job_id, 300);
      if (!jobId) return res.status(400).json({ ok: false, error: 'jobId is required' });

      const { data, error } = await db
        .from(TABLE)
        .delete()
        .eq('job_id', jobId)
        .select('job_id');

      if (error) return res.status(500).json({ ok: false, error: error.message, table: TABLE, jobId });
      return res.status(200).json({ ok: true, jobId, deleted: data?.length || 0 });
    }

    const row = toRow(body);
    if (!row.job_id) return res.status(400).json({ ok: false, error: 'jobId is required' });

    // Merge settings with any existing row to avoid clobbering server-written credit metadata
    const { data: existingRow } = await db.from(TABLE).select('settings,prompt').eq('job_id', row.job_id).maybeSingle();
    row.settings = { ...(existingRow?.settings || {}), ...row.settings };
    // Always keep the prompt available: mirror into settings.prompt, and never clobber a saved prompt with an empty one
    if (row.prompt) {
      row.settings.prompt = row.prompt;
    } else if (existingRow?.prompt) {
      row.prompt = existingRow.prompt;
    } else if (row.settings.prompt) {
      row.prompt = row.settings.prompt;
    }

    const { data, error } = await db
      .from(TABLE)
      .upsert(row, { onConflict: 'job_id' })
      .select('*')
      .single();

    if (error) return res.status(500).json({ ok: false, error: error.message, table: TABLE, row });
    return res.status(200).json({ ok: true, row: data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error?.message || 'Unknown error' });
  }
};