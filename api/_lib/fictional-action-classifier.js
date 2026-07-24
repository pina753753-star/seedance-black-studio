'use strict';

const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5-nano-2025-08-07';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_REVIEW_IMAGES = 9;

const REQUIRED_BOOLEAN_FIELDS = [
  'fictional_setting',
  'adult_or_nonhuman_only',
  'real_person_target',
  'minor_harm',
  'graphic_injury',
  'lethal_or_maiming_action',
  'torture_or_execution',
  'sexual_violence',
  'weapon_instruction',
  'effects_hide_serious_harm',
  'non_graphic_action'
];

const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...REQUIRED_BOOLEAN_FIELDS],
  properties: Object.fromEntries(
    REQUIRED_BOOLEAN_FIELDS.map((field) => [field, { type: 'boolean' }])
  )
};

function normalizeCategories(categories) {
  return [...new Set((Array.isArray(categories) ? categories : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))].sort();
}

function normalizeAppliedInputTypes(value) {
  if (!value || typeof value !== 'object') return {};
  const normalized = {};
  for (const [category, inputTypes] of Object.entries(value)) {
    normalized[category] = [...new Set((Array.isArray(inputTypes) ? inputTypes : [])
      .map((type) => String(type || '').trim())
      .filter(Boolean))];
  }
  return normalized;
}

function normalizeImageUrls(imageUrls) {
  return [...new Set((Array.isArray(imageUrls) ? imageUrls : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https:\/\//i.test(url)))].slice(0, MAX_REVIEW_IMAGES);
}

function isViolenceOnly(categories) {
  const normalized = normalizeCategories(categories);
  return normalized.length === 1 && normalized[0] === 'violence';
}

function violenceComesFromTextOnly(categoryAppliedInputTypes) {
  const normalized = normalizeAppliedInputTypes(categoryAppliedInputTypes);
  const types = normalized.violence || [];
  return types.length > 0
    && types.every((type) => type === 'text')
    && !types.includes('image');
}

function shouldRunFictionalActionClassifier(moderation) {
  if (!moderation || moderation.ok !== true || moderation.flagged !== true) {
    return { run: false, reason: 'not_flagged' };
  }
  if (!isViolenceOnly(moderation.categories)) {
    return { run: false, reason: 'not_violence_only' };
  }

  const normalized = normalizeAppliedInputTypes(
    moderation.categoryAppliedInputTypes
  );
  const types = normalized.violence || [];
  if (types.length === 0 || types.some((type) => !['text', 'image'].includes(type))) {
    return { run: false, reason: 'violence_input_source_unknown' };
  }

  if (types.includes('image')) {
    const imageUrls = normalizeImageUrls(moderation.flaggedImageUrls);
    if (imageUrls.length === 0) {
      return { run: false, reason: 'image_violence_missing_review_inputs' };
    }
    return { run: true, reason: 'image_violence_reviewable' };
  }

  return { run: true, reason: 'text_violence_only' };
}

function safeErrorDetail(response, data) {
  const error = data?.error && typeof data.error === 'object' ? data.error : {};
  return {
    httpStatus: response?.status || null,
    type: typeof error.type === 'string' ? error.type : null,
    code: typeof error.code === 'string' ? error.code : null,
    requestId: response?.headers?.get?.('x-request-id')
      || response?.headers?.get?.('request-id')
      || null
  };
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }
  if (!Array.isArray(data?.output)) return '';
  for (const item of data.output) {
    if (!Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (typeof content?.text === 'string' && content.text.trim()) {
        return content.text.trim();
      }
    }
  }
  return '';
}

function allSafetyConditionsSatisfied(value) {
  return value.fictional_setting === true
    && value.adult_or_nonhuman_only === true
    && value.real_person_target === false
    && value.minor_harm === false
    && value.graphic_injury === false
    && value.lethal_or_maiming_action === false
    && value.torture_or_execution === false
    && value.sexual_violence === false
    && value.weapon_instruction === false
    && value.effects_hide_serious_harm === false
    && value.non_graphic_action === true;
}

function detectClassificationContradictions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const contradictions = [];
  if (value.adult_or_nonhuman_only === true && value.minor_harm === true) {
    contradictions.push('adult_only_with_minor_harm');
  }
  if (value.non_graphic_action === true && value.graphic_injury === true) {
    contradictions.push('non_graphic_with_graphic_injury');
  }
  if (value.non_graphic_action === true && value.effects_hide_serious_harm === true) {
    contradictions.push('non_graphic_with_hidden_serious_harm');
  }
  return [...new Set(contradictions)];
}

function validateClassification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_object' };
  }
  for (const field of REQUIRED_BOOLEAN_FIELDS) {
    if (typeof value[field] !== 'boolean') {
      return { ok: false, reason: `invalid_${field}` };
    }
  }
  const keys = Object.keys(value);
  if (
    keys.length !== REQUIRED_BOOLEAN_FIELDS.length
    || keys.some((key) => !REQUIRED_BOOLEAN_FIELDS.includes(key))
  ) {
    return { ok: false, reason: 'unexpected_classification_field' };
  }

  const allow = allSafetyConditionsSatisfied(value);
  return {
    ok: true,
    allow,
    reason: allow
      ? 'safe_fictional_non_graphic_action'
      : 'classification_blocked',
    classification: value
  };
}

