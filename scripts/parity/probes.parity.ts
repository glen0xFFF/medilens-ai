/**
 * Extra parity corpora, run only by the parity:record config (setup.ts wraps
 * the domain modules, so every call below is recorded). Synthetic DEMO DATA
 * only, no network. Everything is deterministic: the matcher fuzz uses a
 * seeded PRNG, so re-recording gives the same corpus.
 *
 * 1. Matcher fuzz (seeded): label x registry combinations through assessMatch,
 *    and a subset of the outcomes through buildSummary, answerFromLabel and
 *    verificationSentences.
 * 2. Safety sweep: the preset questions and refusal probes, each under
 *    non-ASCII and spacing variants, through classifyQuestion,
 *    extractExplainPhrase and askedFields.
 * 3. Parser sweep: strengths, names and registration numbers under the same
 *    kind of variants.
 * 4. Explanation probes (test/fixtures/explanationProbes.ts) through the
 *    explanation gate and composeExplainAnswer.
 * 5. Scenarios (ruling R3): the 8 demo scenarios through the Node app's
 *    POST /api/v1/demo/scenario, in process, with id/createdAt/expiresAt
 *    stripped (scenarios.jsonl).
 */
import {
  AnalysisResultSchema,
  MatchAssessmentSchema,
  type ExtractedLabel,
  type FieldKey,
  type ImageKind,
  type LabelField,
  type Legibility,
  type MatchAssessment,
  type QualityReport,
  type ReferenceRecord,
} from '@medilens/contracts';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import {
  answerFromLabel,
  composeExplainAnswer,
  conflictWarning,
  explainQuote,
  explanationAllowed,
  explanationFits,
  findPhraseInFields,
  notALabelAnswer,
  quoteExplainable,
  unclearAnswer,
} from '../../apps/server/src/domain/answers';
import { assessMatch, clearValue } from '../../apps/server/src/domain/matcher';
import {
  normalizeName,
  normalizeRegistrationNumber,
  parseStrength,
  strengthsEqual,
} from '../../apps/server/src/domain/parsers';
import {
  ALLOWED_QUESTION_EXAMPLES,
  askedFields,
  classifyQuestion,
  extractExplainPhrase,
} from '../../apps/server/src/domain/safety';
import {
  advisorySentence,
  buildSummary,
  verificationSentences,
} from '../../apps/server/src/domain/summary';
import type { ReferenceSearchResult } from '../../apps/server/src/providers/types';
import { ROUND2_PROBE_CASES } from '../../apps/server/test/fixtures/explanationProbes';
import { SCENARIO_IDS, makeApp } from '../../apps/server/test/http/helpers';
import { record } from './recorder';

/* ------------------------------------------------------------ helpers */

/** mulberry32: a small seeded PRNG, so the fuzz corpus is reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_SEED = 20261028;
const FUZZ_CASES = 4000;

type Spec = [value: string | null, legibility: Legibility];

function lf(key: FieldKey, [value, legibility]: Spec): LabelField {
  return { key, value, legibility, evidenceText: value, imageIndex: 0, notes: null };
}

const C = (v: string): Spec => [v, 'clear'];
const P = (v: string): Spec => [v, 'partial'];
const U: Spec = [null, 'unreadable'];

/** Non-ASCII and spacing variants of a string. Each is applied on its own. */
const VARIANTS: [name: string, f: (s: string) => string][] = [
  ['identity', (s) => s],
  ['upper', (s) => s.toUpperCase()],
  ['fullwidth', (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))],
  ['nbsp', (s) => s.replace(/ /g, ' ')],
  ['narrow nbsp', (s) => s.replace(/ /g, ' ')],
  ['zero width space', (s) => s.replace(' ', ' ​')],
  ['soft hyphen', (s) => (s.length > 3 ? `${s.slice(0, 2)}­${s.slice(2)}` : s)],
  ['tabs and newlines', (s) => s.replace(/ /g, '\t').replace(/\t/, '\n')],
  ['padded', (s) => `  ${s}  `],
  ['cyrillic a', (s) => s.replace('a', 'а')],
  ['combining acute', (s) => (s.length > 1 ? `${s[0]}́${s.slice(1)}` : s)],
  ['curly quotes', (s) => s.replace(/"([^"]*)"/g, '“$1”').replace(/'([^']*)'/g, '‘$1’')],
  ['dotted capital I', (s) => s.replace(/i/i, 'İ')],
  ['kelvin sign', (s) => s.replace(/k/i, 'K')],
  ['fi ligature', (s) => s.replace('fi', 'ﬁ')],
  ['fullwidth question mark', (s) => s.replace(/\?$/, '？')],
  ['en dash', (s) => s.replace('-', '–')],
];

function variants(s: string): string[] {
  return [...new Set(VARIANTS.map(([, f]) => f(s)))];
}

