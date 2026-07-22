'use strict';

const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5-nano-2025-08-07';
const DEFAULT_TIMEOUT_MS = 10000;

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
  required: [...REQUIRED_BOOLEAN_FIELDS, 'decision'],
  properties: {
    fictional_setting: { type: 'boolean' },
    adult_or_nonhuman_only: { type: 'boolean' },
    real_person_target: { type: 'boolean' },
    minor_harm: { type: 'boolean' },
    graphic_injury: { type: 'boolean' },
    lethal_or_maiming_action: { type: 'boolean' },
    torture_or_execution: { type: 'boolean' },
    sexual_violence: { type: 'boolean' },
    weapon_instruction: { type: 'boolean' },
    effects_hide_serious_harm: { type: 'boolean' },
    non_graphic_action: { type: 'boolean' },
    decision: { type: 'string', enum: ['allow', 'block', 'uncertain'] }
  }
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

  if (Number(moderation.checkedImageCount || 0) > 0) {
    return { run: false, reason: 'secondary_classifier_disabled_for_image_input' };
  }

  if (!violenceComesFromTextOnly(moderation.categoryAppliedInputTypes)) {
    return { run: false, reason: 'violence_not_confirmed_text_only' };
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

function validateClassification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_object' };
  }

  for (const field of REQUIRED_BOOLEAN_FIELDS) {
    if (typeof value[field] !== 'boolean') {
      return { ok: false, reason: `invalid_${field}` };
    }
  }

  if (!['allow', 'block', 'uncertain'].includes(value.decision)) {
    return { ok: false, reason: 'invalid_decision' };
  }

  const safe =
    value.decision === 'allow'
    && value.fictional_setting === true
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

  return {
    ok: true,
    allow: safe,
    reason: safe ? 'safe_fictional_non_graphic_action' : 'classification_blocked',
    classification: value
  };
}

function buildClassifierPrompt(prompt) {
  return [
    'Classify the requested video scene for a narrow safety exception.',
    'Allow only clearly fictional anime/cartoon action involving adults or non-human characters.',
    'Weapons may appear, but only non-graphic action is allowed.',
    'Block real-person targeting, minors being harmed, sexual violence, graphic injury,',
    'killing, maiming, torture, execution, weapon-use instruction, or effects used merely',
    'to conceal an otherwise serious stabbing, shooting, dismemberment, or killing.',
    'When context is missing or ambiguous, use decision "uncertain".',
    '',
    'User prompt:',
    String(prompt || '').trim()
  ].join('\n');
}

async function classifyFictionalAction(prompt, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return { ok: false, allow: false, errorCode: 'missing_api_key' };
  }

  const text = String(prompt || '').trim();
  if (!text) {
    return { ok: false, allow: false, errorCode: 'empty_prompt' };
  }

  const timeoutMs = Number.isFinite(Number(options.timeoutMs))
    ? Math.max(1000, Number(options.timeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_MODEL,
        store: false,
        reasoning: { effort: 'minimal' },
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: 'Return only the requested structured classification. Be conservative.'
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: buildClassifierPrompt(text)
              }
            ]
          }
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
    if (!outputText) {
      return { ok: false, allow: false, errorCode: 'missing_output_text' };
    }

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

    return {
      ok: true,
      allow: validation.allow,
      reason: validation.reason,
      classification: validation.classification
    };
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

module.exports = {
  CLASSIFICATION_SCHEMA,
  classifyFictionalAction,
  extractOutputText,
  isViolenceOnly,
  normalizeAppliedInputTypes,
  normalizeCategories,
  shouldRunFictionalActionClassifier,
  validateClassification,
  violenceComesFromTextOnly
};
