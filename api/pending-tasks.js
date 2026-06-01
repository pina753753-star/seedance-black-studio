const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jflpjsdjmlkmkqfahxwy.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
}

function bearerToken(req) {
  const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

async function getUserFromToken(token) {
  if (!token) return null;
  const db = serviceClient();
  if (!db) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch (_) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = bearerToken(req);
  const user = await getUserFromToken(token);
  if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const db = serviceClient();
  if (!db) return res.status(500).json({ ok: false, error: 'Missing Supabase configuration' });

  try {
    const { data, error } = await db
      .from('generation_tasks')
      .select('id,mode,model,prompt,resolution,duration_seconds,aspect_ratio,status,api_task_id,created_at')
      .eq('user_id', user.id)
      .in('status', ['queued', 'processing'])
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, tasks: data || [] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'Unknown error' });
  }
};