function buildClassifierPrompt(prompt, contradictions = [], hasImages = false) {
  const lines = [
    'Classify the requested video scene for a narrow safety exception.',
    'Allow only clearly fictional anime/cartoon action involving adults, non-human characters, or ordinary original fictional characters with no concrete minor indicator.',
    hasImages
      ? 'Inspect the user prompt and every supplied reference image together. Do not ignore visible blood, wounds, victims, real people, minors, or weapon instruction in an image.'
      : 'Classify the user prompt only.',
    '',
    'Return only the eleven boolean fields defined by the schema.',
    'The application computes the final result from the individual boolean fields.',
    '',
    'Safety rules:',
    '- fictional_setting is true only when the scene is clearly fictional, animated, illustrated, game-like, or otherwise not a real-world depiction.',
    '- adult_or_nonhuman_only is false if any relevant person is explicitly a child, minor, underage, school-age, or has another concrete minor indicator.',
    '- Do not infer minor status solely from anime style, large eyes, short stature, cute appearance, girl, boy, 女の子, or 男の子.',
    '- real_person_target is true when a real identifiable person is targeted, impersonated, attacked, or depicted without a clearly fictional-original context.',
    '- minor_harm is true for any violence, injury, threat, or sexual content involving a minor.',
    '- graphic_injury is true for heavy or extensive blood, open wounds, visible organs, gore, dismemberment, severed limbs, exposed bone, or emphasized corpses.',
    '- lethal_or_maiming_action is true for killing, execution, dismemberment, amputation, deliberate crippling, or a clearly lethal shooting or stabbing.',
    '- torture_or_execution is true for torture, execution, prolonged suffering, or sadistic harm.',
    '- sexual_violence is true for any sexual assault, coercion, or sexualized violence.',
    '- weapon_instruction is true for practical real-world instructions to build, modify, aim, operate, or use a weapon to injure someone. Mere fictional weapon presence or ordinary non-instructional action is not enough.',
    '- effects_hide_serious_harm is true when flashes, smoke, silhouettes, or camera cuts merely conceal an otherwise serious stabbing, shooting, killing, or dismemberment.',
    '- non_graphic_action is true only for general-audience action such as pursuit, evasion, vehicle action, fantasy combat, sparks, smoke, energy effects, or non-graphic impacts without serious visible injury.',
    '',
    'Weapons may appear in a fictional action scene, but heavy blood, gore, open wounds, killing, maiming, torture, execution, sexual violence, harm to minors, real-person targeting, and practical weapon instruction must remain blocked.',
    'When required safety facts are genuinely unclear, use the safer value. Do not relax any safety rule.'
  ];

  if (contradictions.length > 0) {
    lines.push(
      '',
      'Your previous structured result was internally inconsistent.',
      `Detected contradictions: ${contradictions.join(', ')}`,
      'Re-evaluate the same prompt and images and return a logically consistent classification.'
    );
  }

  lines.push('', 'User prompt:', String(prompt || '').trim());
  return lines.join('\n');
}

