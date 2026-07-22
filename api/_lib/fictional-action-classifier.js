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
  required: [...REQUIRED_BOOLEAN_FIELDS],
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
    non_graphic_action: { type: 'boolean' }
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const contradictions = [];

  // 登場対象が成人または非人間だけなのに、未成年への危害がある。
  if (
    value.adult_or_nonhuman_only === true
    && value.minor_harm === true
  ) {
    contradictions.push('adult_only_with_minor_harm');
  }

  // 非グラフィックなアクションなのに、残虐な負傷がある。
  if (
    value.non_graphic_action === true
    && value.graphic_injury === true
  ) {
    contradictions.push('non_graphic_with_graphic_injury');
  }

  // 非グラフィックなアクションなのに、
  // 重大な危害をエフェクトで隠している。
  if (
    value.non_graphic_action === true
    && value.effects_hide_serious_harm === true
  ) {
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

function buildClassifierPrompt(prompt, contradictions = []) {
  const lines = [
    'Classify the requested video scene for a narrow safety exception.',
    'Allow only clearly fictional anime/cartoon action involving adults or non-human characters.',
    '',
    'Return only the eleven boolean fields defined by the schema.',
    'Do not return an overall decision, allow, block, or uncertain field.',
    'The application computes the final result from the individual boolean fields.',
    '',
    'Age and non-human classification rules:',
    '- Prioritize minor protection for both human and non-human characters.',
    '- Treat a character as a minor when the prompt clearly identifies them as a baby, infant, toddler, child, minor, or underage person, gives an age below adulthood, or gives a grade or school-age status that clearly establishes minor status.',
    '- Explicit child roles or clearly stated child status override a non-human label. A god, spirit, fairy, robot, or other non-human character explicitly described as a child or minor is not covered by the adult-or-non-human exception.',
    '- Do not infer that a character is a minor solely from stylized anime features such as short stature, chibi proportions, a small body, a youthful-looking face, large eyes, or a generally cute or youthful design.',
    '- When the prompt explicitly identifies a character as non-human, such as a god, spirit, fairy, robot, demon, or other fictional non-human being, adult_or_nonhuman_only may be true even if the visual design appears youthful, provided there is no explicit minor or child status.',
    '- A non-human label never relaxes rules for sexual content, sexual violence, child exploitation, or clearly established minor characters.',
    '- If age information conflicts, or there is a concrete reason to believe a relevant character may be a minor, use adult_or_nonhuman_only false.',
    '',
    'Weapons may appear, but only non-graphic action is allowed.',
    'The mere presence or use of a sword, staff, bow, or fictional weapon in an action scene is not weapon-use instruction.',
    'Block real-person targeting, minors being harmed, sexual violence, graphic injury,',
    'killing, maiming, torture, execution, practical weapon-use instruction, or effects used merely',
    'to conceal an otherwise serious stabbing, shooting, dismemberment, or killing.',
    '',
    'Classification example:',
    'A clearly adult human or an explicitly non-human fictional character comically swats at, chases, or battles a mosquito or ordinary pest with exaggerated anime effects, without graphic injury, torture, realistic suffering, sexual content, harm to a minor, harm to a real person, or practical weapon instruction, is ordinarily non-graphic action.',
    'The mere attempt to repel or defeat an insect does not by itself constitute lethal_or_maiming_action, torture_or_execution, or weapon_instruction.',
    'This example does not apply when the prompt depicts graphic crushing, dismemberment, prolonged suffering, torture, sexual content, harm to a minor, harm to a real person, or practical instructions for injuring living beings.',
    '',
    'For each field, classify only facts that are clearly stated or necessarily implied by the prompt.',
    'When a fact required for the safety exception is genuinely unclear, use the safer value for the required safety field:',
    '- use fictional_setting false unless the setting is clearly fictional;',
    '- use adult_or_nonhuman_only false unless every relevant character is clearly adult or explicitly non-human;',
    '- use non_graphic_action false unless the action is clearly non-graphic.',
    'Set a hazard field to true when that hazard is clearly present or necessarily implied.',
    'Do not mark every hazard field true merely because some unrelated detail is ambiguous.',
    'Do not relax any safety rule.'
  ];

  if (contradictions.length > 0) {
    lines.push(
      '',
      'Your previous structured result was internally inconsistent.',
      `Detected contradictions: ${contradictions.join(', ')}`,
      'Re-evaluate the original request and return a logically consistent classification.',
      'Do not relax any safety rule.',
      'Do not assume that an ambiguous human person is an adult.',
      'Apply the age and non-human classification rules above exactly.'
    );
  }

  lines.push(
    '',
    'User prompt:',
    String(prompt || '').trim()
  );

  return lines.join('\n');
}

async function requestStructuredClassification(prompt, contradictions, options) {
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
                text: buildClassifierPrompt(prompt, contradictions)
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
      parsed,
      validation
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

async function classifyFictionalAction(prompt, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    return {
      ok: false,
      allow: false,
      errorCode: 'missing_api_key'
    };
  }

  const text = String(prompt || '').trim();

  if (!text) {
    return {
      ok: false,
      allow: false,
      errorCode: 'empty_prompt'
    };
  }

  const logger = options.logger || console;
  let retryContradictions = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await requestStructuredClassification(
      text,
      retryContradictions,
      {
        ...options,
        apiKey
      }
    );

    if (!response.ok) {
      return response;
    }

    const contradictions = detectClassificationContradictions(
      response.parsed
    );

    if (contradictions.length === 0) {
      return {
        ok: true,
        allow: response.validation.allow,
        reason: response.validation.reason,
        classification: response.validation.classification
      };
    }

    const finalAction = attempt === 1
      ? 'retry'
      : 'fail_closed';

    try {
      logger.warn?.(
        '[fictional-action-classifier] inconsistent classification',
        {
          contradictions,
          attempt,
          finalAction
        }
      );
    } catch (_) {
      // Diagnostic logging must never change the safety decision.
    }

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
