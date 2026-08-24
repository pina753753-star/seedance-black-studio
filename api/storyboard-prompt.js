// Analyzes a single storyboard image and returns one integrated Japanese
// video-generation prompt (not a per-cut JSON array). This endpoint never
// creates a generation task, never deducts credits, and never calls
// OpenRouter's video-generation endpoint — it only calls OpenRouter's chat
// completions endpoint (Claude) for image analysis. The actual video
// generation continues to go through the existing /api/seedance-start flow
// unchanged, with mode: 'reference_to_video'.
const { requireConfirmedAuth } = require('./_lib/confirmed-auth.js');
const { checkGenerationControl } = require('./_lib/generation-control.js');

const OPENROUTER_CHAT_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const STORYBOARD_MODEL = 'anthropic/claude-sonnet-4-5';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_STORY_CONTEXT_CHARS = 2000;
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

function buildStoryboardAnalysisInstruction(durationSeconds, aspectRatio) {
  return [
    'あなたは、題材・ジャンル・画風・コマ数を限定せず、1枚の絵コンテを忠実に構造化する専門家です。',
    '完成プロンプトはまだ書かず、描かれた事実、コマ順、同一性、状態変化、因果関係だけをJSONへ整理してください。',
    '対象動画: 合計' + durationSeconds + '秒、アスペクト比' + aspectRatio + '。',
    '',
    '解析ルール:',
    '- コマ番号が明確なら番号順を優先し、なければ視覚的な読み順を判定する。',
    '- 全コマを1コマずつ解析し、省略、統合、追加、並べ替えをしない。',
    '- 繰り返し登場する人物、動物、物、場所へ安定したIDを付け、特徴と状態をコマ間で追跡する。',
    '- 変身、体格・服装・表情の変化、物の開閉・破損・中身、保持者の変更を前後関係とともに記録する。',
    '- 最終コマは表情だけでなく、視線、口元、手元、足元、小道具、周囲の登場物の具体的な行動まで確認する。',
    '- 画像にない人物、動物、物、設定、破壊、爆発、光、羽根、武器、攻撃、感情、結末を創作しない。',
    '- 判別できない細部や用途は断定せず uncertain_details に入れる。',
    '- ユーザー補足は画像だけでは分からない関係、意味、感情、状態変化、結末を確定する情報として反映する。',
    '- 枠線、番号、説明文字、吹き出し、ページ番号は映像内容ではなくmetadataとして扱う。',
    '',
    '次のキーだけを持つJSONオブジェクトを返してください:',
    '{"detected_cuts":0,"layout":{"reading_order":[],"metadata":[]},"style":{"medium":"","genre":"","mood":"","palette":[],"lighting":""},"entities":[{"id":"entity_1","type":"","role":"","stable_features":[],"states_by_cut":{}}],"objects":[{"id":"object_1","stable_features":[],"meaning":"","holder_by_cut":{},"state_by_cut":{}}],"environments":[{"id":"environment_1","stable_features":[],"time_by_cut":{},"changes_by_cut":{}}],"cuts":[{"cut_number":1,"visible_facts":[],"entities":[],"actions":[],"expressions":[],"object_states":[],"camera":"","background":"","transition_from_previous":"","transition_to_next":"","dialogue":[],"sound_clues":[],"uncertain_details":[]}],"story":{"setup":"","incident":"","development":"","climax":"","resolution":"","ending":""},"confirmed_context_facts":[],"uncertain_details":[]}',
    'detected_cuts と cuts の要素数を必ず一致させてください。'
  ].join('\n');
}

