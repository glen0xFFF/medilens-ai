/**
 * In-worker half of the parity recorder. `wrapModule` returns a copy of a
 * domain module whose exported functions record every call as
 * {fn, args, result}; everything else (constants, word lists) is passed
 * through by reference. Calls are buffered in memory, deduplicated on
 * fn + args, and written once per test file by `flush` (from setup.ts's
 * afterAll), so no test that watches the file system sees a write while it
 * runs. Wrapping never changes behaviour: the original function is called
 * with the original arguments and its own return value is returned.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeJson } from './encode';

/** One buffer per corpus file, keyed by fn + encoded args. */
const buffers = new Map<string, Map<string, string>>();

function rawDir(): string {
  const dir = process.env.PARITY_RAW_DIR;
  if (dir === undefined || dir === '') {
    throw new Error('parity recorder: PARITY_RAW_DIR is not set (run npm run parity:record)');
  }
  return dir;
}

/** Adds one case to `corpus`. Args and result must already be encoded JSON. */
export function recordEncoded(corpus: string, fn: string, args: string, result: string): void {
  let buf = buffers.get(corpus);
  if (buf === undefined) {
    buf = new Map();
    buffers.set(corpus, buf);
  }
  const key = `${fn}\u0000${args}`;
  const line = `{"fn":${JSON.stringify(fn)},"args":${args},"result":${result}}`;
  const seen = buf.get(key);
  if (seen !== undefined && seen !== line) {
    throw new Error(`parity recorder: ${fn} gave two results for the same args: ${args}`);
  }
  buf.set(key, line);
}

/** Adds one case, encoding args and result. */
export function record(corpus: string, fn: string, args: unknown[], result: unknown): void {
  recordEncoded(corpus, fn, encodeJson(args), encodeJson(result));
}

/** Significant digits kept for a non-integer number in recorded args. */
export const ARG_PRECISION = 10;

/**
 * A copy of `value` with every finite non-integer number rounded to
 * ARG_PRECISION significant digits, or `value` itself when nothing changes.
 * The image-quality floats sharp computes vary in the last digits from run to
 * run (about 1e-13) and reach buildSummary through the HTTP tests; rounding
 * keeps the corpus byte-stable across re-recordings.
 */
function canonical(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Number.isInteger(value)) return value;
    const r = Number(value.toPrecision(ARG_PRECISION));
    return r === value ? value : r;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = Array.from({ length: value.length }, (_, i) => {
      const v = canonical(value[i]);
      if (v !== value[i]) changed = true;
      return v;
    });
    return changed ? out : value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = canonical(v);
    if (out[k] !== v) changed = true;
  }
  return changed ? out : value;
}

export function wrapModule<T extends Record<string, unknown>>(corpus: string, mod: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value !== 'function') {
      out[name] = value;
      continue;
    }
    const original = value as (...a: unknown[]) => unknown;
    out[name] = function recorded(this: unknown, ...args: unknown[]): unknown {
      // Only the declared parameters are recorded: `xs.map(normalizeName)` also
      // passes (index, array), which the function ignores. No exported domain
      // function has default or rest parameters or reads `arguments`, so
      // `length` is its full parameter count; a missing trailing argument is
      // recorded as undefined, so every case has exactly that many args.
      // Encoded before the call, so a mutation inside the call cannot change
      // the record.
      const declared = Array.from({ length: original.length }, (_, i) => args[i]);
      const encodedArgs = encodeJson(declared);
      const result = original.apply(this, args);
      if (result instanceof Promise) {
        throw new Error(`parity recorder: ${name} is async; domain functions must be pure`);
      }
      const rounded = canonical(declared) as unknown[];
      if (rounded === declared) {
        recordEncoded(corpus, name, encodedArgs, encodeJson(result));
      } else {
        // The recorded case is a real call: the pure original, re-run on the
        // rounded args. The caller still gets the result of its own call.
        const again = original.apply(this, rounded);
        recordEncoded(corpus, name, encodeJson(rounded), encodeJson(again));
      }
      return result;
    };
  }
  return out as T;
}

/** Writes this test file's buffered cases, one raw file per corpus. */
export function flush(): void {
  if (buffers.size === 0) return;
  const dir = rawDir();
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  for (const [corpus, buf] of buffers) {
    if (buf.size === 0) continue;
    writeFileSync(join(dir, `${corpus}.${id}.jsonl`), [...buf.values()].join('\n') + '\n');
  }
  buffers.clear();
}
