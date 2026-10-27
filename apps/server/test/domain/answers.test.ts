import {
  AnswerSchema,
  type ExtractedLabel,
  type FieldKey,
  type LabelField,
  type MatchAssessment,
  type MatchStatus,
} from '@medilens/contracts';
import { describe, expect, test } from 'vitest';
import {
  ANSWER_FALLBACK_TEXT,
  EXPLANATION_WORDS,
  FIELD_NAMES,
  PHRASE_NOT_FOUND_TEXT,
  answerFromLabel,
  composeExplainAnswer,
  conflictWarning,
  explainQuote,
  explanationAllowed,
  explanationFits,
  findPhraseInFields,
  quoteExplainable,
} from '../../src/domain/answers';
import { ADVISORY_SENTENCE, FINAL_LINE, STATUS_SENTENCE } from '../../src/domain/summary';
import type { AnswerInput } from '../../src/providers/types';
import { ROUND2_PROBE_CASES } from '../fixtures/explanationProbes';

/* Synthetic DEMO DATA label: fictional product, no network. */

function lf(
  key: FieldKey,
  value: string | null,
  legibility: LabelField['legibility'] = 'clear',
): LabelField {
  return { key, value, legibility, evidenceText: value, imageIndex: 0, notes: null };
}

function labelOf(fields: LabelField[], rawText = 'DEMO DATA'): ExtractedLabel {
  return { imageKind: 'label', fields, rawText, warnings: [] };
}

const LABEL = labelOf(
  [
    lf('brandName', 'Paracelin 500'),
    lf('genericNames', 'Paracetamol'),
    lf('strength', '500 mg'),
    lf('dosageForm', 'Tablet'),
    lf('registrationNumber', 'DR-XY900001'),
    lf('directions', 'Adults: 1 tablet every 4 to 6 hours as needed.'),
    lf('warnings', 'Do not use with other products containing paracetamol.'),
    lf('storage', 'Store in a cool dry place.'),
    lf('rxOrOtc', null),
  ],
  'DEMO DATA Paracelin 500 Shake well before use.',
);

const MATCH: MatchAssessment = {
  status: 'verified',
  matched: ['registrationNumber', 'brandName', 'strength'],
  conflicting: [],
  missing: [],
  candidates: [],
  advisories: [],
  limitations: [],
};

const ADVISORY = { title: 'DEMO DATA advisory', url: 'https://www.fda.gov.ph/demo-advisory' };

function input(over: Partial<AnswerInput> = {}): AnswerInput {
  return { label: LABEL, match: MATCH, question: 'Question?', intent: 'read_label', ...over };
}

const UNCERTAIN = 'Some of this was not clear on the pack, so it may be wrong.';
const NO_EXPLANATION = "I can't explain this phrase further.";

describe('answer texts', () => {
  test('fallback and phrase-not-found texts are fixed', () => {
    expect(ANSWER_FALLBACK_TEXT).toBe('I can only answer from what is printed on the label.');
    expect(PHRASE_NOT_FOUND_TEXT).toBe("I can't find that phrase on this label.");
  });

  test('FIELD_NAMES names every field key', () => {
    expect(FIELD_NAMES.storage).toBe('Storage');
    expect(FIELD_NAMES.expiryDate).toBe('Expiry date printed on the pack');
    expect(Object.keys(FIELD_NAMES)).toHaveLength(12);
  });

  test('conflictWarning names the registry value and the field', () => {
    expect(conflictWarning('strength', '250 mg Tablet.')).toBe(
      'The FDA registry record lists 250 mg Tablet for the strength, which does not match the pack. Confirm with your pharmacist.',
    );
  });
});

describe('findPhraseInFields', () => {
  test('matches case-insensitively and returns the text as printed', () => {
    const label = labelOf([lf('storage', 'Store in a COOL dry place.')]);
    expect(findPhraseInFields('store in a cool dry place', label)).toEqual([
      { key: 'storage', printed: 'Store in a COOL dry place', legibility: 'clear' },
    ]);
  });

  test('collapses whitespace runs in both the field and the phrase', () => {
    const label = labelOf([lf('warnings', 'Keep  out of\n reach\tof children.')]);
    expect(findPhraseInFields('keep out   of reach', label)).toEqual([
      { key: 'warnings', printed: 'Keep out of reach', legibility: 'clear' },
    ]);
  });

  test('searches field values only, never rawText', () => {
    expect(findPhraseInFields('shake well before use', LABEL)).toEqual([]);
  });

  test('a phrase printed nowhere has no hits', () => {
    expect(findPhraseInFields('fake', LABEL)).toEqual([]);
  });

  test('one hit per field that prints it, in field order, with that field legibility', () => {
    const label = labelOf([
      lf('genericNames', 'Paracetamol'),
      lf(
        'warnings',
        'Contains PARACETAMOL. Do not use with other paracetamol products.',
        'partial',
      ),
    ]);
    expect(findPhraseInFields('paracetamol', label)).toEqual([
      { key: 'genericNames', printed: 'Paracetamol', legibility: 'clear' },
      { key: 'warnings', printed: 'PARACETAMOL', legibility: 'partial' },
    ]);
  });

  test('fields with no value are skipped', () => {
    const label = labelOf([lf('rxOrOtc', null, 'unreadable'), lf('storage', '   ')]);
    expect(findPhraseInFields('otc', label)).toEqual([]);
  });

  test('matches whole words only, never part of a printed word', () => {
    const label = labelOf([lf('directions', 'For headache. Avoid dryness.')]);
    expect(findPhraseInFields('ache', label)).toEqual([]);
    expect(findPhraseInFields('dry', label)).toEqual([]);
    expect(findPhraseInFields('for headache', label)).toEqual([
      { key: 'directions', printed: 'For headache', legibility: 'clear' },
    ]);
  });

  test('a straight apostrophe in the phrase matches a curly one as printed', () => {
    const label = labelOf([lf('rxOrOtc', 'Sold only on a doctor\u2019s prescription.')]);
    expect(findPhraseInFields("doctor's prescription", label)).toEqual([
      { key: 'rxOrOtc', printed: 'doctor\u2019s prescription', legibility: 'clear' },
    ]);
  });

  test('an empty or blank phrase has no hits', () => {
    expect(findPhraseInFields('', LABEL)).toEqual([]);
    expect(findPhraseInFields('   ', LABEL)).toEqual([]);
  });

  test('regex characters in the phrase are literal', () => {
    const label = labelOf([lf('warnings', 'Shake (well) before use.')]);
    expect(findPhraseInFields('shake (well)', label)).toEqual([
      { key: 'warnings', printed: 'Shake (well)', legibility: 'clear' },
    ]);
    expect(findPhraseInFields('shake .well.', label)).toEqual([]);
  });
});

