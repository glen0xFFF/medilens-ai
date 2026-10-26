/**
 * Deterministic spoken summary (spec §5.5). Everything spoken here is either a
 * fixed sentence or a label value transcribed from the user's own pack. Registry
 * rows are never read aloud: in particular `registrationExpiry` (certificate
 * expiry) must never be mistaken for the product's expiry.
 */
import type {
  ExtractedLabel,
  Explanation,
  FieldKey,
  LabelField,
  MatchAssessment,
  PipelineState,
  QualityReason,
  QualityReport,
} from '@medilens/contracts';
import { REG_NOT_FOUND_NOTE } from './matcher';

export const FINAL_LINE = 'Confirm with your pharmacist or doctor.';
export const ADVISORY_SENTENCE =
  'The FDA has issued an advisory about counterfeit versions of this product. Check with your pharmacist.';
export const LOOSE_PILL_SENTENCE =
  "This looks like a loose tablet. I can't identify a medicine from how it looks. Please ask a pharmacist.";
export const NOT_A_LABEL_SENTENCE = "I couldn't find a medicine label in this photo.";
const DEMO_NOTICE = 'Demo data. This is a made-up example, not a real medicine.';
const UNREADABLE_SENTENCE = "I couldn't read this label.";
const RETAKE_SENTENCE = 'Please take another photo.';
const MAX_CHUNK = 400;

const QUALITY_SENTENCE: Record<QualityReason, string> = {
  BLURRY: 'The photo is blurry.',
  TOO_DARK: 'The photo is too dark.',
  GLARE: 'There is glare on the label.',
};

const STATUS_SENTENCE = {
  verified: 'This matches a product in the Philippine FDA registry.',
  partial:
    'This partly matches a product in the Philippine FDA registry. Some details could not be confirmed.',
  ambiguous: "More than one registered product could match this label. I can't tell which one.",
  no_match:
    'No matching registration found. This does not mean the product is fake. Ask your pharmacist.',
  unavailable: "I couldn't check the FDA registry right now.",
} as const;

const FIELD_NAME: Record<FieldKey, string> = {
  brandName: 'brand name',
  genericNames: 'generic name',
  strength: 'strength',
  dosageForm: 'dosage form',
  manufacturer: 'manufacturer',
  registrationNumber: 'registration number',
  directions: 'directions',
  warnings: 'warnings',
  storage: 'storage',
  expiryDate: 'expiry date',
  batchNumber: 'batch number',
  rxOrOtc: 'prescription status',
};

/** Field order for the unclear-fields sentence. */
const FIELD_ORDER: readonly FieldKey[] = [
  'brandName',
  'genericNames',
  'strength',
  'dosageForm',
  'manufacturer',
  'registrationNumber',
  'directions',
  'warnings',
  'storage',
  'expiryDate',
  'batchNumber',
  'rxOrOtc',
];

export interface SummaryInput {
  label: ExtractedLabel | null;
  quality: QualityReport;
  match: MatchAssessment;
  isDemo: boolean;
  pipelineState: PipelineState;
}

export function buildSummary(input: SummaryInput): Explanation {
  const segments: string[] = [];
  const safetyNotices: string[] = [];
  const supportingFields: FieldKey[] = [];

  if (input.isDemo) segments.push(DEMO_NOTICE);

  const { label, pipelineState } = input;
  if (pipelineState === 'loose_pill' || label?.imageKind === 'loose_pill') {
    segments.push(LOOSE_PILL_SENTENCE);
    safetyNotices.push(LOOSE_PILL_SENTENCE);
  } else if (pipelineState === 'not_a_label' || label?.imageKind === 'not_medicine') {
    segments.push(NOT_A_LABEL_SENTENCE);
  } else if (
    pipelineState === 'label_unreadable' ||
    label === null ||
    label.imageKind === 'unreadable'
  ) {
    segments.push(
      [
        UNREADABLE_SENTENCE,
        ...input.quality.reasons.map((r) => QUALITY_SENTENCE[r]),
        RETAKE_SENTENCE,
      ].join(' '),
    );
  } else {
    labelSegments(label, input.match, segments, safetyNotices, supportingFields);
  }

  segments.push(FINAL_LINE);
  safetyNotices.push(FINAL_LINE);

  const spokenChunks = segments.flatMap(chunk);
  return {
    displayText: spokenChunks.join('\n'),
    spokenChunks,
    safetyNotices: [...new Set(safetyNotices)],
    supportingFields,
  };
}

