'use strict';

// Deliberately has no auth, provider, database or payment dependencies.
// The emergency routes in vercel.json send only new work / checkout here.
module.exports = function maintenance(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(503);
  if (_req.method === 'HEAD') return res.end();
  return res.json({
    ok: false,
    error: 'maintenance_in_progress',
    errorCategory: 'service_unavailable',
    message: 'メンテナンス中です。復旧まで今しばらくお待ちください'
  });
};
