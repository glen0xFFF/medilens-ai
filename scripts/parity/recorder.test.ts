/**
 * The recorder wraps without changing behaviour, dedupes on fn + args, and
 * refuses a function that gives two results for the same args.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { flush, record, wrapModule } from './recorder';

let dir: string;
let saved: string | undefined;

beforeEach(() => {
  // keep anything the setup file buffered for this test file
  flush();
  saved = process.env.PARITY_RAW_DIR;
  dir = mkdtempSync(join(tmpdir(), 'parity-recorder-test-'));
  process.env.PARITY_RAW_DIR = dir;
});

afterEach(() => {
  flush();
  process.env.PARITY_RAW_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

function lines(corpus: string): string[] {
  const files = readdirSync(dir).filter((f) => f.startsWith(`${corpus}.`));
  return files.flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean));
}

describe('wrapModule', () => {
  const mod = {
    LIMIT: 3,
    WORDS: ['a'],
    double: (n: number) => n * 2,
    maybe: (s?: string) => (s === undefined ? null : s),
  };

  test('returns the original results and passes constants by reference', () => {
    const w = wrapModule('t', mod);
    expect(w.double(4)).toBe(8);
    expect(w.maybe()).toBeNull();
    expect(w.LIMIT).toBe(3);
    expect(w.WORDS).toBe(mod.WORDS);
  });

  test('records each call once, with undefined kept', () => {
    const w = wrapModule('t', mod);
    w.double(4);
    w.double(4);
    w.maybe(undefined);
    flush();
    expect(lines('t').sort()).toEqual([
      '{"fn":"double","args":[4],"result":8}',
      '{"fn":"maybe","args":[{"$undefined":true}],"result":null}',
    ]);
  });

  test('args are captured before the call mutates them', () => {
    const w = wrapModule('t', {
      grab: (xs: number[]) => {
        xs.push(9);
        return xs.length;
      },
    });
    w.grab([1]);
    flush();
    expect(lines('t')).toEqual(['{"fn":"grab","args":[[1]],"result":2}']);
  });

  test('a map callback records only the declared parameters, and still gets all of them', () => {
    const seen: number[] = [];
    const w = wrapModule('t', {
      lower: function (s: string) {
        seen.push(arguments.length);
        return s.toLowerCase();
      },
    });
    expect(['A', 'B'].map(w.lower)).toEqual(['a', 'b']);
    expect(seen).toEqual([3, 3]);
    flush();
    expect(lines('t').sort()).toEqual([
      '{"fn":"lower","args":["A"],"result":"a"}',
      '{"fn":"lower","args":["B"],"result":"b"}',
    ]);
  });

  test('a missing trailing argument is recorded as undefined', () => {
    const w = wrapModule('t', mod);
    expect(w.maybe()).toBeNull();
    flush();
    expect(lines('t')).toEqual(['{"fn":"maybe","args":[{"$undefined":true}],"result":null}']);
  });

  test('float noise in args is rounded to 10 significant digits, with the result of that exact call', () => {
    const calls: number[] = [];
    const w = wrapModule('t', {
      scale: (q: { s: number; n: number }) => {
        calls.push(q.s);
        return q.s * 1e12;
      },
    });
    expect(w.scale({ s: 0.20684154326135848, n: 3 })).toBe(0.20684154326135848 * 1e12);
    expect(w.scale({ s: 0.20684154326145532, n: 3 })).toBe(0.20684154326145532 * 1e12);
    // each test call, then one re-call with the rounded args
    expect(calls).toEqual([0.20684154326135848, 0.2068415433, 0.20684154326145532, 0.2068415433]);
    flush();
    expect(lines('t')).toEqual([
      `{"fn":"scale","args":[{"s":0.2068415433,"n":3}],"result":${0.2068415433 * 1e12}}`,
    ]);
  });

  test('integers and short decimals are recorded as they are, without a re-call', () => {
    let n = 0;
    const w = wrapModule('t', {
      id: (x: number[]) => {
        n++;
        return x;
      },
    });
    w.id([500, 0.5, 2.5, 1e21]);
    expect(n).toBe(1);
    flush();
    expect(lines('t')).toEqual([
      '{"fn":"id","args":[[500,0.5,2.5,1e+21]],"result":[500,0.5,2.5,1e+21]}',
    ]);
  });

  test('an async export is refused', () => {
    const w = wrapModule('t', { later: () => Promise.resolve(1) });
    expect(() => w.later()).toThrow(/async/);
  });
});

describe('record', () => {
  test('two different results for the same fn and args throw', () => {
    record('t', 'f', [1], 'a');
    expect(() => record('t', 'f', [1], 'b')).toThrow(/two results/);
  });
});
