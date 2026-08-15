const coreHandler = require('./_lib/seedance-start.js');

const DEFAULT_MODEL = 'bytedance/seedance-2.0';
const FAST_MODEL = 'bytedance/seedance-2.0-fast';
const LEGACY_LITE_MODEL = 'bytedance/seedance-2.0-lite';
const ALLOWED_MODELS = new Set([DEFAULT_MODEL, FAST_MODEL]);

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function normalizeModel(value) {
  const requested = String(value || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const migrated = requested === LEGACY_LITE_MODEL ? FAST_MODEL : requested;
  return ALLOWED_MODELS.has(migrated) ? migrated : null;
}

// 2026-08-14: 参照画像入力を持つリクエストを一律503にしていたTEST_BYPASS_USER_ID
// 限定のベータ提供ゲートを解除した(api/upload-reference-image.js参照)。
// 参照画像に対するモデレーション(sexual/minors等)は、この後coreHandler
// (api/_lib/seedance-start.js)側の既存チェックがそのまま引き続き行う。
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return coreHandler(req, res);

  const body = jsonBody(req);
  const model = normalizeModel(body.model);
  if (!model) {
    return res.status(400).json({
      ok: false,
      error: 'unsupported_model',
      message: '対応していない動画モデルです。',
      allowedModels: Array.from(ALLOWED_MODELS)
    });
  }

  req.body = {
    ...body,
    model
  };

  return coreHandler(req, res);
};