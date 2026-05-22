module.exports = function handler(req, res) {
  const googleApiKey = process.env.GOOGLE_API_KEY || '';
  const videoProvider = process.env.VIDEO_PROVIDER || '';

  res.status(200).json({
    ok: Boolean(googleApiKey && videoProvider),
    checks: {
      GOOGLE_API_KEY: Boolean(googleApiKey),
      VIDEO_PROVIDER: Boolean(videoProvider),
      VIDEO_PROVIDER_IS_VEO: videoProvider.toLowerCase() === 'veo'
    },
    safePreview: {
      GOOGLE_API_KEY: googleApiKey ? googleApiKey.slice(0, 6) + '...' : null,
      VIDEO_PROVIDER: videoProvider || null
    },
    checkedAt: new Date().toISOString()
  });
};
