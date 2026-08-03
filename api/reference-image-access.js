const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ isTestBypassUser: false });
  }

  try {
    const auth = await requireConfirmedAuth(req);
    if (!auth.ok) {
      return res.status(200).json({ isTestBypassUser: false });
    }

    const testBypassUserId = String(process.env.TEST_BYPASS_USER_ID || '').trim();
    const isTestBypassUser = Boolean(
      testBypassUserId &&
      auth.user &&
      auth.user.id === testBypassUserId
    );

    return res.status(200).json({ isTestBypassUser });
  } catch (_) {
    return res.status(200).json({ isTestBypassUser: false });
  }
};