async function requestStructuredClassification(prompt, contradictions, options) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;
  const imageUrls = normalizeImageUrls(options.imageUrls);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const userContent = [{
    type: 'input_text',
    text: buildClassifierPrompt(prompt, contradictions, imageUrls.length > 0)
  }];
  for (const imageUrl of imageUrls) {
    userContent.push({ type: 'input_image', image_url: imageUrl });
  }

  try {
    const response = await fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        store: false,
        reasoning: { effort: 'minimal' },
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: 'Return only the requested structured classification. Be conservative.'
            }]
          },
          { role: 'user', content: userContent }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'fictional_action_safety',
            strict: true,
            schema: CLASSIFICATION_SCHEMA
          }
        }
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch (_) {
      return { ok: false, allow: false, errorCode: 'invalid_json', httpStatus: response.status };
    }
    if (!response.ok) {
      return {
        ok: false,
        allow: false,
        errorCode: 'openai_http_error',
        httpStatus: response.status,
        errorDetail: safeErrorDetail(response, data)
      };
    }

    const outputText = extractOutputText(data);
    if (!outputText) return { ok: false, allow: false, errorCode: 'missing_output_text' };

    let parsed;
    try {
      parsed = JSON.parse(outputText);
    } catch (_) {
      return { ok: false, allow: false, errorCode: 'invalid_structured_output' };
    }

    const validation = validateClassification(parsed);
    if (!validation.ok) {
      return {
        ok: false,
        allow: false,
        errorCode: 'invalid_classification',
        validationReason: validation.reason
      };
    }
    return { ok: true, parsed, validation };
  } catch (error) {
    return {
      ok: false,
      allow: false,
      errorCode: error?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function classifyFictionalAction(prompt, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) return { ok: false, allow: false, errorCode: 'missing_api_key' };

  const text = String(prompt || '').trim();
  if (!text) return { ok: false, allow: false, errorCode: 'empty_prompt' };

  const logger = options.logger || console;
  let retryContradictions = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await requestStructuredClassification(
      text,
      retryContradictions,
      { ...options, apiKey }
    );
    if (!response.ok) return response;

    const contradictions = detectClassificationContradictions(response.parsed);
    if (contradictions.length === 0) {
      return {
        ok: true,
        allow: response.validation.allow,
        reason: response.validation.reason,
        classification: response.validation.classification
      };
    }

    const finalAction = attempt === 1 ? 'retry' : 'fail_closed';
    try {
      logger.warn?.(
        '[fictional-action-classifier] inconsistent classification',
        { contradictions, attempt, finalAction }
      );
    } catch (_) {}

    if (attempt === 1) {
      retryContradictions = contradictions;
      continue;
    }
    return {
      ok: false,
      allow: false,
      errorCode: 'secondary_classifier_inconsistent',
      contradictions
    };
  }

  return {
    ok: false,
    allow: false,
    errorCode: 'secondary_classifier_inconsistent'
  };
}

module.exports = {
  CLASSIFICATION_SCHEMA,
  allSafetyConditionsSatisfied,
  classifyFictionalAction,
  detectClassificationContradictions,
  extractOutputText,
  isViolenceOnly,
  normalizeAppliedInputTypes,
  normalizeCategories,
  shouldRunFictionalActionClassifier,
  validateClassification,
  violenceComesFromTextOnly
};