function labelSegments(
  label: ExtractedLabel,
  match: MatchAssessment,
  segments: string[],
  safetyNotices: string[],
  supportingFields: FieldKey[],
): void {
  const fields = new Map<FieldKey, LabelField>();
  for (const f of label.fields) if (!fields.has(f.key)) fields.set(f.key, f);

  const spoken = (key: FieldKey): string | null => {
    const f = fields.get(key);
    const value = f?.value?.trim();
    if (!f || !value) return null;
    if (!supportingFields.includes(key)) supportingFields.push(key);
    return f.legibility === 'clear' ? value : `${value}, but this part is unclear`;
  };

  // product name + strength + form
  const brand = spoken('brandName');
  const generic = spoken('genericNames');
  const strength = spoken('strength');
  const form = spoken('dosageForm');
  const name = brand && generic ? `${brand} (${generic})` : (brand ?? generic);
  const parts = [
    name,
    strength ? `strength ${strength}` : null,
    form ? `form ${form}` : null,
  ].filter((p): p is string => p !== null);
  segments.push(
    name
      ? `This label reads: ${parts.join('; ')}.`
      : parts.length > 0
        ? `I couldn't read the medicine name. The label shows ${parts.join('; ')}.`
        : "I couldn't read the medicine name.",
  );

  // verification status
  const verification = verificationSentences(match);
  if (verification.length > 0) segments.push(verification.join(' '));
  if (match.status === 'conflicting') safetyNotices.push(...verification);
  if (match.limitations.includes(REG_NOT_FOUND_NOTE)) segments.push(REG_NOT_FOUND_NOTE);

  // registry advisory (any status)
  if (match.advisories.length > 0) {
    segments.push(ADVISORY_SENTENCE);
    safetyNotices.push(ADVISORY_SENTENCE);
  }

  const directions = spoken('directions');
  if (directions) segments.push(`Directions as printed: ${sentence(directions)}`);
  const warnings = spoken('warnings');
  if (warnings) segments.push(`Warnings as printed: ${sentence(warnings)}`);
  const expiry = spoken('expiryDate');
  if (expiry) segments.push(`Expiry date printed on the pack: ${sentence(expiry)}`);

  const unclear = FIELD_ORDER.filter((k) => {
    const f = fields.get(k);
    return f !== undefined && f.legibility !== 'clear';
  }).map((k) => FIELD_NAME[k]);
  if (unclear.length > 0) segments.push(`Some parts were unclear: ${unclear.join(', ')}.`);
}

function verificationSentences(match: MatchAssessment): string[] {
  switch (match.status) {
    case 'conflicting': {
      const keys = [...new Set(match.conflicting.map((c) => c.key))];
      if (keys.length === 0) return ['Some details on the label do not match the registry.'];
      return keys.map((k) => `The ${FIELD_NAME[k]} on the label does not match the registry.`);
    }
    case 'not_attempted':
      return [];
    default:
      return [STATUS_SENTENCE[match.status]];
  }
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Split one segment into chunks of at most MAX_CHUNK chars, at sentence then word boundaries. */
function chunk(segment: string): string[] {
  const text = segment.replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_CHUNK) return text ? [text] : [];
  const sentences = text
    .match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((s) => s.trim())
    .filter(Boolean) ?? [text];
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current) out.push(current);
    current = '';
  };
  for (const s of sentences) {
    const pieces = s.length <= MAX_CHUNK ? [s] : splitWords(s);
    for (const p of pieces) {
      if (current && current.length + 1 + p.length > MAX_CHUNK) flush();
      current = current ? `${current} ${p}` : p;
    }
  }
  flush();
  return out;
}

function splitWords(s: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const word of s.split(' ')) {
    // a single unbroken run longer than the limit is hard-cut
    for (let i = 0; i < word.length; i += MAX_CHUNK) {
      const w = word.slice(i, i + MAX_CHUNK);
      if (current && current.length + 1 + w.length > MAX_CHUNK) {
        out.push(current);
        current = '';
      }
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) out.push(current);
  return out;
}
