import {
  AnswerSchema,
  DemoScenarioSummarySchema,
  ExtractedLabelSchema,
  MatchAssessmentSchema,
  QualityReportSchema,
  ReferenceRecordSchema,
  type MatchStatus,
} from '@medilens/contracts';
import { describe, expect, test } from 'vitest';
import { DEMO_SCENARIOS, getScenario, type DemoScenarioId } from '../../src/demo/scenarios';
import { assessMatch } from '../../src/domain/matcher';
import { classifyQuestion, type AllowedIntent } from '../../src/domain/safety';
import { ADVISORY_SENTENCE } from '../../src/domain/summary';
import {
  FixtureAnswerer,
  FixtureLabelReader,
  FixtureReferenceProvider,
} from '../../src/providers/fixture';
import type { AnswerInput } from '../../src/providers/types';

const IDS: DemoScenarioId[] = [
  's1-clear',
  's2-blurry',
  's3-similar',
  's4-conflict',
  's5-nomatch',
  's6-loose-pill',
  's7-unsupported-question',
  's8-registry-down',
];

function scenario(id: DemoScenarioId) {
  const s = getScenario(id);
  if (s === undefined) throw new Error(`missing scenario ${id}`);
  return s;
}

const FICTIONAL = /Paracelin 500|Paracelin 250|Paracelin-Forte 500|Amoxivan 500|Paracelin|Amoxivan/;

describe('DEMO_SCENARIOS', () => {
  test('has exactly the eight scenario ids in order', () => {
    expect(DEMO_SCENARIOS.map((s) => s.id)).toEqual(IDS);
  });

  test.each(IDS)('%s: every fixture validates against the contracts schemas', (id) => {
    const s = scenario(id);
    expect(QualityReportSchema.safeParse(s.quality).success).toBe(true);
    expect(ExtractedLabelSchema.safeParse(s.label).success).toBe(true);
    expect(DemoScenarioSummarySchema.safeParse({ id: s.id, title: s.title }).success).toBe(true);
    if (s.reference.kind === 'ok') {
      for (const r of s.reference.records) {
        expect(ReferenceRecordSchema.safeParse(r).success).toBe(true);
        expect(r.sourceUrl).toMatch(/^https:\/\/verification\.fda\.gov\.ph\/\?q=/);
        expect(r.registrationNumber).toMatch(/^DR-XY9\d{5}$/);
        expect(r.brandName ?? '').toMatch(FICTIONAL);
      }
    }
    if (s.cannedAnswer !== undefined) {
      expect(AnswerSchema.safeParse(s.cannedAnswer).success).toBe(true);
    }
  });

  test.each(IDS)('%s: title is labelled DEMO DATA', (id) => {
    expect(scenario(id).title.startsWith('DEMO DATA:')).toBe(true);
  });

  test.each(IDS)('%s: registration numbers on the label are in the synthetic range', (id) => {
    for (const f of scenario(id).label.fields) {
      if (f.key === 'registrationNumber' && f.value !== null) {
        expect(f.value).toMatch(/^DR-XY9\d{5}$/);
      }
    }
  });

  const expected: [DemoScenarioId, MatchStatus][] = [
    ['s1-clear', 'verified'],
    ['s3-similar', 'ambiguous'],
    ['s4-conflict', 'conflicting'],
    ['s5-nomatch', 'no_match'],
    ['s7-unsupported-question', 'verified'],
    ['s8-registry-down', 'unavailable'],
  ];
  test.each(expected)('%s: the real matcher yields %s', (id, status) => {
    const s = scenario(id);
    const match = assessMatch(s.label, s.reference);
    expect(MatchAssessmentSchema.safeParse(match).success).toBe(true);
    expect(match.status).toBe(status);
  });

  test('s3: both candidates listed, none chosen', () => {
    const s = scenario('s3-similar');
    const match = assessMatch(s.label, s.reference);
    expect(match.candidates.map((c) => c.brandName)).toEqual([
      'Paracelin 500',
      'Paracelin-Forte 500',
    ]);
  });

  test('s4: the conflict is the strength, 500 mg on the label vs 250 mg in the record', () => {
    const s = scenario('s4-conflict');
    const match = assessMatch(s.label, s.reference);
    expect(match.conflicting).toHaveLength(1);
    expect(match.conflicting[0]?.key).toBe('strength');
    expect(match.conflicting[0]?.labelValue).toBe('500 mg');
    expect(match.conflicting[0]?.referenceValue).toContain('250 mg');
  });

  test('s1: one record only under its registration number', () => {
    const s = scenario('s1-clear');
    expect(s.reference.kind).toBe('ok');
    if (s.reference.kind === 'ok') expect(s.reference.records).toHaveLength(1);
  });

  test('s2: quality fails with BLURRY and GLARE', () => {
    const s = scenario('s2-blurry');
    expect(s.quality.ok).toBe(false);
    expect(s.quality.reasons).toEqual(['BLURRY', 'GLARE']);
    expect(s.label.imageKind).toBe('unreadable');
  });

  test('passing scenarios have a passing quality report', () => {
    for (const s of DEMO_SCENARIOS.filter((x) => x.id !== 's2-blurry')) {
      expect(s.quality.ok).toBe(true);
      expect(s.quality.reasons).toEqual([]);
    }
  });

  test('s6: loose pill with every field value null', () => {
    const s = scenario('s6-loose-pill');
    expect(s.label.imageKind).toBe('loose_pill');
    expect(s.label.fields.every((f) => f.value === null)).toBe(true);
  });

  test('s7: preset question is refused by the safety gate and the canned answer is a refusal', () => {
    const s = scenario('s7-unsupported-question');
    expect(s.presetQuestion).toBe('How many should I take for my headache?');
    expect(classifyQuestion(s.presetQuestion ?? '').allowed).toBe(false);
    expect(s.cannedAnswer?.status).toBe('refused');
  });

  test('s8: label is still read', () => {
    const s = scenario('s8-registry-down');
    expect(s.label.imageKind).toBe('label');
    expect(s.label.fields.some((f) => f.value !== null)).toBe(true);
  });

  test('getScenario returns undefined for an unknown id', () => {
    expect(getScenario('nope')).toBeUndefined();
  });
});

