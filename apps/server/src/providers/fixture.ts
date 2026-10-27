/**
 * Demo-mode providers (spec §4.2). Each one looks up the demo scenario named
 * by `ctx.scenarioId` and returns a copy of its fixture, so callers can never
 * mutate the shared scenarios. No network, no model, no keys.
 */
import type {
  Answer,
  FieldKey,
  LabelField,
  MatchAssessment,
  MatchStatus,
} from '@medilens/contracts';
import { getScenario } from '../demo/scenarios';
import type {
  AnswerInput,
  LabelReader,
  ProviderContext,
  QuestionAnswerer,
  ReadResult,
  ReferenceProvider,
  ReferenceQuery,
  ReferenceSearchResult,
} from './types';

export const FIXTURE_MODEL = 'demo-fixture';

const CONFIRM = 'Confirm with your pharmacist or doctor.';
const UNCERTAIN = 'Some of this was not clear on the pack, so it may be wrong.';
const NOTHING_READ = 'I could not read that on this label.';

export class FixtureLabelReader implements LabelReader {
  read(_images: Buffer[], ctx: ProviderContext): Promise<ReadResult> {
    const s = ctx.scenarioId === undefined ? undefined : getScenario(ctx.scenarioId);
    if (s === undefined) {
      return Promise.resolve({ ok: false, code: 'OCR_FAILED', detail: 'Unknown demo scenario.' });
    }
    return Promise.resolve({ ok: true, label: structuredClone(s.label), model: FIXTURE_MODEL });
  }
}

export class FixtureReferenceProvider implements ReferenceProvider {
  search(_q: ReferenceQuery, ctx: ProviderContext): Promise<ReferenceSearchResult> {
    const s = ctx.scenarioId === undefined ? undefined : getScenario(ctx.scenarioId);
    if (s === undefined) {
      return Promise.resolve({ kind: 'unavailable', reason: 'Unknown demo scenario.' });
    }
    return Promise.resolve(structuredClone(s.reference));
  }
}

const FIELD_NAMES: Record<FieldKey, string> = {
  brandName: 'Brand name',
  genericNames: 'Generic name',
  strength: 'Strength',
  dosageForm: 'Dosage form',
  manufacturer: 'Manufacturer',
  registrationNumber: 'Registration number',
  directions: 'Directions',
  warnings: 'Warnings',
  storage: 'Storage',
  expiryDate: 'Expiry date printed on the pack',
  batchNumber: 'Batch number',
  rxOrOtc: 'Prescription status',
};

const READ_KEYS: FieldKey[] = [
  'brandName',
  'genericNames',
  'strength',
  'dosageForm',
  'manufacturer',
  'directions',
  'warnings',
  'storage',
  'expiryDate',
];

const KEYS_BY_INTENT: Record<string, FieldKey[]> = {
  strength: ['strength'],
  explain_text: ['directions', 'warnings'],
  read_label: READ_KEYS,
  other_label: READ_KEYS,
};

const REGISTRY_SENTENCE: Record<MatchStatus, string> = {
  verified:
    'The FDA registry record matched the registration number, brand name and strength on this pack.',
  partial: 'The FDA registry partly matched this pack; some details could not be confirmed.',
  conflicting: 'The FDA registry record does not agree with this pack on some details.',
  ambiguous: 'More than one FDA registry record could fit this pack, so none was chosen.',
  no_match:
    'No matching registration found. This does not mean the product is fake. Ask your pharmacist.',
  unavailable: "I couldn't check the FDA registry right now.",
  not_attempted: 'The FDA registry was not checked.',
};

function fieldOf(fields: LabelField[], key: FieldKey): LabelField | undefined {
  return fields.find((f) => f.key === key && f.value !== null && f.value.trim() !== '');
}

/**
 * Fixed warning for a cited field the FDA registry record contradicts
 * (spec §5.3 rule 6): the printed value is never read back as certain.
 */
export function conflictWarning(key: FieldKey, referenceValue: string): string {
  const ref = referenceValue.trim().replace(/\.+$/, '');
  return `The FDA registry record lists ${ref} for the ${FIELD_NAMES[key].toLowerCase()}, which does not match the pack. Confirm with your pharmacist.`;
}

function build(
  sentences: string[],
  cited: FieldKey[],
  uncertain: boolean,
  match?: MatchAssessment,
): Answer {
  if (cited.length === 0) {
    return {
      status: 'unclear',
      text: NOTHING_READ,
      spokenChunks: [NOTHING_READ, CONFIRM],
      citedFields: [],
      safetyNotice: null,
    };
  }
  const warnings = (match?.conflicting ?? [])
    .filter((c) => cited.includes(c.key))
    .map((c) => conflictWarning(c.key, c.referenceValue));
  const notices = uncertain ? [...warnings, UNCERTAIN] : warnings;
  const all = [...sentences, ...notices];
  return {
    status: 'answered',
    text: all.join(' '),
    spokenChunks: [...all, CONFIRM],
    citedFields: cited,
    safetyNotice: notices.length > 0 ? notices.join(' ') : null,
  };
}

/**
 * Deterministic grounded answers built only from the label fields of the
 * scan. Refusals are made upstream by the safety gate; the s7 preset question
 * still returns its canned refusal if it reaches this answerer.
 */
export class FixtureAnswerer implements QuestionAnswerer {
  answer(input: AnswerInput, ctx: ProviderContext): Promise<Answer> {
    const s = ctx.scenarioId === undefined ? undefined : getScenario(ctx.scenarioId);
    if (s?.cannedAnswer !== undefined && input.question.trim() === s.presetQuestion) {
      return Promise.resolve(structuredClone(s.cannedAnswer));
    }
    return Promise.resolve(answerFromLabel(input));
  }
}

function answerFromLabel({ label, match, intent }: AnswerInput): Answer {
  const fields = label.fields;

  if (intent === 'unclear_parts') {
    const unclear = fields.filter((f) => f.legibility !== 'clear');
    if (unclear.length === 0) {
      const read = READ_KEYS.filter((k) => fieldOf(fields, k) !== undefined);
      return build(['Every part I read on this label was clear.'], read, false);
    }
    const names = unclear.map((f) => FIELD_NAMES[f.key].toLowerCase()).join(', ');
    return build(
      [`These parts were not clear on the pack: ${names}.`],
      unclear.map((f) => f.key),
      true,
      match,
    );
  }

  if (intent === 'registry') {
    const key = (['registrationNumber', 'brandName', 'genericNames', 'strength'] as const).find(
      (k) => fieldOf(fields, k) !== undefined,
    );
    if (key === undefined) return build([], [], false);
    const f = fieldOf(fields, key);
    const sentences = [REGISTRY_SENTENCE[match.status]];
    if (match.advisories.length > 0) {
      sentences.push('The FDA has an advisory listed for this product.');
    }
    return build(sentences, [key], f !== undefined && f.legibility !== 'clear', match);
  }

  const keys = KEYS_BY_INTENT[intent] ?? READ_KEYS;
  const sentences: string[] = [];
  const cited: FieldKey[] = [];
  let uncertain = false;
  for (const key of keys) {
    const f = fieldOf(fields, key);
    if (f === undefined) continue;
    cited.push(key);
    const value = (f.value ?? '').trim().replace(/\.+$/, '');
    sentences.push(`${FIELD_NAMES[key]} as printed: ${value}.`);
    if (f.legibility !== 'clear') uncertain = true;
  }
  return build(sentences, cited, uncertain, match);
}
