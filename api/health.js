module.exports = function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'FlowVid Studio API',
    runtime: 'vercel-serverless',
    checkedAt: new Date().toISOString()
  });
};
