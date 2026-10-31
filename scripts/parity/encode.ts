/**
 * Parity corpus encoding (Go port ruling R8). Plain JSON, except:
 *
 * - JS `undefined` (top level, array element, hole, or a property that is
 *   present with the value undefined) becomes {"$undefined":true}; an absent
 *   property stays absent.
 * - NaN and the infinities become {"$number":"NaN" | "Infinity" | "-Infinity"}.
 *
 * Anything JSON cannot carry faithfully (functions, bigints, symbols, Maps,
 * Sets, Dates, RegExps, Promises, class instances) throws, so a corpus never
 * silently loses a value. An object that already uses a reserved key throws
 * too, so a marker is never ambiguous.
 */

export type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };

const RESERVED = new Set(['$undefined', '$number']);

function fail(what: string): never {
  throw new Error(`parity encode: cannot encode ${what}`);
}

export function encode(value: unknown): Encoded {
  if (value === undefined) return { $undefined: true };
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      if (Number.isFinite(value)) return value;
      return { $number: Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity' };
    case 'object':
      break;
    default:
      return fail(typeof value);
  }
  if (Array.isArray(value)) {
    const out: Encoded[] = [];
    for (let i = 0; i < value.length; i++) out.push(encode(value[i]));
    return out;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return fail(`an instance of ${(value as object).constructor?.name ?? 'a class'}`);
  }
  const out: { [key: string]: Encoded } = {};
  for (const [k, v] of Object.entries(value)) {
    if (RESERVED.has(k)) fail(`an object with the reserved key ${k}`);
    out[k] = encode(v);
  }
  return out;
}

/** `encode`, serialised. Key order is insertion order, so it is deterministic. */
export function encodeJson(value: unknown): string {
  return JSON.stringify(encode(value));
}
