/**
 * The parity encoder (ruling R8): JSON with JS `undefined` kept as
 * {"$undefined":true} and non-finite numbers kept as {"$number":"..."}, so Go
 * tests can tell an absent value from null. Runs in the parity:record vitest
 * config, before anything is written.
 */
import { describe, expect, test } from 'vitest';
import { encode, encodeJson } from './encode';

describe('encode', () => {
  test('plain JSON values pass through', () => {
    expect(encode({ a: 1, b: 'x', c: [true, null], d: { e: 2.5 } })).toEqual({
      a: 1,
      b: 'x',
      c: [true, null],
      d: { e: 2.5 },
    });
  });

  test('undefined at the top level, in arrays and as a present property', () => {
    expect(encode(undefined)).toEqual({ $undefined: true });
    expect(encode([1, undefined])).toEqual([1, { $undefined: true }]);
    expect(encode({ a: undefined })).toEqual({ a: { $undefined: true } });
  });

  test('an absent property stays absent', () => {
    expect(encode({})).toEqual({});
    expect(Object.keys(encode({ a: 1 }) as object)).toEqual(['a']);
  });

  test('a sparse array hole is undefined', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(encode([1, , 3])).toEqual([1, { $undefined: true }, 3]);
  });

  test('non-finite numbers keep their value', () => {
    expect(encode([NaN, Infinity, -Infinity])).toEqual([
      { $number: 'NaN' },
      { $number: 'Infinity' },
      { $number: '-Infinity' },
    ]);
  });

  test('null is null, never undefined', () => {
    expect(encode(null)).toBeNull();
    expect(encode({ a: null })).toEqual({ a: null });
  });

  test('frozen arrays and objects encode', () => {
    expect(encode(Object.freeze(['storage']))).toEqual(['storage']);
  });

  test.each([
    ['a function', () => 1],
    ['a bigint', 1n],
    ['a symbol', Symbol('s')],
    ['a Map', new Map()],
    ['a Set', new Set()],
    ['a Date', new Date(0)],
    ['a RegExp', /x/],
    ['a Promise', Promise.resolve(1)],
    ['a reserved $undefined key', { $undefined: true }],
    ['a reserved $number key', { $number: 'NaN' }],
  ])('refuses %s instead of losing it', (_name, value) => {
    expect(() => encode(value)).toThrow(/parity encode/);
  });

  test('encodeJson is deterministic and keeps insertion order', () => {
    expect(encodeJson({ b: 1, a: [undefined] })).toBe('{"b":1,"a":[{"$undefined":true}]}');
  });
});
