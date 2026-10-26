/**
 * Deterministic question safety gate (spec §4.3 step 1). Runs before any
 * model call. Refusal patterns are checked before anything is allowed, so a
 * question that mentions the label AND asks for personal advice is refused.
 * Patterns err towards refusing: an over-refusal costs a pharmacist visit, an
 * under-refusal could be dosing advice.
 */

export type RefusalReason =
  | 'personal_dose'
  | 'start_stop'
  | 'diagnosis'
  | 'special_population'
  | 'interaction'
  | 'personal_safety'
  | 'pill_identification';

export type AllowedIntent =
  'read_label' | 'explain_text' | 'strength' | 'unclear_parts' | 'registry' | 'other_label';

export type QuestionClass =
  { allowed: true; intent: AllowedIntent } | { allowed: false; reason: RefusalReason };

const REDIRECT = 'Please ask a pharmacist or your doctor.';

export const REFUSAL_TEXT: Record<RefusalReason, string> = {
  personal_dose: `I can't tell you how much to take. I can only read what is printed on the label. ${REDIRECT}`,
  start_stop: `I can't advise you to start, stop or change a medicine. ${REDIRECT}`,
  diagnosis: `I can't diagnose symptoms or say whether this medicine treats them. ${REDIRECT}`,
  special_population: `I can't say whether this medicine is suitable for children, older people, or during pregnancy or breastfeeding. ${REDIRECT}`,
  interaction: `I can't check whether this medicine is safe to take with other medicines, food or alcohol. ${REDIRECT}`,
  personal_safety: `I can't say whether this medicine is safe for you. ${REDIRECT}`,
  pill_identification: `I can't identify a medicine from how a pill looks. ${REDIRECT}`,
};

const PILL = String.raw`(?:pills?|tablets?|capsules?|caplets?|tabs?)`;
const LOOKS = String.raw`(?:white|yellow|pink|blue|red|orange|green|brown|purple|grey|gray|black|round|oval|oblong|small|big|large|tiny|loose|scored|coated|shiny)`;

