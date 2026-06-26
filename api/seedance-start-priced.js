const coreHandler = require('./seedance-start.js');

const DEFAULT_MODEL = 'bytedance/seedance-2.0';
const FAST_MODEL = 'bytedance/seedance-2.0-fast';
const LEGACY_LITE_MODEL = 'bytedance/seedance-2.0-lite';
const ALLOWED_MODELS = new Set([DEFAULT_MODEL, FAST_MODEL]);
const MIN_CREDITS = 50;
const MAX_CREDITS = 500;

const MODEL_CREDIT_MULTIPLIERS = {
  [DEFAULT_MODEL]: 1,
  [FAST_MODEL]: 0.8
};

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function normalizeDuration(value) {
  const duration = Number(value || 5);
  if (!Number.isFinite(duration)) return 5;
  return Math.max(1, Math.min(15, Math.round(duration)));
}

function normalizeResolution(value) {
  const resolution = String(value || '720p').trim();
  return ['480p', '720p', '1080p'].includes(resolution) ? resolution : '720p';
}

function normalizeMode(value) {
  const mode = String(value || '').trim();
  return ['text_to_video', 'image_to_video', 'reference_to_video', 'storyboard'].includes(mode)
    ? mode
    : 'reference_to_video';
}

function normalizeModel(value) {
  const requested = String(value || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const migrated = requested === LEGACY_LITE_MODEL ? FAST_MODEL : requested;
  return ALLOWED_MODELS.has(migrated) ? migrated : null;
}

function roundUpToTen(value) {
  const bounded = Math.max(MIN_CREDITS, Math.min(MAX_CREDITS, value));
  return Math.min(MAX_CREDITS, Math.ceil(bounded / 10) * 10);
}

function calculateCreditCost({ model, mode, duration, resolution }) {
  let credits;

  if (mode === 'storyboard') {
    credits = Math.max(MIN_CREDITS, duration * 12);
  } else {
    credits = 80;
    credits += Math.max(0, duration - 5) * 15;
    if (resolution === '1080p') credits += 100;
    if (resolution === '480p') credits -= 20;
    if (mode === 'text_to_video') credits -= 10;
    credits += 15;
  }

  const multiplier = MODEL_CREDIT_MULTIPLIERS[model] || 1;
  return roundUpToTen(credits * multiplier);
}

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

  const mode = normalizeMode(body.mode);
  const duration = normalizeDuration(body.duration || body.duration_seconds);
  const resolution = normalizeResolution(body.resolution);
  const creditCost = calculateCreditCost({
    model,
    mode,
    duration,
    resolution
  });

  const clientEstimate = Math.round(Number(body.estimated_credits) || 0);
  if (clientEstimate && clientEstimate !== creditCost) {
    console.warn(
      '[seedance-start-priced] client estimate mismatch:',
      clientEstimate,
      'server:',
      creditCost,
      'model:',
      model
    );
  }

  req.body = {
    ...body,
    model,
    estimated_credits: creditCost
  };

  return coreHandler(req, res);
};
