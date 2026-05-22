module.exports = function handler(req, res) {
  res.status(200).json({ ok: true, endpoint: 'upload-reference-image', checkedAt: new Date().toISOString() });
};
