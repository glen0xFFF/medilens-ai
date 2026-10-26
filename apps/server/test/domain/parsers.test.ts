import { describe, expect, test } from 'vitest';
import {
  normalizeName,
  normalizeRegistrationNumber,
  parseStrength,
  strengthsEqual,
} from '../../src/domain/parsers';

describe('parseStrength', () => {
  test.each([
    ['Paracetamol 500mg', [{ amount: 500, unit: 'mg' }]],
    ['500mg', [{ amount: 500, unit: 'mg' }]],
    ['500 mg', [{ amount: 500, unit: 'mg' }]],
    ['500 MG', [{ amount: 500, unit: 'mg' }]],
    ['1,000 mg', [{ amount: 1000, unit: 'mg' }]],
    ['1 g', [{ amount: 1, unit: 'g' }]],
    ['0.5%', [{ amount: 0.5, unit: '%' }]],
    ['400 IU', [{ amount: 400, unit: 'IU' }]],
    ['400 iu', [{ amount: 400, unit: 'IU' }]],
    ['500 µg', [{ amount: 500, unit: 'mcg' }]],
    ['500 μg', [{ amount: 500, unit: 'mcg' }]],
    ['500mcg', [{ amount: 500, unit: 'mcg' }]],
    ['60 ml', [{ amount: 60, unit: 'mL' }]],
    ['250 mg/5 mL', [{ amount: 250, unit: 'mg', per: { amount: 5, unit: 'mL' } }]],
    ['250mg / 5ml', [{ amount: 250, unit: 'mg', per: { amount: 5, unit: 'mL' } }]],
    ['50 mg/mL', [{ amount: 50, unit: 'mg', per: { amount: 1, unit: 'mL' } }]],
    [
      'Paracetamol 500mg + Caffeine 65mg',
      [
        { amount: 500, unit: 'mg' },
        { amount: 65, unit: 'mg' },
      ],
    ],
    [
      'Co-Amoxiclav 500mg/125mg',
      [
        { amount: 500, unit: 'mg' },
        { amount: 125, unit: 'mg' },
      ],
    ],
  ])('%s', (input, expected) => {
    expect(parseStrength(input)).toEqual(expected);
  });

  test.each([['abc'], [''], ['500'], ['Tablet'], ['500 gel'], ['Vitamin B12'], ['1,5 mg']])(
    '%s -> null',
    (input) => {
      expect(parseStrength(input)).toBeNull();
    },
  );

  describe('per as a word', () => {
    test.each([
      ['500 mg per 5 mL', [{ amount: 500, unit: 'mg', per: { amount: 5, unit: 'mL' } }]],
      ['500 mg PER 5 ml', [{ amount: 500, unit: 'mg', per: { amount: 5, unit: 'mL' } }]],
      ['50 mg per mL', [{ amount: 50, unit: 'mg', per: { amount: 1, unit: 'mL' } }]],
    ])('%s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });

    test('500 mg per 5 mL equals 500 mg/5 mL', () => {
      expect(strengthsEqual(parseStrength('500 mg per 5 mL'), parseStrength('500 mg/5 mL'))).toBe(
        true,
      );
    });
  });

  describe('unrecognised text is rejected, not dropped', () => {
    test.each([
      ['250 mg/tsp'],
      ['250 mg/5 cc'],
      ['2 mg/kg'],
      ['250 mg per tsp'],
      ['250 mg per 5 cc'],
      ['Potassium 500 mg + Magnesium 10 mmol'],
      ['500 mg + 10mmol'],
      ['500 mg + 5 mEq'],
      ['500 mg + 2 kg'],
    ])('%s -> null', (input) => {
      expect(parseStrength(input)).toBeNull();
    });

    test.each([
      ['250 mg/tsp', '250 mg'],
      ['250 mg/5 cc', '250 mg'],
      ['2 mg/kg', '2 mg'],
      ['Potassium 500 mg + Magnesium 10 mmol', '500 mg'],
    ])('strengthsEqual(%s, %s) is false', (a, b) => {
      expect(strengthsEqual(parseStrength(a), parseStrength(b))).toBe(false);
    });

    test.each([
      ['Paracetamol 500 mg 10 Tablets', [{ amount: 500, unit: 'mg' }]],
      ['Neozep 500 Forte 10 mg', [{ amount: 10, unit: 'mg' }]],
    ])('plain words and unitless numbers are not rejected: %s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });
  });

  describe('fails closed on unrecognised words after numbers', () => {
    test.each([
      ['Zinc 10 mg + Lactobacillus 5 billion CFU'],
      ['500 mg + 5 drams'],
      ['500 mg 2 in 1'],
    ])('%s -> null', (input) => {
      expect(parseStrength(input)).toBeNull();
    });

    test.each([
      ['Calcium 600 mg + Vitamin D 10 micrograms', '600 mg'],
      ['Amoxicillin 500 mg + Clavulanic acid 125 milligrams', '500 mg'],
      ['500 mg + 10 grams', '500 mg'],
      ['Zinc 10 mg + Lactobacillus 5 billion CFU', '10 mg'],
      ['1.000 mg', '1 mg'],
    ])('strengthsEqual(%s, %s) is false', (a, b) => {
      expect(strengthsEqual(parseStrength(a), parseStrength(b))).toBe(false);
    });

    test.each([
      ['Paracetamol 500 mg 10 tablets', [{ amount: 500, unit: 'mg' }]],
      ['500 mg, 10 x 10 capsules', [{ amount: 500, unit: 'mg' }]],
      ['500 mg 1 caplet each', [{ amount: 500, unit: 'mg' }]],
      ['10 sachets plus 2 sachet and 500 mg', [{ amount: 500, unit: 'mg' }]],
    ])('allowlisted words pass: %s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });
  });

  describe('every digit must be consumed by a recognised strength', () => {
    test.each([
      ['500 mg + 1.000.000 IU', '500 mg'],
      ['500 mg + 2.000.000 IU', '500 mg'],
      ['Paracetamol 500 mg + Caffeine 65-mg', '500 mg'],
      ['500 mg + 10 (mmol)', '500 mg'],
      ["500 mg + 10 'units'", '500 mg'],
      ['500 mg + 10 ㎎', '500 mg'],
      ['500 mg + 10 мг', '500 mg'],
      ['500 mg + 10 ｍｇ', '500 mg'],
      ['500 mg + .5 mmol', '500 mg'],
      ['500 mg + 10.5.3 mmol', '500 mg'],
      ['1 500 mg', '500 mg'],
      ['1 500 mg', '500 mg'],
      ['Calcium 600mg+Vitamin D400IU', '600 mg'],
    ])('%s is not equal to %s', (a, b) => {
      expect(strengthsEqual(parseStrength(a), parseStrength(b))).toBe(false);
    });

    test.each([
      ['500 mg + 1.000.000 IU'],
      ['2.000.000 IU'],
      ['Paracetamol 500 mg + Caffeine 65-mg'],
      ['500 mg + 10 (mmol)'],
      ["500 mg + 10 'units'"],
      ['500 mg + 10 мг'],
      ['500 mg + .5 mmol'],
      ['500 mg + 10.5.3 mmol'],
      ['1 500 mg'],
      ['1 500 mg'],
      ['Calcium 600mg+Vitamin D400IU'],
      ['Box of 100, 500 mg'],
    ])('%s -> null', (input) => {
      expect(parseStrength(input)).toBeNull();
    });

    test.each([
      // NFKC turns the ㎎ ligature and full-width ｍｇ into plain mg.
      [
        '500 mg + 10 ㎎',
        [
          { amount: 500, unit: 'mg' },
          { amount: 10, unit: 'mg' },
        ],
      ],
      [
        '500 mg + 10 ｍｇ',
        [
          { amount: 500, unit: 'mg' },
          { amount: 10, unit: 'mg' },
        ],
      ],
      ['Vitamin B12 500 mcg', [{ amount: 500, unit: 'mcg' }]],
      ['Vitamin D3 400 IU', [{ amount: 400, unit: 'IU' }]],
      [
        'Vitamin B1 100 mg + B6 5 mg + B12 50 mcg',
        [
          { amount: 100, unit: 'mg' },
          { amount: 5, unit: 'mg' },
          { amount: 50, unit: 'mcg' },
        ],
      ],
      ['500 mg 10x10', [{ amount: 500, unit: 'mg' }]],
      ['2 x 500 mg', [{ amount: 500, unit: 'mg' }]],
    ])('%s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });
  });

  describe('allowlisted patterns never consume a unit-bearing number', () => {
    // Each of these hides a second amount behind a pack grid, a count word,
    // a vitamin name or a non-ASCII digit. Null or "not equal" is required.
    test.each([
      // Pack grid glued to, or spaced from, a unit.
      ['Paracetamol 500 mg + Caffeine 1x65mg'],
      ['500 mg + 10x10mg'],
      ['500 mg + 2 x65mg'],
      ['500 mg + 10 X10 IU'],
      ['500 mg + 2x5 mmol'],
      ['500 mg + 10 x 10 mmol'],
      ['500 mg + 10X65MG'],
      ['500 mg + 10x65-mg'],
      ['500 mg + 2 x 65 (mg)'],
      ['500 mg + 10x10%'],
      ['500 mg + 10 x 10 μmol'],
      ['500 mg + 10 x 10 units'],
      ['500 mg + 10x10 x mg'],
      // Count word followed by a unit.
      ['500 mg + 65 x mg'],
      ['500 mg + 65 each mg'],
      ['500 mg + 65 X MG'],
      ['500 mg + 65 x %'],
      ['500 mg + 65 forte mg'],
      ['500 mg + 65 x tablets mg'],
      ['500 mg + 65 tablets x mg'],
      ['500 mg + 65 x and mg'],
      ['500 mg + mg65 x'],
      // Vitamin name followed by a unit.
      ['500 mg + B12 mg'],
      ['500 mg + B12%'],
      ['500 mg + D3 IU'],
      // Non-ASCII decimal digits.
      ['500 mg + ١٠ mg'],
      ['500 mg + ১০ mmol'],
      ['500 mg + ٦٥mg'],
      ['500 mg + १० mg'],
    ])('%s is null or not equal to 500 mg', (input) => {
      const parsed = parseStrength(input);
      expect(parsed === null || !strengthsEqual(parsed, parseStrength('500 mg'))).toBe(true);
    });

    test.each([
      ['0.5 mg', [{ amount: 0.5, unit: 'mg' }]],
      ['0.125 mg', [{ amount: 0.125, unit: 'mg' }]],
      ['1,000 mg', [{ amount: 1000, unit: 'mg' }]],
      ['Paracetamol 500 mg 10 tablets', [{ amount: 500, unit: 'mg' }]],
      ['B12 500 mcg', [{ amount: 500, unit: 'mcg' }]],
      [
        'Vitamin D3 1000 IU + 500 mg',
        [
          { amount: 1000, unit: 'IU' },
          { amount: 500, unit: 'mg' },
        ],
      ],
      ['500 mg 10 x 10 tablets', [{ amount: 500, unit: 'mg' }]],
      ['10 x 10 tablets 500 mg', [{ amount: 500, unit: 'mg' }]],
      ['Paracetamol 500 mg, 10 x 10 tablets', [{ amount: 500, unit: 'mg' }]],
      ['2 x 500 mg Paracetamol', [{ amount: 500, unit: 'mg' }]],
      ['Cholecalciferol (Vitamin D3) 400 IU', [{ amount: 400, unit: 'IU' }]],
    ])('still parses: %s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });

    test('an input cannot forge the internal strength marker', () => {
      const mark = String.fromCharCode(0xe000);
      expect(parseStrength(`500 mg + 65 x${mark}mg`)).toBeNull();
    });

    test('500 mg per 5 mL still equals 500 mg/5 mL', () => {
      expect(strengthsEqual(parseStrength('500 mg per 5 mL'), parseStrength('500 mg/5 mL'))).toBe(
        true,
      );
    });
  });

  describe('punctuation-joined numbers fail closed', () => {
    // Each input joins two numbers with punctuation that is neither a decimal
    // point nor a valid thousands comma. Reading only the tail would report
    // the misread amount on the right, so the whole parse must be null.
    test.each([
      // Decimal comma and other decimal marks next to a pack grid or count.
      ['Drug 2 x 0,5 mg', '5 mg'],
      ['2x0,5 mg', '5 mg'],
      ['10x0,5 mg', '5 mg'],
      ['10x2,5 mg', '5 mg'],
      ['1 x 2,5 mg', '5 mg'],
      ['10x0٫5 mg', '5 mg'],
      ['10x0·5 mg', '5 mg'],
      ['2 x 0 , 5 mg', '5 mg'],
      ['10 x 1 . 5 mg', '5 mg'],
      // Fractions and ranges.
      ['Drug 10x1/2 mg', '2 mg'],
      ['10x½ mg', '2 mg'],
      ['½ mg', '2 mg'],
      ['10x⅓ mg', '3 mg'],
      ['10x1⁄2 mg', '2 mg'],
      ['10x1-2 mg', '2 mg'],
      ['10x1–2 mg', '2 mg'],
      ['10x1—2 mg', '2 mg'],
      ['10 x 1 / 2 mg', '2 mg'],
      // Vitamin names joined to a number.
      ['Drug B12,5 mg', '5 mg'],
      ['Drug D3:5 mg', '5 mg'],
      ['Drug B12/5 mg', '5 mg'],
      ["Drug B1'2 mg", '2 mg'],
      ['Drug D3_5 mg', '5 mg'],
      // Other joiners between plain numbers.
      ["1'000 mg", '000 mg'],
      ['500 mg + 10:5 mg', '500 mg + 5 mg'],
      ['500 mg + 10_5 mg', '500 mg + 5 mg'],
      // A slash after an allowlisted count word is a ratio we do not understand.
      ['Drug 10 tablets/2 mg', '2 mg'],
      ['Drug 10 x 10 tablets / 2 mg', '2 mg'],
      // A thousands group cannot start with 0: these are decimal commas.
      ['0,500 mg', '500 mg'],
      ['0,125 mg', '125 mg'],
      ['2 x 0,500 mg', '500 mg'],
      // A symbol after an allowlisted match is unit-like.
      ['500 mg + 10 x 10 ℥', '500 mg'],
      ['500 mg + 10 tablets ℔', '500 mg'],
      ['500 mg + 2 x $', '500 mg'],
    ])('%s -> null (never equal to %s)', (input, misread) => {
      const parsed = parseStrength(input);
      expect(parsed).toBeNull();
      expect(strengthsEqual(parsed, parseStrength(misread))).toBe(false);
    });

    test.each([
      ['0.5 mg', [{ amount: 0.5, unit: 'mg' }]],
      ['0.125 mg', [{ amount: 0.125, unit: 'mg' }]],
      ['2.5 mg', [{ amount: 2.5, unit: 'mg' }]],
      ['1,000 mg', [{ amount: 1000, unit: 'mg' }]],
      ['12,500 IU', [{ amount: 12500, unit: 'IU' }]],
      ['Paracetamol 500 mg 10 tablets', [{ amount: 500, unit: 'mg' }]],
      ['250 mg/5 mL', [{ amount: 250, unit: 'mg', per: { amount: 5, unit: 'mL' } }]],
      ['B12 500 mcg', [{ amount: 500, unit: 'mcg' }]],
      [
        'Vitamin D3 1000 IU + 500 mg',
        [
          { amount: 1000, unit: 'IU' },
          { amount: 500, unit: 'mg' },
        ],
      ],
      ['10 x 10 tablets 500 mg', [{ amount: 500, unit: 'mg' }]],
      ['500 mg 10 x 10 tablets', [{ amount: 500, unit: 'mg' }]],
      [
        'Paracetamol 500 mg + Caffeine 65 mg',
        [
          { amount: 500, unit: 'mg' },
          { amount: 65, unit: 'mg' },
        ],
      ],
      [
        'Co-Amoxiclav 500mg/125mg',
        [
          { amount: 500, unit: 'mg' },
          { amount: 125, unit: 'mg' },
        ],
      ],
      ['2 x 0.5 mg', [{ amount: 0.5, unit: 'mg' }]],
      ['Paracetamol 500 mg, 10 x 10 tablets', [{ amount: 500, unit: 'mg' }]],
    ])('still parses: %s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });

    test('500 mg per 5 mL still equals 500 mg/5 mL', () => {
      expect(strengthsEqual(parseStrength('500 mg per 5 mL'), parseStrength('500 mg/5 mL'))).toBe(
        true,
      );
    });
  });

  describe('only whitespace or a glued decimal point may sit between digits', () => {
    // The joiner rule is an allowlist: any other non-letter character between
    // two numbers (or between a count word and the next number) fails closed,
    // so the tail is never read as the strength.
    test.each([
      ['10x1~2 mg', '2 mg'],
      ['10x1∶2 mg', '2 mg'],
      ['10x1→2 mg', '2 mg'],
      ['10x1•2 mg', '2 mg'],
      ['10x1*2 mg', '2 mg'],
      ['10x1×2 mg', '2 mg'],
      ['10x1=2 mg', '2 mg'],
      ['10x1`2 mg', '2 mg'],
      ['10x1"2 mg', '2 mg'],
      ['10x0。5 mg', '5 mg'],
      ['10x0、5 mg', '5 mg'],
      ['10x0‚5 mg', '5 mg'],
      ['10x0˙5 mg', '5 mg'],
      ['Drug B12~5 mg', '5 mg'],
      ['Drug 10 tablets ÷ 2 mg', '2 mg'],
      ['10x0​,5 mg', '5 mg'],
      // Extras: spaced joiners, a bracket opening between numbers, a joiner glued to the right.
      ['10x1 ~ 2 mg', '2 mg'],
      ['10 x 1 * 2 mg', '2 mg'],
      ['10x10 (2 mg)', '2 mg'],
      ['10x1 )2 mg', '2 mg'],
      ['Drug 10 tablets ~2 mg', '2 mg'],
      ['Drug B12 ÷ 5 mg', '5 mg'],
    ])('%s -> null (never equal to %s)', (input, misread) => {
      const parsed = parseStrength(input);
      expect(parsed).toBeNull();
      expect(strengthsEqual(parsed, parseStrength(misread))).toBe(false);
    });

    test.each([['500​ mg'], ['Para​cetamol 500 mg'], ['500 mg­'], ['﻿500 mg'], ['500 mg⁠']])(
      'any format character fails closed: %j',
      (input) => {
        expect(parseStrength(input)).toBeNull();
      },
    );

    test.each([
      ['0.5 mg', [{ amount: 0.5, unit: 'mg' }]],
      ['1,000.5 mg', [{ amount: 1000.5, unit: 'mg' }]],
      ['250 mg/5 mL', [{ amount: 250, unit: 'mg', per: { amount: 5, unit: 'mL' } }]],
      ['Cholecalciferol (Vitamin D3) 400 IU', [{ amount: 400, unit: 'IU' }]],
      [
        'Vitamin B1 100 mg + B6 5 mg',
        [
          { amount: 100, unit: 'mg' },
          { amount: 5, unit: 'mg' },
        ],
      ],
      ['10 x 10 tablets 500 mg', [{ amount: 500, unit: 'mg' }]],
      ['10 sachets plus 2 sachet and 500 mg', [{ amount: 500, unit: 'mg' }]],
    ])('still parses: %s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });
  });

  describe('spelled-out units', () => {
    test.each([
      ['10 micrograms', [{ amount: 10, unit: 'mcg' }]],
      ['1 microgram', [{ amount: 1, unit: 'mcg' }]],
      ['125 milligrams', [{ amount: 125, unit: 'mg' }]],
      ['1 milligram', [{ amount: 1, unit: 'mg' }]],
      ['10 grams', [{ amount: 10, unit: 'g' }]],
      ['1 Gram', [{ amount: 1, unit: 'g' }]],
      [
        'Amoxicillin 500 mg + Clavulanic acid 125 milligrams',
        [
          { amount: 500, unit: 'mg' },
          { amount: 125, unit: 'mg' },
        ],
      ],
      [
        'Calcium 600 mg + Vitamin D 10 micrograms',
        [
          { amount: 600, unit: 'mg' },
          { amount: 10, unit: 'mcg' },
        ],
      ],
    ])('%s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });

    test('125 milligrams equals 125 mg', () => {
      expect(strengthsEqual(parseStrength('125 milligrams'), parseStrength('125 mg'))).toBe(true);
    });
  });

  describe('dotted numbers', () => {
    test.each([['1.000 mg'], ['2.500 mg'], ['1.000.000 IU']])('%s -> null (ambiguous)', (input) => {
      expect(parseStrength(input)).toBeNull();
    });

    test.each([
      ['0.5 mg', [{ amount: 0.5, unit: 'mg' }]],
      ['2.5 mg', [{ amount: 2.5, unit: 'mg' }]],
      ['0.125 mg', [{ amount: 0.125, unit: 'mg' }]],
      ['1.25 mg', [{ amount: 1.25, unit: 'mg' }]],
    ])('real decimals still parse: %s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });
  });

  describe('thousands separators', () => {
    test.each([
      ['1,000 mg', [{ amount: 1000, unit: 'mg' }]],
      ['10,000 IU', [{ amount: 10000, unit: 'IU' }]],
      ['1,000,000 IU', [{ amount: 1000000, unit: 'IU' }]],
      ['1,000.5 mg', [{ amount: 1000.5, unit: 'mg' }]],
    ])('%s', (input, expected) => {
      expect(parseStrength(input)).toEqual(expected);
    });

    // A 3-digit leading group is indistinguishable from two merged strengths
    // (`500,125 mg`), so it is rejected rather than guessed.
    test.each([['500,125 mg'], ['125,000 IU'], ['1,00 mg'], ['1,0000 mg']])(
      '%s -> null',
      (input) => {
        expect(parseStrength(input)).toBeNull();
      },
    );
  });

  test('does not report a per for a plain strength', () => {
    expect(parseStrength('500mg')?.[0]).not.toHaveProperty('per');
  });
});

describe('strengthsEqual', () => {
  const eq = (a: string, b: string) => strengthsEqual(parseStrength(a), parseStrength(b));

  test.each([
    ['1 g', '1000mg'],
    ['1000mg', '1 g'],
    ['0.5 g', '500 mg'],
    ['1 mg', '1000 mcg'],
    ['500 µg', '0.5 mg'],
    ['500mg', '500 MG'],
    ['1,000 mg', '1 g'],
    ['250 mg/5 mL', '250mg/5ml'],
    ['Paracetamol 500mg + Caffeine 65mg', 'Caffeine 65 mg, Paracetamol 500 mg'],
    ['400 IU', '400 iu'],
    ['0.5%', '0.5 %'],
  ])('%s == %s', (a, b) => {
    expect(eq(a, b)).toBe(true);
  });

  test.each([
    ['500mg', '250mg'],
    ['500mg', '500mcg'],
    ['1 g', '1 mg'],
    ['250 mg/5 mL', '250 mg'],
    ['250 mg/5 mL', '250 mg/10 mL'],
    ['Paracetamol 500mg + Caffeine 65mg', 'Paracetamol 500mg'],
    ['500mg + 500mg', '500mg'],
    ['500mg + 500mg', '500mg + 250mg'],
    ['400 IU', '400 mg'],
    ['1%', '1 mg'],
    ['5 mL', '5 mg'],
  ])('%s != %s', (a, b) => {
    expect(eq(a, b)).toBe(false);
  });

  test('null on either side is never equal', () => {
    expect(strengthsEqual(null, parseStrength('500mg'))).toBe(false);
    expect(strengthsEqual(parseStrength('500mg'), null)).toBe(false);
    expect(strengthsEqual(null, null)).toBe(false);
  });
});

describe('normalizeRegistrationNumber', () => {
  test.each([
    [' dr-xy 39670', 'DR-XY39670'],
    ['DR-XY39670', 'DR-XY39670'],
    ['dr-12345', 'DR-12345'],
    ['DRP-1234', 'DRP-1234'],
    ['drhr-567', 'DRHR-567'],
    ['DR–XY39670', 'DR-XY39670'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeRegistrationNumber(input)).toBe(expected);
  });

  test.each([
    ['12345'],
    [''],
    ['DR-'],
    ['DR-XY'],
    ['XY-12345'],
    ['DR-AB12345'],
    ['DR-12345A'],
    ['FR-12345'],
  ])('%s -> null', (input) => {
    expect(normalizeRegistrationNumber(input)).toBeNull();
  });
});

describe('normalizeName', () => {
  test.each([
    ['Paracelin® 500 Tablet', 'paracelin 500'],
    ['Biogesic™', 'biogesic'],
    ['  Neozep   Forte  ', 'neozep forte'],
    ['Amoxil 500 Capsules', 'amoxil 500'],
    ['Ascof Lagundi Syrup', 'ascof lagundi'],
    ['Alaxan FR Film-Coated Tablets', 'alaxan fr'],
    ['Paracelin®500', 'paracelin 500'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });
});