function buildStoryboardPromptInstruction(durationSeconds, aspectRatio, expectedCuts) {
  const cutCount = Math.max(1, Number(expectedCuts) || 1);
  return [
    'あなたは、構造化済みの絵コンテ解析から、そのまま動画生成へ使用できる詳細な日本語プロンプトを書く専門家です。',
    '特定の題材、登場人物、ジャンル、画風を前提にせず、渡された解析JSONとユーザー補足だけを正本にしてください。',
    '動画: 合計' + durationSeconds + '秒、アスペクト比' + aspectRatio + '、コマ数' + cutCount + '。',
    '',
    '絶対ルール:',
    '- 【秒数ごとの映像】に必ず' + cutCount + '個の時間区間を作り、1コマを1区間へ対応させる。',
    '- コマを省略、統合、追加、並べ替えしない。',
    '- 最初を0秒、最後を' + durationSeconds + '秒にし、時間の空白と重複を作らない。',
    '- 各区間に、状態、具体的な動作、表情、カメラ、速度とタメ、背景、必要な音、次へつながる終了状態を書く。',
    '- 小道具の保持者や状態が変わる場合、その変化が起きる瞬間を省略しない。',
    '- 解析にない人物、動物、物、設定、破壊、爆発、光、羽根、武器、攻撃、感情、結末を追加しない。',
    '- 固有名詞や用途が不明なら創作せず、見た目に基づく中立的な表現を使う。',
    '- 画風、外見、小道具、場所、時間帯、最終コマの意味を変更しない。',
    '- confirmed_context_facts を必ず反映する。',
    '- セリフが確認できない場合はセリフなしとし、人間の言葉を創作しない。',
    '- 音は描かれた動作から自然に発生するものに限定する。',
    '- 使用画像は絵コンテ画像1枚だけ。存在しない設定シートや画像2以降を書かない。',
    '- 枠線、番号、説明文字、吹き出し、余白を映像化しない。',
    '',
    '短い要約ではなく、初心者が追記せず使える具体性にする。ただし解析にない内容で長文化しない。',
    '',
    '必須見出しと順番:',
    '【動画生成｜' + durationSeconds + '秒｜絵コンテ使用】',
    '【基本設定】',
    '【使用する基準画像】',
    '【絵コンテの読み順】',
    '【この動画の目的】',
    '【登場人物・登場物の固定】',
    '【重要な小道具】（該当する場合のみ）',
    '【舞台と時間帯】',
    '【秒数ごとの映像】',
    '【セリフ】',
    '【音・環境音】',
    '【画風固定】',
    '【今回の禁止事項】',
    '',
    '画風固定と禁止事項は解析内容から動的に作り、特定作品の固定例をコピーしない。',
    '出力前に、区間数、時間の連続、全コマ、状態変化、小道具、補足、最終コマ、勝手な追加がないことを自己確認する。',
    '次のJSONだけを返してください:',
    '{"prompt":"必須見出しを含む完成プロンプト","detected_cuts":' + cutCount + '}'
  ].join('\n');
}

function buildStoryboardRepairInstruction(durationSeconds, aspectRatio, expectedCuts) {
  return [
    'あなたは動画プロンプトの最終校正担当です。構造化解析を正本にし、下書きの構造違反だけを修正してください。',
    '新しい内容は追加しないでください。',
    '時間区間を必ず' + expectedCuts + '個にし、0秒から' + durationSeconds + '秒まで空白・重複なく配分してください。',
    'アスペクト比' + aspectRatio + '、必須見出し、コマ順、状態変化、小道具、最終コマを維持してください。',
    '次のJSONだけを返してください:',
    '{"prompt":"修正済み完成プロンプト","detected_cuts":' + expectedCuts + '}'
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

function extractTimelineRanges(prompt) {
  const start = prompt.indexOf('【秒数ごとの映像】');
  if (start < 0) return [];
  const tail = prompt.slice(start + '【秒数ごとの映像】'.length);
  const nextHeading = tail.search(/\n【(?:セリフ|音・環境音|音・声)】/);
  const section = nextHeading >= 0 ? tail.slice(0, nextHeading) : tail;
  const ranges = [];
  const re = /(\d+(?:\.\d+)?)\s*(?:〜|~|－|-|–|—)\s*(\d+(?:\.\d+)?)\s*秒/g;
  let match;
  while ((match = re.exec(section))) ranges.push([Number(match[1]), Number(match[2])]);
  return ranges;
}

function validateFinalPrompt(prompt, expectedCuts, durationSeconds) {
  const required = ['【基本設定】', '【使用する基準画像】', '【絵コンテの読み順】', '【この動画の目的】', '【登場人物・登場物の固定】', '【舞台と時間帯】', '【秒数ごとの映像】', '【セリフ】', '【音・環境音】', '【画風固定】', '【今回の禁止事項】'];
  const ranges = extractTimelineRanges(prompt);
  const headingsOk = required.every((heading) => prompt.includes(heading));
  const rangesOk = ranges.length === expectedCuts
    && ranges[0]?.[0] === 0
    && ranges[ranges.length - 1]?.[1] === durationSeconds
    && ranges.every((range, index) => range[1] > range[0] && (index === 0 || range[0] === ranges[index - 1][1]));
  return { ok: headingsOk && rangesOk && prompt.length >= 700, headingsOk, rangesOk, ranges };
}

async function callClaude(apiKey, messages, maxTokens) {
  const response = await fetch(OPENROUTER_CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'content-type': 'application/json',
      'HTTP-Referer': 'https://flowvid-studio.vercel.app',
      'X-Title': 'FlowVid Studio'
    },
    body: JSON.stringify({ model: STORYBOARD_MODEL, max_tokens: maxTokens, messages })
  });
  const rawText = await response.text();
  let data;
  try { data = JSON.parse(rawText); } catch (_) { data = { error: rawText.slice(0, 300) }; }
  return { response, data };
}