/** Checked in this order; the first matching reason wins. */
const REFUSALS: readonly [RefusalReason, readonly RegExp[]][] = [
  [
    'pill_identification',
    [
      new RegExp(String.raw`\b${LOOKS}\b.*\b${PILL}\b`),
      new RegExp(String.raw`\bwhat(?:'s| is)? (?:this|that|these|the) ${PILL}\b`),
      new RegExp(String.raw`\bwhat ${PILL} (?:is|are) (?:this|that|these|it)\b`),
      new RegExp(String.raw`\b(?:identify|recogni[sz]e)\b.*\b${PILL}\b`),
      /\bwhich (?:medicine|drug) is this\b/,
    ],
  ],
  [
    'special_population',
    [
      /\bpregnan/,
      /\bbreast ?feed/,
      /\bnursing\b/,
      /\blactat/,
      /\b(?:child|children|kids?|baby|babies|infants?|toddlers?|newborns?|teens?|teenagers?)\b/,
      /\b(?:son|daughter|grand(?:son|daughter|child))\b/,
      /\b\d+ ?-?(?:years?|yrs?|months?|mos?) ?-?old\b/,
      /\b(?:elderly|seniors?|old people|older people)\b/,
      /\bwhat age\b/,
      /\bage\b/,
      /\b(?:buntis|sanggol|anak|bata)\b/,
    ],
  ],
  [
    'interaction',
    [
      /\binteract/,
      /\b(?:combine|combining|mix|mixing)\b/,
      /\btogether\b/,
      /\bat the same time\b/,
      /\b(?:alcohol|beer|wine|liquor|drinking)\b/,
      /\b(?:take|taking|use|using|have|drink)\b.*\b(?:with|and|plus|after|before)\b.*\b(?:other|another|ibuprofen|paracetamol|acetaminophen|aspirin|antibiotics?|medicines?|medications?|meds|drugs?|pills?|tablets?|vitamins?|supplements?|food|coffee|milk|juice)\b/,
      /\bwith (?:my )?(?:other|another) (?:medicines?|medications?|meds|drugs?|pills?)\b/,
    ],
  ],
  [
    'start_stop',
    [
      /\b(?:stop|stopped|stopping|quit|discontinue|start|starting|switch|switching|skip|skipping|resume)\b/,
      /\b(?:keep|continue) (?:taking|using)\b/,
      /\bchange (?:to|from|my)\b/,
      /\bmissed (?:a )?dose\b/,
    ],
  ],
  [
    'personal_dose',
    [
      /\bhow (?:many|much)\b/,
      /\bhow often should\b/,
      /\b\d+(?:\.\d+)? ?(?:kg|kgs|kilos?|kilograms?|lbs?|pounds)\b/,
      /\bweigh/,
      /\bshould (?:i|he|she|we|they) take\b/,
      /\b(?:dose|dosage) (?:for|should|do)\b/,
      /\bwhat dose\b/,
      /\b(?:double|extra|more) (?:dose|tablets?|pills?)\b/,
      /\boverdose\b/,
      /\bilang?\b/,
    ],
  ],
  [
    'diagnosis',
    [
      /\bdo (?:i|you think i) have\b/,
      /\bdiagnos/,
      /\bsymptoms?\b/,
      /\bwhat(?:'s| is) wrong with\b/,
      /\b(?:cure|treat|heal|fix|work for|good for|help with|help my)\b.*\bmy\b/,
      /\bmy (?:fever|headache|pain|cough|cold|flu|rash|infection|stomach|tummy|throat|condition|illness|disease)\b/,
      /\bi (?:feel|felt|am feeling|have been feeling)\b/,
      /\bi (?:have|got) (?:a |an )?(?:fever|headache|pain|cough|cold|flu|rash|infection|diarrh\w*|sore)\b/,
      /\bam i (?:sick|ill)\b/,
    ],
  ],
  [
    'personal_safety',
    [
      /\bsafe\b/,
      /\b(?:dangerous|harmful|risky)\b/,
      /\ballerg/,
      /\bside effects?\b.*\b(?:i|me|my)\b/,
      /\b(?:i|me|my)\b.*\bside effects?\b/,
      /\bcan i (?:take|use|have|drink|swallow|give)\b/,
      /\bshould i (?:take|use|be worried|worry)\b/,
      /\b(?:is|are) (?:it|this|these|they) (?:ok|okay|alright|all right|fine) (?:for|to)\b/,
      /\bwill (?:it|this) (?:hurt|harm|affect) me\b/,
      /\bstill (?:take|use)\b/,
      /\bpwede ba\b/,
    ],
  ],
];

/** Checked in this order after no refusal matched; default `other_label`. */
const INTENTS: readonly [AllowedIntent, readonly RegExp[]][] = [
  [
    'unclear_parts',
    [
      /\bunclear\b/,
      /\bunreadable\b/,
      /\b(?:could|can|did|do)(?:n't| ?not) (?:you )?(?:read|see|make out)\b/,
      /\b(?:could|can|did|do) you not (?:read|see|make out)\b/,
      /\bnot (?:clear|readable|legible)\b/,
      /\b(?:blurry|missing|illegible)\b/,
    ],
  ],
  ['registry', [/\b(?:fda|registry|registered|registration|verified|verify|verification)\b/]],
  ['strength', [/\bstrength\b/, /\bhow strong\b/, /\b(?:mg|mcg|ml|milligrams?|micrograms?)\b/]],
  [
    'explain_text',
    [
      /\bexplain/,
      /\bmeans?\b/,
      /\bmeaning\b/,
      /\bsimpl(?:e|er)\b/,
      /\bin other words\b/,
      /\b(?:warnings?|directions?|instructions?|storage|store|caution|precautions?)\b/,
    ],
  ],
  [
    'read_label',
    [
      /\bread\b/,
      /\blabel\b/,
      /\b(?:printed|written)\b/,
      /\b(?:name|brand|generic|expiry|expiration|expires?|batch|lot)\b/,
    ],
  ],
];

function normalise(q: string): string {
  return q
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛′`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyQuestion(q: string): QuestionClass {
  const text = normalise(q);
  for (const [reason, patterns] of REFUSALS) {
    if (patterns.some((p) => p.test(text))) return { allowed: false, reason };
  }
  for (const [intent, patterns] of INTENTS) {
    if (patterns.some((p) => p.test(text))) return { allowed: true, intent };
  }
  return { allowed: true, intent: 'other_label' };
}
