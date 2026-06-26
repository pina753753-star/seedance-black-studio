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

function inputCount(value) {
  return Array.isArray(value) ? value.filter(Boolean).length : 0;
}

function countReferenceInputs(body, mode) {
  if (mode === 'text_to_video') return 0;
  const singleReference = body.first_frame_url || body.reference_url ? 1 : 0;
  return Math.max(
    1,
    singleReference,
    inputCount(body.reference_urls || body.referenceUrls),
    inputCount(body.input_references),
    inputCount(body.frame_images)
  );
}

function calculateCreditCost({ model, mode, duration, resolution, referenceCount }) {
  let credits;
  if (mode === 'storyboard') {
    credits = Math.max(MIN_CREDITS, duration * 12);
  } else {
    credits = 80;
    credits += Math.max(0, duration - 5) * 15;
    if (resolution === '1080p') credits += 100;
    if (resolution === '480p') credits -= 20;
    if (mode === 'reference_to_video') credits += Math.max(0, referenceCount - 1) * 10;
    if (mode === 'text_to_video') credits -= 10;
    credits += 15;
  }
  const multiplier = MODEL_CREDIT_MULTIPLIERS[model] || 1;
  return Math.max(MIN_CREDITS, Math.min(MAX_CREDITS, Math.round(credits * multiplier)));
}

function originalStartUrl(req) {
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'https';
  const host = String(req.headers?.host || '').trim();
  if (!host) return null;
  return `${protocol}://${host}/api/seedance-start`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({
      ok: true,
      endpoint: '/api/seedance-start-priced',
      method: 'POST',
      allowedModels: Array.from(ALLOWED_MODELS)
    });
  }

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
  const referenceCount = countReferenceInputs(body, mode);
  const creditCost = calculateCreditCost({model, mode, duration, resolution, referenceCount});
  const target = originalStartUrl(req);
  if (!target) return res.status(500).json({ok:false,error:'Missing request host'});

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: String(req.headers?.authorization || '')
      },
      body: JSON.stringify({...body, model, estimated_credits: creditCost})
    });
    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type');
    const retryAfter = upstream.headers.get('retry-after');
    if (contentType) res.setHeader('Content-Type', contentType);
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    return res.status(upstream.status).send(text);
  } catch (error) {
    console.error('[seedance-start-priced] proxy error:', error?.message);
    return res.status(502).json({
      ok: false,
      error: 'generation_start_proxy_failed',
      message: '生成開始処理への接続に失敗しました。再度生成せず、ログを確認してください。'
    });
  }
};