function unavailable(res) {
  return res.status(503).json({
    ok: false,
    error: 'storyboard_prompt_unavailable',
    message: '現在プロンプトを作成できません。しばらくしてからもう一度お試しください。'
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  // Authentication: confirmed-email users only, mirroring every other
  // generation-adjacent endpoint (seedance-start.js, upload-reference-image.js).
  const auth = await requireConfirmedAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json(auth.body);
  }

  // Do not spend OpenRouter chat-completion cost while all new video work is
  // stopped. The same fail-closed control is shared with generation/editing.
  const generationControl = await checkGenerationControl(auth.supabase);
  if (!generationControl.ok) {
    return res.status(generationControl.status).json(generationControl.body);
  }

  // 2026-08-14: TEST_BYPASS_USER_ID限定のベータ提供を解除(api/seedance-start-priced.js参照)。

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
  const storyContext = String(body.storyContext || body.story_context || '').trim();

  if (!image) return res.status(400).json({ ok: false, error: 'image (base64) is required.' });
  if (!ALLOWED_MIME_TYPES.has(mediaType)) {
    return res.status(415).json({ ok: false, error: `mediaType must be one of: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}` });
  }
  if (storyContext.length > MAX_STORY_CONTEXT_CHARS) {
    return res.status(400).json({
      ok: false,
      error: 'story_context_too_long',
      message: `補足指示は${MAX_STORY_CONTEXT_CHARS}文字以内で入力してください。`
    });
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

  // Image validation can take place after the first check. Recheck at the
  // OpenRouter boundary so an analysis that has not been sent yet stops.
  const preSendControl = await checkGenerationControl(auth.supabase);
  if (!preSendControl.ok) {
    return res.status(preSendControl.status).json(preSendControl.body);
  }

  const contextBlock = storyContext
    ? '\n\n<user_story_context>\n' + storyContext + '\n</user_story_context>\nこの補足は画像だけでは分からない意味を確定する情報です。'
    : '';

  let analysisCall;
  try {
    analysisCall = await callClaude(apiKey, [
      { role: 'system', content: buildStoryboardAnalysisInstruction(durationSeconds, aspectRatio) },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:' + mediaType + ';base64,' + image } },
          { type: 'text', text: '絵コンテを読み順どおりに構造化し、指定JSONだけを返してください。' + contextBlock }
        ]
      }
    ], 3000);
  } catch (_) {
    return unavailable(res);
  }
  if (!analysisCall.response.ok) return unavailable(res);

  const analysisText = String(analysisCall.data?.choices?.[0]?.message?.content ?? '');
  const analysis = extractJsonObject(analysisText);
  const cuts = Array.isArray(analysis?.cuts) ? analysis.cuts : [];
  if (!analysis || cuts.length < 1 || cuts.length > 30) return unavailable(res);
  const expectedCuts = cuts.length;
  analysis.detected_cuts = expectedCuts;

  let writerCall;
  try {
    writerCall = await callClaude(apiKey, [
      { role: 'system', content: buildStoryboardPromptInstruction(durationSeconds, aspectRatio, expectedCuts) },
      {
        role: 'user',
        content: '次の構造化解析を正本として完成プロンプトを作成してください。\n\n<storyboard_analysis>\n'
          + JSON.stringify(analysis) + '\n</storyboard_analysis>' + contextBlock
      }
    ], 4000);
  } catch (_) {
    return unavailable(res);
  }
  if (!writerCall.response.ok) return unavailable(res);

  let parsed = extractJsonObject(String(writerCall.data?.choices?.[0]?.message?.content ?? ''));
  let prompt = String(parsed?.prompt || '').trim();
  let validation = validateFinalPrompt(prompt, expectedCuts, durationSeconds);

  if (!parsed || Number(parsed.detected_cuts) !== expectedCuts || !validation.ok) {
    let repairCall;
    try {
      repairCall = await callClaude(apiKey, [
        { role: 'system', content: buildStoryboardRepairInstruction(durationSeconds, aspectRatio, expectedCuts) },
        {
          role: 'user',
          content: '<storyboard_analysis>\n' + JSON.stringify(analysis)
            + '\n</storyboard_analysis>\n\n<draft_prompt>\n' + prompt
            + '\n</draft_prompt>\n\n構造違反を修正し、指定JSONだけを返してください。'
        }
      ], 4000);
    } catch (_) {
      return unavailable(res);
    }
    if (!repairCall.response.ok) return unavailable(res);
    parsed = extractJsonObject(String(repairCall.data?.choices?.[0]?.message?.content ?? ''));
    prompt = String(parsed?.prompt || '').trim();
    validation = validateFinalPrompt(prompt, expectedCuts, durationSeconds);
  }

  if (!parsed || Number(parsed.detected_cuts) !== expectedCuts || !validation.ok) return unavailable(res);
  return res.status(200).json({ ok: true, prompt, detected_cuts: expectedCuts });
};

module.exports.buildStoryboardPromptInstruction = buildStoryboardPromptInstruction;
module.exports.buildStoryboardAnalysisInstruction = buildStoryboardAnalysisInstruction;
module.exports.buildStoryboardRepairInstruction = buildStoryboardRepairInstruction;
module.exports.extractTimelineRanges = extractTimelineRanges;
module.exports.validateFinalPrompt = validateFinalPrompt;
module.exports.MAX_STORY_CONTEXT_CHARS = MAX_STORY_CONTEXT_CHARS;
