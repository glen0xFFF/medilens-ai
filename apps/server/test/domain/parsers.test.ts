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
