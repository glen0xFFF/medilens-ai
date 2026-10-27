/**
 * The eight deterministic demo scenarios (spec §7). Everything here is
 * synthetic DEMO DATA: fictional product names, registration numbers in the
 * unused DR-XY9xxxxx range, and source URLs on the reserved example.org
 * domain, never the PH FDA site. The expected match status of each scenario comes from
 * running the real matcher over these fixtures, never from a stored value.
 */
import type {
  Answer,
  ExtractedLabel,
  FieldKey,
  LabelField,
  Legibility,
  QualityReport,
  ReferenceRecord,
} from '@medilens/contracts';
import { REFUSAL_TEXT, classifyQuestion } from '../domain/safety';
import type { ReferenceSearchResult } from '../providers/types';

export type DemoScenarioId =
  | 's1-clear'
  | 's2-blurry'
  | 's3-similar'
  | 's4-conflict'
  | 's5-nomatch'
  | 's6-loose-pill'
  | 's7-unsupported-question'
  | 's8-registry-down';

export interface DemoScenario {
  id: DemoScenarioId;
  title: string;
  quality: QualityReport;
  label: ExtractedLabel;
  reference: ReferenceSearchResult;
  presetQuestion?: string;
  cannedAnswer?: Answer;
}

const CHECKED_AT = '2026-10-27T00:00:00.000Z';
/** Where a demo record's "source page" points: a reserved example domain, not the FDA. */
const DEMO_SOURCE_URL = 'https://example.org/medilens-demo/';
const NOTE = 'DEMO DATA: synthetic fixture, not a real product.';

const GOOD_QUALITY: QualityReport = {
  ok: true,
  sharpness: 48.2,
  luminance: 132,
  glareFraction: 0.01,
  reasons: [],
};

const BAD_QUALITY: QualityReport = {
  ok: false,
  sharpness: 4.1,
  luminance: 168,
  glareFraction: 0.21,
  reasons: ['BLURRY', 'GLARE'],
};

function field(key: FieldKey, value: string | null, legibility: Legibility = 'clear'): LabelField {
  return {
    key,
    value,
    legibility,
    evidenceText: value,
    imageIndex: value === null ? null : 0,
    notes: null,
  };
}

function label(fields: LabelField[]): ExtractedLabel {
  return {
    imageKind: 'label',
    fields,
    rawText: [
      'DEMO DATA',
      ...fields.flatMap((f) => (f.evidenceText === null ? [] : [f.evidenceText])),
    ].join('\n'),
    warnings: [],
  };
}

function record(
  registrationNumber: string,
  brandName: string,
  genericName: string,
  strengthForm: string,
): ReferenceRecord {
  return {
    provider: 'demo-fixture',
    // final review Minor 18: a made-up record never links to the real FDA site
    sourceUrl: `${DEMO_SOURCE_URL}${encodeURIComponent(registrationNumber)}`,
    registrationNumber,
    brandName,
    genericName,
    strengthForm,
    manufacturer: 'Demo Pharma Labs (DEMO DATA)',
    classification: 'Over-the-counter (DEMO DATA)',
    registrationExpiry: '2030-12-31',
    checkedAt: CHECKED_AT,
  };
}

function ok(records: ReferenceRecord[]): ReferenceSearchResult {
  return { kind: 'ok', records, advisories: [] };
}

const PARACELIN_500_FIELDS: LabelField[] = [
  field('brandName', 'Paracelin 500'),
  field('genericNames', 'Paracetamol'),
  field('strength', '500 mg'),
  field('dosageForm', 'Tablet'),
  field('manufacturer', 'Demo Pharma Labs'),
  field('registrationNumber', 'DR-XY900001'),
  field(
    'directions',
    'Adults: 1 to 2 tablets every 4 to 6 hours as needed. Do not take more than 8 tablets in 24 hours.',
  ),
  field(
    'warnings',
    'Do not use with other products containing paracetamol. Keep out of reach of children.',
  ),
  field('storage', 'Store below 30 degrees Celsius in a dry place.'),
  field('expiryDate', '05/2028'),
  field('batchNumber', 'DB0001'),
  field('rxOrOtc', 'OTC'),
];