const QUALITY_OK: QualityReport = {
  ok: true,
  sharpness: 120,
  luminance: 140,
  glareFraction: 0.01,
  reasons: [],
};

/* ------------------------------------------------------- 1. matcher fuzz */

const REG: (Spec | undefined)[] = [
  undefined,
  C('DR-XY12345'),
  C('DR XY 12345'),
  C('DRXY12345'),
  C('dr-xy12345'),
  C('DR-XY99999'),
  C('ＤＲ－ＸＹ１２３４５'),
  C('DR-XY12345​'),
  P('DR-XY12345'),
  U,
  C(''),
];
const BRAND: (Spec | undefined)[] = [
  undefined,
  C('Biogesic'),
  C('BIOGESIC'),
  C('Bio-gesic'),
  C('Biogesic Forte'),
  C('Neozep'),
  C('Ｂｉｏｇｅｓｉｃ'),
  C('Biogésic'),
  P('Biogesic'),
  U,
];
const GENERIC: (Spec | undefined)[] = [
  undefined,
  C('Paracetamol'),
  C('paracetamol + caffeine'),
  C('Paracetamol, Phenylephrine HCl and Chlorphenamine'),
  C('Ibuprofen'),
  C('İbuprofen'),
  P('Paracetamol'),
  U,
];
const STRENGTH: (Spec | undefined)[] = [
  undefined,
  C('500 mg'),
  C('500mg'),
  C('0.5 g'),
  C('500 mg/5 mL'),
  C('250 mg'),
  C('500'),
  C('５００ mg'),
  C('1,000 mg'),
  C('500 mg + 65 mg'),
  C('500 mg'),
  P('500 mg'),
  U,
];
const FORM: (Spec | undefined)[] = [
  undefined,
  C('Tablet'),
  C('Film-coated tablet'),
  C('Film Coated Tablet'),
  C('Capsule'),
  C('Caplet'),
  C('Syrup'),
  C('Eye drops'),
  P('Tablet'),
  U,
];
const KINDS: ImageKind[] = [
  'label',
  'label',
  'label',
  'label',
  'label',
  'label',
  'loose_pill',
  'unreadable',
];

const REC_REG = ['DR-XY12345', 'DR-XY12346', 'DRXY12345', 'DR-XY99999'];
const REC_BRAND = ['Biogesic', 'BIOGESIC', 'Biogesic Forte', 'Neozep', 'Bio-gesic', null];
const REC_GENERIC = ['Paracetamol', 'Paracetamol + Caffeine', 'Ibuprofen', 'Phenylephrine', null];
const REC_SF = [
  '500 mg Tablet',
  '500mg Film-Coated Tablet',
  '500 mg/5 mL Syrup',
  '250 mg Capsule',
  '500mg-Capsule',
  '500 mg',
  'Tablet',
  '1 g Caplet',
  '500 mg Film Coated Tablet',
  null,
];
const ADVISORIES = [
  { title: 'FDA Advisory No. 2026-001 DEMO DATA', url: 'https://www.fda.gov.ph/demo-advisory-1' },
  {
    title: 'DEMO DATA Public warning against counterfeit Biogesic',
    url: 'https://www.fda.gov.ph/demo-advisory-2',
  },
];

function pick<T>(r: () => number, xs: readonly T[]): T {
  // an `undefined` entry is a deliberate "field absent" choice
  return xs[Math.floor(r() * xs.length)] as T;
}

function fuzzRecord(r: () => number): ReferenceRecord {
  const reg = pick(r, REC_REG);
  return {
    provider: 'parity-fuzz',
    sourceUrl: `https://verification.fda.gov.ph/demo/${reg}`,
    registrationNumber: reg,
    brandName: pick(r, REC_BRAND),
    genericName: pick(r, REC_GENERIC),
    strengthForm: pick(r, REC_SF),
    manufacturer: r() < 0.5 ? 'Demo Pharma Labs (DEMO DATA)' : null,
    classification: r() < 0.5 ? 'OTC' : null,
    registrationExpiry: r() < 0.5 ? '2030-12-31' : null,
    checkedAt: '2026-10-27T00:00:00.000Z',
  };
}

function fuzzLabel(r: () => number): ExtractedLabel {
  const fields: LabelField[] = [];
  const add = (key: FieldKey, specs: (Spec | undefined)[]) => {
    const s = pick(r, specs);
    if (s !== undefined) fields.push(lf(key, s));
  };
  add('registrationNumber', REG);
  add('brandName', BRAND);
  add('genericNames', GENERIC);
  add('strength', STRENGTH);
  add('dosageForm', FORM);
  // a duplicated key is not comparable (clearValue)
  if (r() < 0.05) add('brandName', BRAND);
  if (r() < 0.2) fields.push(lf('directions', C('Adults: 1 tablet every 4 to 6 hours as needed.')));
  if (r() < 0.2)
    fields.push(lf('warnings', C('Do not use with other products containing paracetamol.')));
  // fields in a shuffled order now and then
  if (r() < 0.2) fields.reverse();
  return { imageKind: pick(r, KINDS), fields, rawText: 'DEMO DATA', warnings: [] };
}