describe('explainQuote (Task 7b review rounds 1 and 2)', () => {
  const WARNINGS =
    'Do not use with other products containing paracetamol. Keep out of reach of children.';

  // round 2: the whole printed field, not the sentence, so a heading or
  // lead-in printed as its own sentence is never dropped
  test('a fragment quotes the whole printed field value, end punctuation dropped', () => {
    const label = labelOf([lf('warnings', WARNINGS)]);
    expect(explainQuote('other products', label)).toBe(WARNINGS.replace(/\.$/, ''));
    expect(explainQuote('out of reach', label)).toBe(WARNINGS.replace(/\.$/, ''));
  });

  test('a phrase that is a whole field is quoted as printed', () => {
    expect(explainQuote('store in a cool dry place', LABEL)).toBe('Store in a cool dry place');
    expect(explainQuote('store in a cool dry place.', LABEL)).toBe('Store in a cool dry place');
    expect(explainQuote('paracetamol', LABEL)).toBe('Paracetamol');
  });

  test('abbreviations and every sentence of the field are kept', () => {
    const label = labelOf([
      lf('warnings', 'Do not use with other medicines, e.g. cold remedies. Keep dry.'),
      lf('directions', 'Approx. 5 ml after meals.'),
    ]);
    expect(explainQuote('cold remedies', label)).toBe(
      'Do not use with other medicines, e.g. cold remedies. Keep dry',
    );
    expect(explainQuote('after meals', label)).toBe('Approx. 5 ml after meals');
  });

  test('a phrase across a sentence end quotes the whole field', () => {
    const label = labelOf([lf('warnings', WARNINGS)]);
    expect(explainQuote('paracetamol. keep out', label)).toBe(WARNINGS.replace(/\.$/, ''));
  });

  test('whitespace runs are collapsed in the quote', () => {
    const label = labelOf([lf('warnings', 'Do  not use\nwith other products.')]);
    expect(explainQuote('other products', label)).toBe('Do not use with other products');
  });

  test('the first field that prints the phrase is quoted', () => {
    const label = labelOf([
      lf('warnings', 'Contains paracetamol. Do not exceed.'),
      lf('genericNames', 'Paracetamol'),
    ]);
    expect(explainQuote('paracetamol', label)).toBe('Contains paracetamol. Do not exceed');
  });

  // Task 7b review round 2, finding 2: a negation printed as a heading or
  // lead-in that ends in its own sentence was dropped from the quote.
  test.each([
    [
      'a heading ending in a colon over a list',
      'Do not use with:\nAlcohol.\nOther products containing paracetamol.',
      'other products containing paracetamol',
      'Do not use with: Alcohol. Other products containing paracetamol',
    ],
    [
      'an all-caps heading with a colon',
      'DO NOT USE: With alcohol. With other products containing paracetamol.',
      'other products containing paracetamol',
      'DO NOT USE: With alcohol. With other products containing paracetamol',
    ],
    [
      'a negation carried over to the next sentence',
      'Do not use if you have liver disease. Or with other products containing paracetamol.',
      'other products containing paracetamol',
      'Do not use if you have liver disease. Or with other products containing paracetamol',
    ],
  ])('%s: the printed negation is in the quote', (_layout, warnings, phrase, quote) => {
    const label = labelOf([lf('warnings', warnings)]);
    expect(explainQuote(phrase, label)).toBe(quote);
  });

  test('a phrase printed nowhere has no quote', () => {
    expect(explainQuote('shake well before use', LABEL)).toBeNull();
    expect(explainQuote('', LABEL)).toBeNull();
  });
});

