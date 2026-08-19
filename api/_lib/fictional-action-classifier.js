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
    && value.real_person_target === false
    && value.minor_harm === false
    && value.graphic_injury === false
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
  if (value.minor_harm === true && value.non_graphic_action === true) {
    contradictions.push('minor_harm_with_non_graphic_action');
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
    'Evaluate ordinary Japanese-anime-style fantasy, adventure, transformation, comedy, and action by what happens in the scene, not by youthful character design alone.',
    hasImages
      ? 'Inspect the user prompt and every supplied reference image together. Do not ignore visible blood, wounds, victims, real people, minors, or weapon instruction in an image.'
      : 'Classify the user prompt only.',
    '',
    'Return only the eleven boolean fields defined by the schema.',
    'Do not return an overall decision, allow, block, or uncertain field.',
    'The application computes the final result from the individual boolean fields.',
    '',
    'Safety rules:',
    '- fictional_setting is true only when the scene is clearly fictional, animated, illustrated, game-like, or otherwise not a real-world depiction.',
    '- Prioritize minor protection for both human and non-human characters.',
    '- adult_or_nonhuman_only is false only when a relevant character is explicitly a child, minor, underage, gives an age below adulthood, or has a grade or school-age status that clearly establishes minor status.',
    '- Do not infer that a character is a minor solely from stylized anime features or ambiguous youthful wording such as short stature, chibi proportions, a small body, a youthful-looking face, large eyes, cute, girl, boy, 女の子, or 男の子.',
    '- Trust explicit adult or non-human descriptions in the user prompt. adult_or_nonhuman_only should be true unless the prompt also contains a clear and conflicting minor or child status.',
    '- A clearly fictional original anime, manga, cartoon, game, or illustrated character may satisfy adult_or_nonhuman_only when there is no concrete minor indicator.',
    '- Do not require an exact numeric adult age for an ordinary original fictional anime character with no concrete minor indicator.',
    '- If an ordinary original fictional character has no exact age and no concrete minor indicator, adult_or_nonhuman_only may be true. Do not infer minor status from anime style alone.',
    '- Do not set adult_or_nonhuman_only false merely because an ordinary original fictional anime character has no exact age.',
    '- A god, spirit, fairy, robot, demon, or other non-human character explicitly described as a child or minor is not covered by the adult-or-non-human exception.',
    '- A non-human or original-fictional label never relaxes rules for sexual content, sexual violence, child exploitation, or clearly established minor characters.',
    '- Explicit child roles or clearly stated child status override an adult-sounding, fictional, or non-human label.',
    '- If age information conflicts, or there is a concrete reason to believe a relevant character may be a minor, use adult_or_nonhuman_only false.',
    '- adult_or_nonhuman_only is age-context information. Youthful appearance alone is not a block for safe, fictional, non-sexual, non-graphic general-audience action.',
    '',
    'General-audience anime action rules:',
    '- A youthful-looking or explicitly minor original anime character, deity, spirit, fairy, or other fictional being may transform, cast magic, pursue, evade, defend, or fight a fantasy creature when the scene has no sexual content, actual injury, graphic injury, killing, maiming, torture, targeted child abuse, or exploitation.',
    '- Mere participation by a young-looking or explicitly minor fictional character in a general-audience fantasy adventure or non-graphic fantasy battle is not minor_harm.',
    '- A non-injurious fantasy attack, pursuit, dodge, defense, duel, magical impact, or comedic scuffle involving a clearly fictional minor is not by itself minor_harm.',
    '- minor_harm is true when a character with a concrete minor indicator is the target or victim of actual injury, abuse, exploitation, sexual content, targeted realistic assault, cruelty, torture, prolonged suffering, or other actual harm.',
    '- Using an explicitly minor character as a child soldier, or targeting an explicitly minor character with realistic human or militarized violence, is exploitation or targeted realistic assault: set minor_harm true and non_graphic_action false.',
    '- The general-audience fantasy exception does not cover child soldiers, realistic armed attacks on minors, domestic abuse, bullying presented as actual harm, sexual content, or exploitation.',
    '- When minor_harm is true, non_graphic_action must be false. Do not label targeted harm to a concrete minor as safe general-audience action.',
    '',
    'Supporting and background character rules:',
    '- In a clearly fictional original anime, manga, cartoon, or game scene, an unnamed supporting or background character may satisfy adult_or_nonhuman_only when there is no concrete minor indicator.',
    '- This includes ordinary fictional enemy soldiers, guards, masked or helmeted combatants, bystanders, crowds, and other unnamed characters.',
    '- Do not set adult_or_nonhuman_only to false solely because a supporting character\'s exact age is not stated, their face is hidden, or they appear only briefly or in the background.',
    '- A masked, helmeted, or unidentified character is not presumed to be a minor. Evaluate only concrete age or child-status evidence.',
    '- If any supporting or background character has an explicit age below adulthood, child role, school-age status, grade, or another concrete minor indicator, adult_or_nonhuman_only must be false for the entire scene.',
    '- These rules apply only to clearly fictional original characters and never override minor protection, sexual-content rules, real-person protection, or graphic-violence restrictions.',
    '',
    '- real_person_target is true when a real identifiable person is targeted, impersonated, attacked, or depicted without a clearly fictional-original context.',
    '- minor_harm is true for actual injury, abuse, exploitation, sexual content, targeted realistic assault, cruelty, torture, prolonged suffering, or other actual harm involving a minor. Do not mark ordinary non-injurious general-audience fantasy action as minor_harm solely because a fictional minor participates.',
    '- graphic_injury is true for heavy or extensive blood, open wounds, visible organs, gore, dismemberment, severed limbs, exposed bone, or emphasized corpses.',
    '- lethal_or_maiming_action is true for killing, dismemberment, amputation, deliberate crippling, or a clearly lethal shooting or stabbing. This field is diagnostic and does not by itself make an otherwise safe fictional non-graphic action disallowed.',
    '- torture_or_execution is true for torture, execution, prolonged suffering, or sadistic harm.',
    '- sexual_violence is true for any sexual assault, coercion, or sexualized violence.',
    '- weapon_instruction is true for practical real-world instructions to build, modify, aim, operate, or use a weapon to injure someone. Mere fictional weapon presence, shot counts, fictional weak points, action choreography, camera directions, or ordinary non-instructional action are not enough.',
    '- effects_hide_serious_harm is true when flashes, smoke, silhouettes, or camera cuts merely conceal an otherwise serious stabbing, shooting, killing, or dismemberment.',
    '- non_graphic_action is true for general-audience action such as pursuit, evasion, vehicle action, fantasy combat, sparks, smoke, energy effects, or non-graphic impacts without serious visible injury.',
    '- lethal_or_maiming_action and non_graphic_action are independent diagnostics. In a clearly fictional scene, an implied defeat or lethal outcome may set lethal_or_maiming_action true and non_graphic_action true at the same time when there is no serious visible injury, blood, open wound, gore, dismemberment, emphasized corpse, prolonged suffering, torture, execution, real-person targeting, or minor harm.',
    '- For original anime action against a fantasy monster, armored beast, robot, drone, or machine, shots or strikes against a fictional core, armor, joints, controls, or weak points; sparks; loss of power; collapse; shutdown; destruction; or defeat are non_graphic_action when no serious visible injury, blood, open wound, gore, dismemberment, or suffering is shown.',
    '- Do not set non_graphic_action false solely because a fictional enemy is defeated, stops moving, loses power, or the attack is described as a finishing move. Evaluate the visible injury and protected-target facts instead.',
    '- An ordinary original fictional anime character with no concrete minor indicator may comically swat at, chase, or battle a mosquito or ordinary pest; this is ordinarily non-graphic action and does not by itself constitute lethal_or_maiming_action.',
    '- Block pest scenes that add graphic crushing, dismemberment, prolonged suffering, torture, sexual content, harm to a minor, harm to a real person, or practical instructions for injuring living beings.',
    '',
    'Examples:',
    '- An original fictional spirit with a youthful anime design raises a magical staff. Set adult_or_nonhuman_only true because the character is explicitly non-human and no minor or child status is stated.',
    '- An adult woman from the reference character sheet comically battles a mosquito in a fictional anime scene. Set adult_or_nonhuman_only true because the character is explicitly described as an adult woman and there is no conflicting concrete minor indicator.',
    '- An ordinary original anime heroine with no stated age dodges a fantasy dragon and uses a glowing shield without injury. Treat this as safe non-graphic action; do not infer minor status from appearance or missing age.',
    '- A 12-year-old fairy child uses a magical shield against a monster without injury. Set adult_or_nonhuman_only false, minor_harm false, and non_graphic_action true: the explicit minor status is recorded, but ordinary non-injurious fantasy action remains allowed.',
    '- A middle-school student comically chases a mosquito with a fantasy sword without injury. Set adult_or_nonhuman_only false, minor_harm false, and non_graphic_action true: the school status establishes a minor, but does not by itself make the general-audience action harmful.',
    '- A 12-year-old child is wounded, abused, sexually exploited, tortured, or subjected to targeted realistic assault. Set adult_or_nonhuman_only false, minor_harm true, and non_graphic_action false.',
    '- A 16-year-old enemy soldier or a child soldier is attacked in a militarized battle. Set adult_or_nonhuman_only false, minor_harm true, and non_graphic_action false because this is child exploitation or targeted realistic assault, not ordinary fantasy adventure.',
    '- For scenes with multiple relevant characters, evaluate every character. If any relevant character has a concrete minor indicator, adult_or_nonhuman_only must be false for the whole scene.',
    '- An adult woman and a 12-year-old fairy fight together. adult_or_nonhuman_only must be false because one relevant character has an explicit minor indicator.',
    '- In an original Japanese-anime-style gun action, an adult heroine and a black panther coordinate precise shots against the glowing core of a red armored beast. The beast emits sparks, loses power, and stops without blood, wounds, dismemberment, suffering, or an execution. Set fictional_setting true, graphic_injury false, torture_or_execution false, weapon_instruction false, effects_hide_serious_harm false, and non_graphic_action true. lethal_or_maiming_action may be true or false depending on whether the defeat is clearly lethal, but that field alone does not change non_graphic_action.',
    '',
    'Weapons and decisive finishing attacks may appear in a fictional action scene. Heavy blood, gore, open wounds, emphasized serious visible injury, dismemberment, torture, execution, sexual violence, actual injury or abuse of minors, child exploitation, real-person targeting, and practical real-world weapon instruction must remain blocked.',
    'When required safety facts are genuinely unclear, use the safer value. Do not relax any safety rule.'
  ];

  if (contradictions.length > 0) {
    lines.push(
      '',
      'Your previous structured result was internally inconsistent.',
      `Detected contradictions: ${contradictions.join(', ')}`,
      'Re-evaluate the same prompt and images and return a logically consistent classification.',
      'Do not assume that a human person with a concrete minor indicator is an adult.',
      'Trust explicit adult descriptions unless there is a concrete contradictory minor indicator.',
      'Do not classify an ordinary original fictional anime character as a minor merely because no exact age is stated.',
      'Apply the age and non-human classification rules above exactly.'
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
              text: 'Return only the requested structured classification. Apply the explicit rules exactly and do not infer age from stylized appearance alone.'
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
