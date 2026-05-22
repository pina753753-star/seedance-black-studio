module.exports = async function handler(req, res) {
  return res.status(200).json({
    ok: true,
    endpoint: '/api/run-generation-task',
    disabled: true,
    note: 'Temporarily disabled while Seedance integration is tested.',
    checkedAt: new Date().toISOString()
  });
};