describe('explanationAllowed', () => {
  test.each([
    'Take 2 tablets.',
    'Children: one tablet.',
    'Junior dose',
    'It is safe.',
    'This is genuine.',
    'twice a day',
    'every 6 hours',
    'Do not exceed the maximum.',
    'Adults only.',
    'for kids',
    'x'.repeat(241),
  ])('rejects %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  // Round 2: the brief's 'Shake the bottle before use.' became 'Shake the
  // bottle well first.': "use" is not in the closed vocabulary (review
  // round 2 finding 1 names "use" as an imperative to reject).
  test.each([
    'Keep it somewhere that is not hot or damp.',
    'Shake the bottle well first.',
    "It means you need a doctor's prescription to buy this.",
  ])('accepts %j', (text) => {
    expect(explanationAllowed(text)).toBe(true);
  });

  test('the brief accept case "Shake the bottle before use." is rejected since round 2', () => {
    expect(explanationAllowed('Shake the bottle before use.')).toBe(false);
  });

  test.each([
    'It means the pack may be fake.',
    'Fakes look like this.',
    'Watch for COUNTERFEIT packs.',
    'It is not authentic.',
    'It is dangerous.',
    'It is harmless.',
    'It is unsafe.',
    'The product is registered.',
    'It is approved by the agency.',
    'We recommend it.',
    'You should keep it cold.',
    'You must keep it cold.',
    'Stop if you feel ill.',
    'Start slowly.',
    'Avoid heat.',
    'It cures pain.',
    'It treats pain.',
    'It is a treatment.',
  ])('rejects the verdict or advice word in %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each([
    'Use half of it.',
    'A quarter is enough.',
    'Use it once.',
    'A double amount.',
    'A single use.',
    'A dozen of them.',
    'It means three.',
    'Use a hundred.',
    'Twenty is the limit.',
    'Ninety is the limit.',
  ])('rejects the number word in %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each([
    // "Some", not "A few": "few" is itself blocked (round 1), and each case must isolate one word
    'Some mg of it.',
    'Some mcg of it.',
    'Some \u00B5g of it.',
    'Some g of it.',
    'A gram of it.',
    'Some ml of it.',
    'A millilitre of it.',
    'A milliliter of it.',
    'A litre of it.',
    'A liter of it.',
    'Some l of it.',
    'A tablet of it.',
    'Some tabs of it.',
    'A capsule of it.',
    'Some caps of it.',
    'Some pills of it.',
    'A drop of it.',
    'A puff of it.',
    'A spoon of it.',
    'A teaspoon of it.',
    'A tablespoon of it.',
    'A sachet of it.',
    'The dose of it.',
    'The dosage of it.',
    'Wait an hour.',
    'Hourly use.',
    'For a day.',
    'Daily use.',
    'For a week.',
    'Weekly use.',
    'In the morning.',
    'At night.',
    'At bedtime.',
    'Wait a minute.',
    'The max amount.',
    'An overdose risk.',
  ])('rejects the unit or dose word in %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each([
    'For a child.',
    'For an infant.',
    'For a baby.',
    'For babies.',
    'For toddlers.',
    'For the elderly.',
    'For older people.',
    'For seniors.',
    'For teens.',
    'For adolescents.',
    'Jr strength.',
    'A pediatric form.',
    'A paediatric form.',
    'During pregnancy.',
    'While breastfeeding.',
    'While nursing.',
    'For patients.',
    'For a year.',
    'Some years old.',
    'Aged people.',
    'By age.',
    'By weight.',
    'In kg.',
  ])('rejects the population word in %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each([
    'See https://example.com for more.',
    'See www.example.com for more.',
    'See example.com for more.',
    'Email help at help@example.com.',
    'Ask @pharmacist.',
  ])('rejects a URL or an @ in %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each(['', '   ', '\u200B'])('rejects empty text %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  // round 2: built from vocabulary words, since 'x' is not one
  test('length: 240 characters is allowed, 241 is not', () => {
    const at240 = `${Array(24).fill('somewhere').join(' ')}.`;
    expect(at240).toHaveLength(240);
    expect(explanationAllowed(at240)).toBe(true);
    expect(explanationAllowed(` ${at240} `)).toBe(true);
    expect(explanationAllowed(`${at240}.`)).toBe(false);
    expect(explanationAllowed('x'.repeat(241))).toBe(false);
  });

  test('words: 40 are allowed, 41 are not', () => {
    expect(explanationAllowed(Array(40).fill('it').join(' '))).toBe(true);
    expect(explanationAllowed(Array(41).fill('it').join(' '))).toBe(false);
  });

  test.each([
    ['a full-width digit', 'Use \uFF12 of it.'],
    ['a superscript digit', 'Use it\u00B2.'],
    ['an Arabic-Indic digit', 'Use \u0662 of it.'],
    ['a vulgar fraction', 'Use \u00BD of it.'],
  ])('rejects %s after NFKC', (_name, text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each([
    ['a zero-width space inside a word', 'Ta\u200Bke it with water.'],
    ['a soft hyphen inside a word', 'It is co\u00ADunterfeit.'],
    ['a word joiner inside a word', 'Chil\u2060dren only.'],
  ])('rejects a blocked word hidden by %s', (_name, text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each([
    ['inflected advice verbs', 'Taking it with water.'],
    ['a contraction of should', "You shouldn't keep it warm."],
    ['a hyphenated breast-feeding', 'Ask before breast-feeding.'],
    ['teenagers', 'Not for teenagers.'],
    ['a plural time word', 'In the mornings.'],
    ['an evening time word', 'In the evening.'],
    ['an inflected exceed', 'Never exceeding it.'],
  ])('rejects %s (word-list variants)', (_name, text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test.each([
    ['a Cyrillic look-alike letter', 'It is s\u0430fe.'],
    ['an emoji', 'Keep it cool \u{1F642}'],
  ])('rejects %s: explanations are plain English only', (_name, text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  // Spec §4.3: no indications, interactions or suitability. Not in the brief's
  // lists; added because a phrase like a generic name invites exactly these.
  test.each([
    'Paracetamol is a common medicine for pain and fever.',
    'It relieves headaches.',
    'It gives relief.',
    'It is a medicine for infections.',
    'It eases symptoms.',
    'It helps with coughs and flu.',
    'It is for a disease of the skin.',
    'It is for an illness.',
    'Ask about allergies.',
    'There may be side effects.',
    'It is okay to drink alcohol with it.',
    'It can be combined with other medicines.',
    'Other medicines may interact with it.',
    'It is fine for most people.',
    'It is OK for most people.',
    'It is suitable for most people.',
    'There is a small risk.',
    'It does no harm.',
    'Fine for youngsters.',
    'Keep it from young ones.',
  ])('rejects the medical-claim word in %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  // Task 7b review round 1: the reviewer's probes, each accepted by the round 0 gate.
  test.each([
    'This number shows the product is verified.',
    'It means the product has passed checks and is legitimate.',
    'It is legit and real.',
    'Use it as often as you need.',
    'Use it several times.',
    'Use a little more each time.',
    'Use it as much as you like.',
    'Use a lot of it.',
    'Use it again later.',
    'Use it for a fortnight.',
    'Use it at lunch and dinner.',
    'Keep using it until you feel better.',
    'Not for minors.',
    'Not for men or women.',
    'Give it to your son.',
    'Do not give to boys or girls.',
    'Grown ups.',
    'You can drink it with wine.',
    'You can use it together with other paracetamol products.',
    'Paracetamol is the active ingredient that lowers a high temperature.',
  ])('rejects the round 1 probe %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  // Each blocked word on its own, in a frame the gate accepts, so no case
  // passes on the strength of another word. Round 2: the round 1 frame
  // "It is X here." is outside the closed vocabulary, so the frame changed.
  const FRAME = (w: string) => `Keep it ${w} in a cool place.`;

  test('the frame alone is accepted', () => {
    expect(explanationAllowed(FRAME('closed'))).toBe(true);
  });

  // prettier-ignore
  test.each([
    // verdicts (round 1 review list)
    'verified', 'verify', 'legit', 'legitimate', 'valid', 'validated', 'real', 'official',
    'officially', 'certified', 'certificate', 'authorized', 'authorised', 'authority', 'FDA',
    'registry',
    // frequencies and amounts (round 1 review list)
    'often', 'frequent', 'frequently', 'regular', 'regularly', 'several', 'many', 'few', 'more',
    'less', 'much', 'lot', 'lots', 'little', 'extra', 'again', 'repeat', 'repeated', 'each',
    'every', 'per', 'times', 'fortnight', 'meal', 'meals', 'breakfast', 'lunch', 'dinner', 'until',
    // groups of people (round 1 review list)
    'minor', 'minors', 'men', 'man', 'women', 'woman', 'boy', 'boys', 'girl', 'girls', 'son',
    'sons', 'daughter', 'daughters', 'mother', 'mothers', 'father', 'fathers', 'grown ups',
    'grown-ups', 'grownups',
    // interactions and indications (round 1 review list)
    'together', 'along', 'alongside', 'drink', 'drinking', 'wine', 'beer', 'temperature',
  ])('rejects the round 1 review word %j', (w) => {
    expect(explanationAllowed(FRAME(w))).toBe(false);
  });

  // Same classes, not in the review list: synonyms the round 1 probes imply.
  // prettier-ignore
  test.each([
    // verdicts
    'invalid', 'licensed', 'licenced', 'legal', 'illegal', 'lawful', 'trusted', 'original',
    'guaranteed', 'checked', 'tested', 'passed',
    // permission and advice
    'can', 'cannot', 'could', 'may', 'might', 'allowed', 'permitted', 'give', 'given', 'gave',
    'continue', 'continuing',
    // frequencies, times and amounts
    'time', 'always', 'usually', 'sometimes', 'occasionally', 'whenever', 'later', 'amount',
    'quantity', 'enough', 'plenty', 'most', 'least', 'fewer', 'couple', 'pair', 'till', 'supper',
    'food', 'eat', 'eating', 'ate',
    // groups of people
    'people', 'person', 'persons', 'individuals', 'male', 'female', 'lady', 'ladies', 'wife',
    'wives', 'husband', 'parent', 'parents', 'mum', 'mom', 'dad', 'brother', 'sister', 'family',
    'families', 'youth', 'everyone', 'everybody', 'anyone', 'anybody', 'someone', 'somebody',
    // interactions
    'other', 'others', 'drug', 'drugs', 'liquor', 'drank', 'drunk',
    // indications and how the body feels
    'lower', 'lowers', 'reduce', 'reduces', 'ease', 'eases', 'soothe', 'heal', 'healing', 'health',
    'help', 'helps', 'better', 'worse', 'feel', 'ill', 'sick', 'unwell', 'hurt', 'sore',
  ])('rejects the round 1 synonym %j', (w) => {
    expect(explanationAllowed(FRAME(w))).toBe(false);
  });

  test('curly apostrophes are plain English', () => {
    expect(explanationAllowed('It means you need a doctor\u2019s prescription to buy this.')).toBe(
      true,
    );
  });
});

describe('explanationAllowed: closed vocabulary (Task 7b review round 2)', () => {
  // Finding 1: each was accepted by the round 1 denylist at bb4db5c.
  test.each(ROUND2_PROBE_CASES)('rejects the round 2 probe (%s) %j', (_kind, text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  // Finding 1 minimum: an imperative or permission, each alone in a sentence
  // the gate otherwise accepts.
  test.each([
    'Keep it in a cool place and use it.',
    'Use it.',
    'Keep it in a cool place and mix it.',
    'Keep it in a cool place and apply it.',
    'Go ahead and keep it in a cool place.',
    'Ignore it and keep it in a cool place.',
    'You need not keep it in a cool place.',
    'You need not a prescription.',
    'It does not apply.',
    'No limit.',
    'Keep it in a cool place as needed.',
    'Keep it in a cool place with the bottle.',
    'Keep it with it.',
  ])('rejects the imperative or permission in %j', (text) => {
    expect(explanationAllowed(text)).toBe(false);
  });

  test('the vocabulary is closed and pinned: widening it must change this test', () => {
    expect(EXPLANATION_WORDS).toEqual([
      'a',
      'an',
      'and',
      'bottle',
      'closed',
      'container',
      'cool',
      'dark',
      'dry',
      'first',
      'gently',
      'in',
      'it',
      'its',
      'keep',
      'lid',
      'means',
      'or',
      'place',
      'shake',
      'shut',
      'somewhere',
      'store',
      'the',
      'this',
      'tightly',
      'well',
    ]);
  });

  test.each(['friend', 'okay', 'with', 'use', 'for', 'as', 'is', 'not', 'need', 'no', 'you'])(
    'a word outside the vocabulary (%j) is rejected on its own',
    (w) => {
      expect(explanationAllowed(`Keep it in a cool place ${w}.`)).toBe(false);
    },
  );

  test.each([
    'Keep it somewhere that is not hot or damp.',
    'Keep it somewhere that is not hot, damp or wet.',
    'Keep it somewhere which is not warm.',
    'Not humid.',
    'Keep it away from heat.',
    'Keep it away from heat and light.',
    'Keep it away from direct sunlight, heat and moisture.',
    'Keep the lid tightly closed.',
    'Store it somewhere cool, dry and dark.',
    'Shake the bottle gently first.',
    'Keep it somewhere that is not hot. Keep the lid closed.',
    'It means you need a prescription.',
    'This means you need a prescription from a doctor.',
    "You need a doctor's prescription to get it.",
  ])('accepts the closed shape %j', (text) => {
    expect(explanationAllowed(text)).toBe(true);
  });

  // The only negation is "not" before a storage hazard, ending its sentence,
  // and "need" only appears in "need a prescription": neither can be turned.
  test.each([
    ['a hazard word without "not"', 'Keep it somewhere hot.'],
    ['a hazard word without "not" (damp)', 'Store it somewhere damp.'],
    ['"not" before a good condition', 'Keep it somewhere that is not cool.'],
    ['"not" before a good condition (dry)', 'Keep it somewhere that is not dry or dark.'],
    ['a good condition chained after a hazard', 'Keep it somewhere that is not hot or cool.'],
    ['a good condition chained after a hazard (comma)', 'Keep it somewhere that is not hot, dry.'],
    ['"away from" a good condition', 'Keep it away from the lid.'],
    ['a good condition chained after "away from"', 'Keep it away from heat or cool.'],
    ['"is" outside "that is not"', 'It is cool.'],
    ['"is not" outside a hazard', 'It is not hot.'],
    ['a negated prescription', 'It means you do not need a prescription.'],
    ['"no" prescription', 'It means no prescription.'],
    ['a prescription that is not needed', 'A prescription is not needed.'],
    ['"need" outside "need a prescription"', 'You need it.'],
    ['a question', 'Keep it somewhere cool?'],
    ['a semicolon', 'Keep it cool; dry.'],
  ])('rejects %s: %j', (_why, text) => {
    expect(explanationAllowed(text)).toBe(false);
  });
});

describe('quoteExplainable and explanationFits (Task 7b review round 2)', () => {
  // A printed negation, condition, exception or group of people is never
  // explained: the vocabulary cannot carry it, so the answer is the quote alone.
  test.each([
    'Do not store above 30 degrees Celsius.',
    "Don't store in the bathroom.",
    'Dont freeze. Store in a cool place.',
    'Never freeze. Store in a cool place.',
    'Store in a cool place unless told otherwise.',
    'Store in a fridge if opened.',
    'Store in a cool place except when travelling.',
    'Avoid heat. Store in a dry place.',
    'Store without the cap.',
    'Store in a cool place. Keep out of reach of children.',
    'Store in a cool place until opened.',
    'Non-prescription medicine.',
    'Sold over the counter or on prescription.',
    'OTC or Rx.',
    'Do not use with:\nAlcohol.\nOther products containing paracetamol.',
    'DO NOT USE: With alcohol. With other products containing paracetamol.',
    'Do not use if you have liver disease. Or with other products containing paracetamol.',
  ])('a printed negation, condition or group is never explained: %j', (printed) => {
    expect(quoteExplainable(printed)).toBe(false);
    expect(explanationFits('Keep it somewhere that is not hot or damp.', printed)).toBe(false);
  });

  // Each topic of the vocabulary is used only when the printed text is about it.
  test.each([
    ['Store in a cool dry place', 'Keep it somewhere that is not hot or damp.', true],
    ['Store in a cool dry place', 'Keep it away from heat.', true],
    ['Protect from light', 'Keep it away from light.', true],
    ['Keep container tightly closed', 'Keep the lid tightly closed.', true],
    ['Shake well before use', 'Shake the bottle well first.', true],
    ['Rx only', "It means you need a doctor's prescription to buy this.", true],
    ['Prescription medicine', 'It means you need a prescription.', true],
    ['Shake well before use', 'Keep it away from heat.', false],
    ['Store in a cool dry place', "It means you need a doctor's prescription to buy this.", false],
    ['Store in a cool dry place', 'Shake the bottle well first.', false],
    ['Dissolve in a glass of water', 'Keep it away from moisture.', false],
    ['500 mg', 'Keep it somewhere that is not hot or damp.', false],
    ['Paracetamol', 'It means you need a prescription.', false],
  ])('printed %j, explanation %j: fits %s', (printed, explanation, fits) => {
    expect(explanationFits(explanation, printed)).toBe(fits);
  });

  test.each(['500 mg', 'Paracetamol', 'Adults: 1 tablet every 4 to 6 hours as needed.', 'Tablet'])(
    'printed text no vocabulary topic covers is not explained: %j',
    (printed) => {
      expect(quoteExplainable(printed)).toBe(false);
    },
  );

  test.each(['Store in a cool dry place', 'Shake well before use', 'Rx only'])(
    'printed text a vocabulary topic covers is explained: %j',
    (printed) => {
      expect(quoteExplainable(printed)).toBe(true);
    },
  );

  test('an explanation outside the vocabulary never fits', () => {
    for (const [, text] of ROUND2_PROBE_CASES) {
      expect(explanationFits(text, 'Store in a cool dry place')).toBe(false);
    }
  });
});

describe('composeExplainAnswer', () => {
  const PHRASE = 'store in a cool dry place';
  const STORAGE_QUOTE = 'The storage on the label says "Store in a cool dry place".';

  test('quotes the printed phrase and adds the explanation', () => {
    const a = composeExplainAnswer(input(), PHRASE, 'Keep it somewhere that is not hot or damp.');
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a).toEqual({
      status: 'answered',
      text: `${STORAGE_QUOTE} In plain words: Keep it somewhere that is not hot or damp.`,
      spokenChunks: [
        STORAGE_QUOTE,
        'In plain words: Keep it somewhere that is not hot or damp.',
        FINAL_LINE,
      ],
      citedFields: ['storage'],
      safetyNotice: null,
    });
  });

  test('the explanation is trimmed and ends in a period', () => {
    const a = composeExplainAnswer(input(), PHRASE, '  Keep it away from heat  ');
    expect(a.text).toBe(`${STORAGE_QUOTE} In plain words: Keep it away from heat.`);
  });

  test('an explanation ending in other final punctuation gets no extra period', () => {
    const a = composeExplainAnswer(input(), PHRASE, 'Keep it away from heat!');
    expect(a.text).toBe(`${STORAGE_QUOTE} In plain words: Keep it away from heat!`);
  });

  test('the explanation is spoken as it was gated: NFKC, no invisible characters, one line', () => {
    const a = composeExplainAnswer(input(), PHRASE, 'Keep it\u200B away\nfrom heat.');
    expect(a.text).toBe(`${STORAGE_QUOTE} In plain words: Keep it away from heat.`);
  });

  test('with no explanation the answer is the quote only, still answered', () => {
    const a = composeExplainAnswer(input(), PHRASE, null);
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a).toEqual({
      status: 'answered',
      text: `${STORAGE_QUOTE} ${NO_EXPLANATION}`,
      spokenChunks: [STORAGE_QUOTE, NO_EXPLANATION, FINAL_LINE],
      citedFields: ['storage'],
      safetyNotice: null,
    });
  });

  test('an explanation the gate rejects is never spoken, even if passed in directly', () => {
    const a = composeExplainAnswer(input(), PHRASE, 'Take 2 tablets. It is safe.');
    expect(a.text).toBe(`${STORAGE_QUOTE} ${NO_EXPLANATION}`);
    expect(a.status).toBe('answered');
  });

  test('a phrase not in any field is unclear with the not-found text', () => {
    const a = composeExplainAnswer(input(), 'shake well before use', 'Mix it first.');
    expect(a).toEqual({
      status: 'unclear',
      text: PHRASE_NOT_FOUND_TEXT,
      spokenChunks: [PHRASE_NOT_FOUND_TEXT, FINAL_LINE],
      citedFields: [],
      safetyNotice: null,
    });
  });

  test('a phrase in a field that is not clear adds the uncertain sentence', () => {
    const label = labelOf([lf('storage', 'Store in a cool dry place.', 'partial')]);
    const a = composeExplainAnswer(input({ label }), PHRASE, null);
    expect(a.status).toBe('answered');
    expect(a.text).toBe(`${STORAGE_QUOTE} ${NO_EXPLANATION} ${UNCERTAIN}`);
    expect(a.spokenChunks).toEqual([STORAGE_QUOTE, NO_EXPLANATION, UNCERTAIN, FINAL_LINE]);
    expect(a.safetyNotice).toBe(UNCERTAIN);
  });

  test('a second hit that is not clear also adds the uncertain sentence', () => {
    const label = labelOf([
      lf('genericNames', 'Paracetamol'),
      lf('warnings', 'Contains paracetamol.', 'unreadable'),
    ]);
    const a = composeExplainAnswer(input({ label }), 'paracetamol', null);
    expect(a.text).toBe(
      `The generic name on the label says "Paracetamol". ${NO_EXPLANATION} ${UNCERTAIN}`,
    );
    expect(a.citedFields).toEqual(['genericNames', 'warnings']);
  });

  test('cites each field that prints the phrase once and quotes the first', () => {
    const label = labelOf([
      lf('genericNames', 'Paracetamol'),
      lf('warnings', 'Contains paracetamol.'),
      lf('directions', 'Paracetamol tablets.'),
    ]);
    const a = composeExplainAnswer(input({ label }), 'paracetamol', 'A medicine name.');
    expect(a.citedFields).toEqual(['genericNames', 'warnings', 'directions']);
    expect(a.text.startsWith('The generic name on the label says "Paracetamol".')).toBe(true);
  });

  // Task 7b review round 1: a fragment is never quoted without the rest of its
  // printed sentence, so a printed "Do not" can never be dropped.
  test('a fragment of a negated warning is quoted as its whole sentence, never inverted', () => {
    const phrase = 'with other products containing paracetamol';
    const a = composeExplainAnswer(
      input(),
      phrase,
      'You can use it together with other paracetamol products.',
    );
    const quote =
      'The warnings on the label says "Do not use with other products containing paracetamol".';
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a).toEqual({
      status: 'answered',
      text: `${quote} ${NO_EXPLANATION}`,
      spokenChunks: [quote, NO_EXPLANATION, FINAL_LINE],
      citedFields: ['warnings'],
      safetyNotice: null,
    });
  });

  test('a fragment is quoted as its whole printed sentence when the explanation passes too', () => {
    const a = composeExplainAnswer(
      input(),
      'cool dry place',
      'Keep it somewhere that is not hot or damp.',
    );
    expect(a.text).toBe(
      `${STORAGE_QUOTE} In plain words: Keep it somewhere that is not hot or damp.`,
    );
  });

  // Task 7b review round 2, finding 1, the reviewer's concrete failure: the
  // exact inversion of a printed overdose warning was spoken.
  test('the inversion of a printed warning is never spoken', () => {
    const a = composeExplainAnswer(
      input(),
      'other products containing paracetamol',
      'Use it with paracetamol products.',
    );
    const quote =
      'The warnings on the label says "Do not use with other products containing paracetamol".';
    expect(a).toEqual({
      status: 'answered',
      text: `${quote} ${NO_EXPLANATION}`,
      spokenChunks: [quote, NO_EXPLANATION, FINAL_LINE],
      citedFields: ['warnings'],
      safetyNotice: null,
    });
  });

  test.each(ROUND2_PROBE_CASES)('the round 2 probe (%s) %j is never spoken', (_kind, probe) => {
    const a = composeExplainAnswer(input(), PHRASE, probe);
    expect(a.text).toBe(`${STORAGE_QUOTE} ${NO_EXPLANATION}`);
  });

  // Task 7b review round 2, finding 2: the three layouts that dropped a
  // printed negation. The whole field is quoted and nothing is explained.
  test.each([
    [
      'Do not use with:\nAlcohol.\nOther products containing paracetamol.',
      'Do not use with: Alcohol. Other products containing paracetamol',
    ],
    [
      'DO NOT USE: With alcohol. With other products containing paracetamol.',
      'DO NOT USE: With alcohol. With other products containing paracetamol',
    ],
    [
      'Do not use if you have liver disease. Or with other products containing paracetamol.',
      'Do not use if you have liver disease. Or with other products containing paracetamol',
    ],
  ])('a negation printed before the phrase is quoted, never explained: %j', (warnings, printed) => {
    const label = labelOf([lf('warnings', warnings)]);
    const a = composeExplainAnswer(
      input({ label }),
      'other products containing paracetamol',
      'Use it with medicines containing paracetamol.',
    );
    const quote = `The warnings on the label says "${printed}".`;
    expect(a.text).toBe(`${quote} ${NO_EXPLANATION}`);
    expect(a.spokenChunks).toEqual([quote, NO_EXPLANATION, FINAL_LINE]);
  });

  test('a storage field with a printed negation is quoted whole and never explained', () => {
    const label = labelOf([lf('storage', 'Do not store:\nAbove 30 degrees.\nIn direct sunlight.')]);
    const a = composeExplainAnswer(
      input({ label }),
      'in direct sunlight',
      'Keep it away from heat.',
    );
    expect(a.text).toBe(
      `The storage on the label says "Do not store: Above 30 degrees. In direct sunlight". ${NO_EXPLANATION}`,
    );
  });

  test('an explanation off the printed topic is not spoken', () => {
    const a = composeExplainAnswer(
      input(),
      PHRASE,
      "It means you need a doctor's prescription to buy this.",
    );
    expect(a.text).toBe(`${STORAGE_QUOTE} ${NO_EXPLANATION}`);
  });

  test('a cited field the registry contradicts gets the conflict warning', () => {
    const label = labelOf([lf('strength', '500 mg tablet strength')]);
    const match: MatchAssessment = {
      ...MATCH,
      status: 'conflicting',
      conflicting: [{ key: 'strength', labelValue: '500 mg', referenceValue: '250 mg Tablet' }],
    };
    const a = composeExplainAnswer(input({ label, match }), 'tablet strength', null);
    const warning = conflictWarning('strength', '250 mg Tablet');
    // round 1: the fragment is quoted as its whole printed sentence (round 2: field)
    expect(a.text).toBe(
      `The strength on the label says "500 mg tablet strength". ${NO_EXPLANATION} ${warning}`,
    );
    expect(a.safetyNotice).toBe(warning);
    expect(a.spokenChunks.at(-1)).toBe(FINAL_LINE);
  });
});

describe('answerFromLabel', () => {
  const STATUSES: Exclude<MatchStatus, 'conflicting' | 'not_attempted'>[] = [
    'verified',
    'partial',
    'ambiguous',
    'no_match',
    'unavailable',
  ];

  test.each(STATUSES)('registry intent, %s: uses the spoken-summary status sentence', (status) => {
    const a = answerFromLabel(input({ intent: 'registry', match: { ...MATCH, status } }));
    expect(a.status).toBe('answered');
    expect(a.text).toBe(STATUS_SENTENCE[status]);
    expect(a.spokenChunks).toEqual([STATUS_SENTENCE[status], FINAL_LINE]);
    expect(a.citedFields).toEqual(['registrationNumber']);
  });

  test('registry intent, not_attempted: says the registry was not checked', () => {
    const match: MatchAssessment = { ...MATCH, status: 'not_attempted' };
    const a = answerFromLabel(input({ intent: 'registry', match }));
    expect(a.text).toBe('The FDA registry was not checked.');
  });

  test('registry intent, conflicting: names each conflicting field like the summary', () => {
    const match: MatchAssessment = {
      ...MATCH,
      status: 'conflicting',
      conflicting: [
        { key: 'strength', labelValue: '500 mg', referenceValue: '250 mg Tablet' },
        { key: 'brandName', labelValue: 'Paracelin 500', referenceValue: 'Paracelin 250' },
      ],
    };
    const a = answerFromLabel(input({ intent: 'registry', match }));
    expect(a.text).toBe(
      'The strength on the label does not match the registry. The brand name on the label does not match the registry.',
    );
  });

  test('registry intent with an advisory speaks ADVISORY_SENTENCE exactly', () => {
    const match: MatchAssessment = { ...MATCH, advisories: [ADVISORY] };
    const a = answerFromLabel(input({ intent: 'registry', match }));
    expect(a.text).toBe(`${STATUS_SENTENCE.verified} ${ADVISORY_SENTENCE}`);
    expect(a.text).not.toContain('advisory listed');
  });

  test.each(['read_label', 'strength', 'unclear_parts', 'other_label'] as const)(
    '%s intent does not speak advisories',
    (intent) => {
      const match: MatchAssessment = { ...MATCH, advisories: [ADVISORY] };
      const a = answerFromLabel(input({ intent, match }));
      expect(a.spokenChunks.join(' ')).not.toMatch(/advisory|counterfeit|fake/i);
    },
  );

  test('strength intent reads the printed strength', () => {
    const a = answerFromLabel(input({ intent: 'strength' }));
    expect(a.text).toBe('Strength as printed: 500 mg.');
    expect(a.citedFields).toEqual(['strength']);
  });

  test('unclear_parts names every unclear part but cites only fields with a value', () => {
    const label = labelOf([
      lf('brandName', 'Paracel', 'partial'),
      lf('strength', '500 mg'),
      lf('registrationNumber', null, 'unreadable'),
    ]);
    const a = answerFromLabel(input({ intent: 'unclear_parts', label }));
    expect(a.status).toBe('answered');
    expect(a.text).toBe(
      `These parts were not clear on the pack: brand name, registration number. ${UNCERTAIN}`,
    );
    expect(a.citedFields).toEqual(['brandName']);
  });

  test('unclear_parts with only unreadable empty fields cites nothing and is still answered', () => {
    const label = labelOf([lf('strength', '500 mg'), lf('registrationNumber', null, 'unreadable')]);
    const a = answerFromLabel(input({ intent: 'unclear_parts', label }));
    expect(AnswerSchema.safeParse(a).success).toBe(true);
    expect(a.status).toBe('answered');
    expect(a.text).toBe(
      `These parts were not clear on the pack: registration number. ${UNCERTAIN}`,
    );
    expect(a.citedFields).toEqual([]);
  });

  test('unclear_parts all clear still warns about a registry conflict', () => {
    const match: MatchAssessment = {
      ...MATCH,
      status: 'conflicting',
      conflicting: [{ key: 'strength', labelValue: '500 mg', referenceValue: '250 mg Tablet' }],
    };
    const a = answerFromLabel(input({ intent: 'unclear_parts', match }));
    const warning = conflictWarning('strength', '250 mg Tablet');
    expect(a.text).toBe(`Every part I read on this label was clear. ${warning}`);
    expect(a.safetyNotice).toBe(warning);
  });

  test('a label with nothing to read is unclear', () => {
    const a = answerFromLabel(input({ label: labelOf([lf('brandName', null, 'unreadable')]) }));
    expect(a).toEqual({
      status: 'unclear',
      text: 'I could not read that on this label.',
      spokenChunks: ['I could not read that on this label.', FINAL_LINE],
      citedFields: [],
      safetyNotice: null,
    });
  });

  test('a misspelled intent is a type error, not a silent fallback', () => {
    // @ts-expect-error 'strenght' is not an AllowedIntent
    const bad: AnswerInput = { label: LABEL, match: MATCH, question: 'Q?', intent: 'strenght' };
    expect(bad.intent).toBe('strenght');
  });
});