const PARACELIN_500_RECORD = record('DR-XY900001', 'Paracelin 500', 'Paracetamol', '500 mg Tablet');

const S7_QUESTION = 'How many should I take for my headache?';

/** The refusal the safety gate gives for `question`, as a fixed Answer. */
function cannedRefusal(question: string): Answer {
  const verdict = classifyQuestion(question);
  const text = verdict.allowed ? REFUSAL_TEXT.outside_label : REFUSAL_TEXT[verdict.reason];
  return {
    status: 'refused',
    text,
    spokenChunks: [text],
    citedFields: [],
    safetyNotice: 'Please ask a pharmacist or your doctor.',
  };
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 's1-clear',
    title: 'DEMO DATA: Clear package, registration number matches',
    quality: GOOD_QUALITY,
    label: label(PARACELIN_500_FIELDS),
    reference: ok([PARACELIN_500_RECORD]),
  },
  {
    id: 's2-blurry',
    title: 'DEMO DATA: Blurry photo with glare',
    quality: BAD_QUALITY,
    label: { imageKind: 'unreadable', fields: [], rawText: '', warnings: [NOTE] },
    reference: { kind: 'not_attempted' },
  },
  {
    id: 's3-similar',
    title: 'DEMO DATA: Two similar products',
    quality: GOOD_QUALITY,
    label: label([
      field('brandName', 'Paracel', 'partial'),
      field('genericNames', 'Paracetamol'),
      field('strength', '500 mg'),
      field('dosageForm', 'Tablet'),
      field('registrationNumber', null, 'unreadable'),
    ]),
    reference: ok([
      record('DR-XY900002', 'Paracelin 500', 'Paracetamol', '500 mg Tablet'),
      record('DR-XY900003', 'Paracelin-Forte 500', 'Paracetamol', '500 mg Tablet'),
    ]),
  },
  {
    id: 's4-conflict',
    title: 'DEMO DATA: Label strength differs from the registry',
    quality: GOOD_QUALITY,
    label: label([
      field('brandName', 'Paracelin'),
      field('genericNames', 'Paracetamol'),
      field('strength', '500 mg'),
      field('dosageForm', 'Tablet'),
      field('registrationNumber', 'DR-XY900004'),
    ]),
    reference: ok([record('DR-XY900004', 'Paracelin 250', 'Paracetamol', '250 mg Tablet')]),
  },
  {
    id: 's5-nomatch',
    title: 'DEMO DATA: Unknown product',
    quality: GOOD_QUALITY,
    label: label([
      field('brandName', 'Amoxivan 500'),
      field('genericNames', 'Amoxicillin'),
      field('strength', '500 mg'),
      field('dosageForm', 'Capsule'),
      field('registrationNumber', 'DR-XY900099'),
    ]),
    reference: ok([]),
  },
  {
    id: 's6-loose-pill',
    title: 'DEMO DATA: Loose pill',
    quality: GOOD_QUALITY,
    label: {
      imageKind: 'loose_pill',
      fields: [
        field('brandName', null, 'unreadable'),
        field('genericNames', null, 'unreadable'),
        field('strength', null, 'unreadable'),
      ],
      rawText: '',
      warnings: [NOTE],
    },
    reference: { kind: 'not_attempted' },
  },
  {
    id: 's7-unsupported-question',
    title: 'DEMO DATA: Unsupported dosing question',
    quality: GOOD_QUALITY,
    label: label(PARACELIN_500_FIELDS),
    reference: ok([PARACELIN_500_RECORD]),
    presetQuestion: S7_QUESTION,
    cannedAnswer: cannedRefusal(S7_QUESTION),
  },
  {
    id: 's8-registry-down',
    title: 'DEMO DATA: Registry unavailable',
    quality: GOOD_QUALITY,
    label: label(PARACELIN_500_FIELDS),
    reference: { kind: 'unavailable', reason: 'DEMO DATA: simulated registry timeout.' },
  },
];

export function getScenario(id: string): DemoScenario | undefined {
  return DEMO_SCENARIOS.find((s) => s.id === id);
}
