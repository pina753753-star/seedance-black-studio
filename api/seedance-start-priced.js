const coreHandler = require('./_lib/seedance-start.js');
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

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

function hasReferenceImageValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function hasReferenceImageInput(body) {
  return [
    body.frame_images,
    body.input_references,
    body.reference_urls,
    body.referenceUrls,
    body.reference_url,
    body.first_frame_url
  ].some(hasReferenceImageValue);
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

  // Temporary safety stop: block any request containing reference-image input
  // before the core handler can run moderation, create a task, deduct credits,
  // or call OpenRouter. Text-only requests continue through the existing path.
  // Exception: a single allow-listed test user (Supabase user_id set via
  // TEST_BYPASS_USER_ID) may bypass this block. This does not skip the
  // moderation check in the core handler, which still always runs.
  if (hasReferenceImageInput(body)) {
    const bypassUserId = String(process.env.TEST_BYPASS_USER_ID || '').trim();
    let bypassed = false;

    if (bypassUserId) {
      const auth = await requireConfirmedAuth(req);
      if (auth.ok && auth.user?.id === bypassUserId) {
        bypassed = true;
      }
    }

    if (!bypassed) {
      return res.status(503).json({
        ok: false,
        error: 'reference_image_temporarily_disabled',
        errorCategory: 'reference_image_temporarily_disabled',
        message: '現在、参照画像を使った動画生成は一時的に停止しております。テキストのみでの動画生成は通常通りご利用いただけます。再開時期は追ってお知らせします。'
      });
    }
  }

  req.body = {
    ...body,
    model
  };

  return coreHandler(req, res);
};