function fuzzSearch(r: () => number): ReferenceSearchResult {
  const roll = r();
  if (roll < 0.04) return { kind: 'unavailable', reason: 'timeout' };
  if (roll < 0.08) return { kind: 'not_attempted' };
  const n = Math.floor(r() * 4);
  const records = Array.from({ length: n }, () => fuzzRecord(r));
  const a = r();
  const advisories = a < 0.8 ? [] : a < 0.9 ? [ADVISORIES[0]!] : [ADVISORIES[1]!];
  return r() < 0.1
    ? { kind: 'ok', records, advisories, advisoriesUnchecked: true }
    : { kind: 'ok', records, advisories };
}

const ALLOWED_INTENT_QUESTIONS = ALLOWED_QUESTION_EXAMPLES.flatMap((q) => {
  const c = classifyQuestion(q);
  return c.allowed ? [{ q, intent: c.intent }] : [];
});

describe('matcher fuzz', () => {
  test(`${FUZZ_CASES} seeded cases (seed ${FUZZ_SEED})`, () => {
    const r = prng(FUZZ_SEED);
    for (let i = 0; i < FUZZ_CASES; i++) {
      const label = fuzzLabel(r);
      const search = fuzzSearch(r);
      const match = assessMatch(label, search);
      expect(MatchAssessmentSchema.safeParse(match).success).toBe(true);
      if (i % 4 === 0) {
        buildSummary({
          label,
          quality: QUALITY_OK,
          match,
          isDemo: i % 8 === 0,
          pipelineState:
            label.imageKind === 'loose_pill'
              ? 'loose_pill'
              : label.imageKind === 'label'
                ? 'explanation_ready'
                : 'not_a_label',
        });
        verificationSentences(match);
        const keys = ['registrationNumber', 'brandName', 'strength'] as const;
        clearValue(label, keys[(i / 4) % keys.length]!);
      }
      if (i % 8 === 0) {
        const { q, intent } = ALLOWED_INTENT_QUESTIONS[(i / 8) % ALLOWED_INTENT_QUESTIONS.length]!;
        answerFromLabel({ label, match, question: q, intent });
      }
    }
  });
});

/* ------------------------------------------------------- 2. safety sweep */

const QUESTIONS = [
  ...ALLOWED_QUESTION_EXAMPLES,
  'How many should I take for my headache?',
  'Can I take this with alcohol?',
  'Is it safe for my baby?',
  'Can I give this to my 5 year old?',
  'My child swallowed ten of these',
  'I took too many, what do I do?',
  'Should I stop taking it?',
  'Is this the right medicine for a fever?',
  'What is this white round pill?',
  'Is this fake?',
  'What does "take with food" mean?',
  "What does 'as needed' mean?",
  'What does PRN mean?',
  'What does the word "caplet" mean in simpler words?',
  'What is the batch number?',
  'Who distributes this?',
  'What is the dosage form?',
  'Is this a prescription medicine?',
  'What is the registration number?',
  'What are the inactive ingredients?',
  'When was it manufactured?',
  'What is the brand name?',
  'What is the generic name?',
  'What are the active ingredients?',
  'Read the warnings',
  'What is the expiry date?',
  'How should I store it?',
  'Can you read the label again?',
  'What is printed on the label?',
  'What does this mean?',
];

describe('safety sweep', () => {
  test('questions and their non-ASCII and spacing variants', () => {
    for (const base of QUESTIONS) {
      for (const q of variants(base)) {
        classifyQuestion(q);
        extractExplainPhrase(q);
        askedFields(q);
      }
    }
    for (const q of ['', ' ', '​', '?', 'x'.repeat(300), 'x'.repeat(301), `${'a '.repeat(150)}`]) {
      classifyQuestion(q);
      extractExplainPhrase(q);
      askedFields(q);
    }
  });
});

/* ------------------------------------------------------- 3. parser sweep */

const STRENGTHS = [
  '500 mg',
  '500mg',
  '0.5 g',
  '250 mg/5 mL',
  '250mg/5ml',
  '250 mg per 5 mL',
  '1 g',
  '100 mcg',
  '100 µg',
  '100 μg',
  '5%',
  '1,000 mg',
  '1.000 mg',
  '500 mg + 65 mg',
  '10 IU',
  '500 milligrams',
  '2.5 mL',
  'Paracetamol 500 mg Tablet',
  '500',
  '٥٠٠ mg',
];
const NAMES = [
  'Biogesic',
  'Bio-gesic',
  'Paracetamol + Caffeine',
  'Film-Coated Tablet',
  'Ibuprofen 200 mg Capsule',
  'Café',
  'Straße',
  'Phenylephrine HCl',
  'Eye Drops',
  'Para​cetamol',
];
const REG_NOS = [
  'DR-XY12345',
  'dr-xy12345',
  ' DR XY 12345 ',
  'FR-4000001234',
  'DRP-1234-01',
  'N/A',
  '',
];

