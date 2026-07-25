// Analyzes a single storyboard image and returns one integrated Japanese
// video-generation prompt (not a per-cut JSON array). This endpoint never
// creates a generation task, never deducts credits, and never calls
// OpenRouter's video-generation endpoint — it only calls OpenRouter's chat
// completions endpoint (Claude) for image analysis. The actual video
// generation continues to go through the existing /api/seedance-start flow
// unchanged, with mode: 'reference_to_video'.
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');

const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const STORYBOARD_MODEL = 'anthropic/claude-sonnet-4-5';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MIN_DURATION = 1;
const MAX_DURATION = 15;

// Simple in-memory per-user cooldown. Best-effort only: separate Vercel
// function instances / cold starts each have their own memory, so this does
// not guarantee a strict global limit across all instances. It only reduces
// accidental rapid repeat calls from a single warm instance.
const COOLDOWN_MS = 8000;
const lastCallAt = new Map();

function jsonBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
  }
  return req.body || {};
}

function normalizeDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return 5;
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(duration)));
}

function normalizeAspectRatio(value) {
  const aspect = String(value || '9:16').trim();
  return ['9:16', '16:9', '1:1'].includes(aspect) ? aspect : '9:16';
}

function buildStoryboardPromptInstruction(durationSeconds, aspectRatio) {
  return [
    'あなたは動画プロンプト作成の専門家です。',
    'アップロードされた絵コンテ画像(複数カットが描かれた1枚の画像)を解析し、',
    `合計${durationSeconds}秒・アスペクト比${aspectRatio}の動画を1回で生成するための、`,
    '日本語の単一の統合ビデオ生成プロンプトを1つだけ作成してください。',
    '',
    '要件:',
    '- 出力はカットごとのJSON配列ではなく、1つの連続した日本語の文章によるプロンプトにすること。',
    `- プロンプト文中に、0秒から${durationSeconds}秒までの時間帯ごとの展開を明記すること`,
    '  (例:「0〜2秒は〜、2〜5秒は〜」のように、絵コンテのカット数に応じて時間帯を配分する)。',
    '- 合計時間が指定秒数に収まるよう配分すること。',
    '- 登場人物の外見・服装・背景・画風がカットを通して一貫するよう、プロンプト内で明記すること。',
    '- 絵コンテ画像内のコマ割りの枠線、説明文字、吹き出し、ページ番号などのメタ情報は',
    '  映像化しないことをプロンプト内に明記すること。',
    '',
    '出力は次のキーだけを持つJSONオブジェクトのみとしてください。説明文や前後のテキストは不要です。',
    '{"prompt": "統合ビデオ生成プロンプトの本文", "detected_cuts": 絵コンテから検出したカット数（整数）}'
  ].join('\n');
}

function extractJsonObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text.trim();
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const objMatch = text.match(/\{[\s\S]*\}/);
    if (!objMatch) return null;
    try {
      return JSON.parse(objMatch[0]);
    } catch (_2) {
      return null;
    }
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  // Authentication: confirmed-email users only, mirroring every other
  // generation-adjacent endpoint (seedance-start.js, upload-reference-image.js).
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  // Reference-image generation is still temporarily paused site-wide
  // (see api/seedance-start-priced.js). Mirror the same bypass so a
  // non-bypass user cannot use this endpoint to get a free analysis that
  // can never actually be turned into a video (it would always 503 later
  // at the real generation step). Apply this check before calling Claude.
  const bypassUserId = String(process.env.TEST_BYPASS_USER_ID || '').trim();
  const bypassed = Boolean(bypassUserId) && auth.user?.id === bypassUserId;
  if (!bypassed) {
    return res.status(503).json({
      ok: false,
      error: 'reference_image_temporarily_disabled',
      errorCategory: 'reference_image_temporarily_disabled',
      message: '現在、参照画像を使った動画生成は一時的に停止しております。テキストのみでの動画生成は通常通りご利用いただけます。再開時期は追ってお知らせします。'
    });
  }

  // Simple best-effort cooldown to prevent rapid repeat calls from the same user.
  const userId = auth.user.id;
  const now = Date.now();
  const last = lastCallAt.get(userId) || 0;
  if (now - last < COOLDOWN_MS) {
    return res.status(429).json({
      ok: false,
      error: 'too_many_requests',
      message: '少し間隔を空けてからもう一度お試しください。'
    });
  }
  lastCallAt.set(userId, now);

  const apiKey = process.env.OPENROUTER_API_KEY || '';
  if (!apiKey) return res.status(500).json({ ok: false, error: 'OPENROUTER_API_KEY is not configured.' });

  const body = jsonBody(req);
  const image = String(body.image || '').trim();
  const mediaType = String(body.mediaType || 'image/jpeg').toLowerCase();

  if (!image) return res.status(400).json({ ok: false, error: 'image (base64) is required.' });
  if (!ALLOWED_MIME_TYPES.has(mediaType)) {
    return res.status(415).json({ ok: false, error: `mediaType must be one of: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}` });
  }

  let imageBuffer;
  try {
    imageBuffer = Buffer.from(image, 'base64');
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'image must be valid base64.' });
  }
  if (imageBuffer.length === 0) {
    return res.status(400).json({ ok: false, error: 'image must be valid base64.' });
  }
  if (imageBuffer.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ ok: false, error: 'Image exceeds 10 MB limit' });
  }

  const durationSeconds = normalizeDuration(body.durationSeconds || body.duration);
  const aspectRatio = normalizeAspectRatio(body.aspectRatio || body.aspect_ratio);

  let response, data;
  try {
    response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
        'HTTP-Referer': 'https://flowvid-studio.vercel.app',
        'X-Title': 'FlowVid Studio'
      },
      body: JSON.stringify({
        model: STORYBOARD_MODEL,
        max_tokens: 1500,
        messages: [
          {
            role: 'system',
            content: buildStoryboardPromptInstruction(durationSeconds, aspectRatio)
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${image}` } },
              { type: 'text', text: '上記の絵コンテ画像を解析し、指示に従ってJSONのみ返してください。' }
            ]
          }
        ]
      })
    });
    const rawText = await response.text();
    try { data = JSON.parse(rawText); } catch (_) { data = { error: rawText.slice(0, 300) }; }
  } catch (err) {
    // Network error / timeout: fail closed, same posture as moderation failures.
    return res.status(503).json({
      ok: false,
      error: 'storyboard_prompt_unavailable',
      message: '現在プロンプトを作成できません。しばらくしてからもう一度お試しください。'
    });
  }

  if (!response.ok) {
    return res.status(503).json({
      ok: false,
      error: 'storyboard_prompt_unavailable',
      message: '現在プロンプトを作成できません。しばらくしてからもう一度お試しください。'
    });
  }

  const text = String(data?.choices?.[0]?.message?.content ?? '');
  const parsed = extractJsonObject(text);
  const prompt = String(parsed?.prompt || '').trim();
  if (!parsed || !prompt) {
    return res.status(503).json({
      ok: false,
      error: 'storyboard_prompt_unavailable',
      message: '現在プロンプトを作成できません。しばらくしてからもう一度お試しください。'
    });
  }

  const detectedCuts = Number.isFinite(Number(parsed?.detected_cuts)) ? Number(parsed.detected_cuts) : null;

  return res.status(200).json({ ok: true, prompt, detected_cuts: detectedCuts });
};