describe('fixture providers', () => {
  test('FixtureLabelReader returns the scenario label', async () => {
    const reader = new FixtureLabelReader();
    const r = await reader.read([], { scenarioId: 's1-clear' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.label).toEqual(scenario('s1-clear').label);
      expect(r.model).not.toContain('contributor');
    }
  });

  test('FixtureLabelReader fails with OCR_FAILED for an unknown or absent scenario', async () => {
    const reader = new FixtureLabelReader();
    expect(await reader.read([], { scenarioId: 'nope' })).toMatchObject({
      ok: false,
      code: 'OCR_FAILED',
    });
    expect(await reader.read([], {})).toMatchObject({ ok: false, code: 'OCR_FAILED' });
  });

  test('FixtureReferenceProvider returns the scenario reference', async () => {
    const provider = new FixtureReferenceProvider();
    for (const s of DEMO_SCENARIOS) {
      expect(await provider.search({ name: 'x' }, { scenarioId: s.id })).toEqual(s.reference);
    }
  });

  test('FixtureReferenceProvider is unavailable for an unknown scenario', async () => {
    const provider = new FixtureReferenceProvider();
    const r = await provider.search({ registrationNumber: 'DR-XY900001' }, { scenarioId: 'nope' });
    expect(r.kind).toBe('unavailable');
  });

  test('FixtureAnswerer returns the canned answer for the s7 preset', async () => {
    const s = scenario('s7-unsupported-question');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: s.presetQuestion ?? '',
        intent: 'read_label',
      },
      { scenarioId: s.id },
    );
    expect(a).toEqual(s.cannedAnswer);
  });

  test('FixtureAnswerer answers an allowed strength question from the label, deterministically', async () => {
    const s = scenario('s1-clear');
    const input: AnswerInput = {
      label: s.label,
      match: assessMatch(s.label, s.reference),
      question: 'What strength is printed here?',
      intent: 'strength',
    };
    const answerer = new FixtureAnswerer();
    const a = await answerer.answer(input, { scenarioId: s.id });
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a.status).toBe('answered');
    expect(a.citedFields).toEqual(['strength']);
    expect(a.text).toContain('500 mg');
    expect(await answerer.answer(input, { scenarioId: s.id })).toEqual(a);
  });

  test('FixtureAnswerer cites only fields present on the label for a read_label question', async () => {
    const s = scenario('s8-registry-down');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: 'Can you read this label?',
        intent: 'read_label',
      },
      { scenarioId: s.id },
    );
    expect(a.status).toBe('answered');
    expect(a.citedFields.length).toBeGreaterThan(0);
    expect(a.text).not.toContain('..');
    expect(a.spokenChunks.at(-1)).toBe('Confirm with your pharmacist or doctor.');
    const present = new Set(s.label.fields.filter((f) => f.value !== null).map((f) => f.key));
    for (const k of a.citedFields) expect(present.has(k)).toBe(true);
  });

  test('FixtureAnswerer marks a field that is not clear as uncertain', async () => {
    const s = scenario('s3-similar');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: 'Which parts were unclear?',
        intent: 'unclear_parts',
      },
      { scenarioId: s.id },
    );
    expect(a.status).toBe('answered');
    expect(a.citedFields).toContain('brandName');
    expect(a.safetyNotice).not.toBeNull();
  });

  test('FixtureAnswerer returns unclear when the label has nothing to cite', async () => {
    const s = scenario('s6-loose-pill');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: 'Can you read this label?',
        intent: 'read_label',
      },
      { scenarioId: s.id },
    );
    expect(a.status).toBe('unclear');
    expect(a.citedFields).toEqual([]);
  });
  test.each<AllowedIntent>(['strength', 'read_label'])(
    'FixtureAnswerer warns about the registry conflict on s4 (%s)',
    async (intent) => {
      const s = scenario('s4-conflict');
      const match = assessMatch(s.label, s.reference);
      expect(match.conflicting.map((c) => c.key)).toContain('strength');
      const ref = match.conflicting.find((c) => c.key === 'strength')?.referenceValue ?? '';
      const a = await new FixtureAnswerer().answer(
        { label: s.label, match, question: 'What strength is this?', intent },
        { scenarioId: s.id },
      );
      expect(AnswerSchema.safeParse(a).success).toBe(true);
      expect(a.citedFields).toContain('strength');
      const warning = `The FDA registry record lists ${ref} for the strength, which does not match the pack. Confirm with your pharmacist.`;
      expect(a.text).toContain(warning);
      expect(a.spokenChunks).toContain(warning);
      expect(a.safetyNotice).toBe(warning);
      expect(a.spokenChunks.at(-1)).toBe('Confirm with your pharmacist or doctor.');
    },
  );

  test('FixtureAnswerer adds no conflict warning when the registry agrees (s1 strength)', async () => {
    const s = scenario('s1-clear');
    const a = await new FixtureAnswerer().answer(
      { label: s.label, match: assessMatch(s.label, s.reference), question: 'Strength?', intent: 'strength' },
      { scenarioId: s.id },
    );
    expect(a.text).not.toContain('does not match the pack');
    expect(a.safetyNotice).toBeNull();
  });

  /* Task 7b: explain_text quotes a printed phrase; registry wording is the spoken summary's. */

  const NO_EXPLANATION = "I can't explain this phrase further.";

  test('FixtureAnswerer explain_text on s1 with a printed phrase gives the quote-only answer', async () => {
    const s = scenario('s1-clear');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: 'What does "keep out of reach of children" mean?',
        intent: 'explain_text',
      },
      { scenarioId: s.id },
    );
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a.status).toBe('answered');
    // Task 7b review round 2: the whole printed field is quoted, not the sentence
    expect(a.text).toBe(
      `The warnings on the label say "Do not use with other products containing paracetamol. Keep out of reach of children". ${NO_EXPLANATION}`,
    );
    expect(a.citedFields).toEqual(['warnings']);
    expect(a.spokenChunks.at(-1)).toBe('Confirm with your pharmacist or doctor.');
  });

  test('FixtureAnswerer explain_text with a phrase not printed on s1 is unclear', async () => {
    const s = scenario('s1-clear');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: 'What does "DEMO DATA" mean?',
        intent: 'explain_text',
      },
      { scenarioId: s.id },
    );
    expect(a.status).toBe('unclear');
    expect(a.text).toBe("I can't find that phrase on this label.");
    expect(a.citedFields).toEqual([]);
  });

  // final review I3: the field the question names, here the printed warnings only
  test('FixtureAnswerer explain_text naming no phrase reads the printed field it names', async () => {
    const s = scenario('s1-clear');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: 'What does this warning mean?',
        intent: 'explain_text',
      },
      { scenarioId: s.id },
    );
    expect(a.status).toBe('answered');
    expect(a.citedFields).toEqual(['warnings']);
    expect(a.text).toContain('Warnings as printed: Do not use with other products');
  });

  test('FixtureAnswerer registry intent on s4 names the conflicting field', async () => {
    const s = scenario('s4-conflict');
    const a = await new FixtureAnswerer().answer(
      {
        label: s.label,
        match: assessMatch(s.label, s.reference),
        question: 'What did the FDA registry say?',
        intent: 'registry',
      },
      { scenarioId: s.id },
    );
    expect(a.status).toBe('answered');
    expect(a.text).toBe('The strength on the label does not match the registry.');
  });

  test('FixtureAnswerer registry intent with an advisory uses ADVISORY_SENTENCE exactly', async () => {
    const s = scenario('s1-clear');
    const match = {
      ...assessMatch(s.label, s.reference),
      advisories: [
        { title: 'DEMO DATA counterfeit advisory', url: 'https://www.fda.gov.ph/demo-advisory' },
      ],
    };
    const a = await new FixtureAnswerer().answer(
      { label: s.label, match, question: 'What did the FDA registry say?', intent: 'registry' },
      { scenarioId: s.id },
    );
    expect(a.text).toBe(
      `This matches a product in the Philippine FDA registry. ${ADVISORY_SENTENCE}`,
    );
  });
});
