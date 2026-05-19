export default function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  res.status(200).json({
    ok: Boolean(supabaseUrl && serviceRoleKey),
    checks: {
      SUPABASE_URL: Boolean(supabaseUrl),
      SUPABASE_SERVICE_ROLE_KEY: Boolean(serviceRoleKey)
    },
    safePreview: {
      SUPABASE_URL: supabaseUrl ? supabaseUrl.replace(/^https:\/\//, '').slice(0, 10) + '...' : null,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey ? serviceRoleKey.slice(0, 8) + '...' : null
    },
    source: 'vercel-env-check',
    checkedAt: new Date().toISOString()
  });
}