describe('parser sweep', () => {
  test('strengths, names and registration numbers with variants', () => {
    const parsed = new Map<string, ReturnType<typeof parseStrength>>();
    for (const base of STRENGTHS) {
      for (const s of variants(base)) parsed.set(s, parseStrength(s));
    }
    const plain = STRENGTHS.map((s) => parsed.get(s) ?? null);
    for (const a of plain) for (const b of plain) strengthsEqual(a, b);
    for (const base of NAMES) for (const s of variants(base)) normalizeName(s);
    for (const base of REG_NOS) for (const s of variants(base)) normalizeRegistrationNumber(s);
  });
});

/* ------------------------------------------------- 4. explanation probes */

const EXPLAIN_LABEL: ExtractedLabel = {
  imageKind: 'label',
  fields: [
    lf('brandName', C('Paracelin 500')),
    lf('genericNames', C('Paracetamol')),
    lf('strength', C('500 mg')),
    lf('dosageForm', C('Tablet')),
    lf('directions', C('Adults: 1 tablet every 4 to 6 hours as needed.')),
    lf('warnings', P('Do not use with other products containing paracetamol.')),
    lf('storage', C('Store in a cool dry place.')),
  ],
  rawText: 'DEMO DATA Paracelin 500',
  warnings: [],
};
const EXPLAIN_MATCH: MatchAssessment = {
  status: 'conflicting',
  matched: ['brandName'],
  conflicting: [{ key: 'strength', labelValue: '500 mg', referenceValue: '250 mg' }],
  missing: [],
  candidates: [],
  advisories: [],
  limitations: [],
};
const PRINTED = [
  'Store in a cool dry place',
  'Adults: 1 tablet every 4 to 6 hours as needed.',
  'Do not use with other products containing paracetamol.',
  'Shake well before use',
];
const PHRASES = ['as needed', 'store in a cool dry place', 'paracetamol', 'shake well', 'tablet'];
const GOOD_EXPLANATIONS = [
  'Keep it somewhere that is not hot or damp.',
  'Keep it​ away\nfrom heat.',
  'Take it when you need it, as the label says.',
];

describe('explanation probes', () => {
  test('round 2 probes and good explanations through the gate and the composer', () => {
    const texts = [...ROUND2_PROBE_CASES.map(([, t]) => t), ...GOOD_EXPLANATIONS];
    for (const t of texts) {
      explanationAllowed(t);
      for (const p of PRINTED) explanationFits(t, p);
    }
    for (const p of PRINTED) quoteExplainable(p);
    for (const base of PHRASES) {
      for (const phrase of variants(base)) {
        findPhraseInFields(phrase, EXPLAIN_LABEL);
        explainQuote(phrase, EXPLAIN_LABEL);
      }
    }
    const input = {
      label: EXPLAIN_LABEL,
      match: EXPLAIN_MATCH,
      question: 'What does "as needed" mean?',
      intent: 'explain_text' as const,
    };
    for (const phrase of PHRASES) {
      composeExplainAnswer(input, phrase, null);
      for (const t of texts) composeExplainAnswer(input, phrase, t);
    }
    for (const kind of ['label', 'loose_pill', 'not_medicine', 'unreadable'] as const) {
      notALabelAnswer({ ...EXPLAIN_LABEL, imageKind: kind });
    }
    unclearAnswer("I can't find that phrase on this label.");
    conflictWarning('strength', ' 250 mg.. ');
    advisorySentence(ADVISORIES);
    advisorySentence([]);
  });
});

/* -------------------------------------------------------- 5. scenarios */

/** Fields that differ per run (or per server) and are stripped from scenarios.jsonl. */
const SCENARIO_STRIPPED = ['id', 'createdAt', 'expiresAt'] as const;

describe('demo scenarios over HTTP (ruling R3)', () => {
  test.each(SCENARIO_IDS)('%s', async (scenarioId) => {
    const { app } = makeApp();
    const res = await request(app).post('/api/v1/demo/scenario').send({ scenarioId });
    expect(res.status).toBe(200);
    expect(AnalysisResultSchema.safeParse(res.body).success).toBe(true);
    const body = { ...(res.body as Record<string, unknown>) };
    for (const k of SCENARIO_STRIPPED) {
      expect(body).toHaveProperty(k);
      delete body[k];
    }
    record('scenarios', 'POST /api/v1/demo/scenario', [{ scenarioId }], body);
  });
});
