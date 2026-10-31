/**
 * Records how Node parses a .env file, for the Go .env loader (task G8):
 *
 *   npx tsx scripts/parity/record-dotenv.ts
 *
 * Writes fixtures/parity/dotenv/node-parse-env.jsonl, one corpus-format
 * line per .env file content:
 *
 *   {"fn":"util.parseEnv","args":[content],"result":{KEY: value, ...}}
 *
 * `util.parseEnv` is the parser behind `process.loadEnvFile`, which the Node
 * server called on the repository-root .env (apps/server/src/rootEnv.ts);
 * loadEnvFile then sets each key that is not already in the environment. A
 * "" key (from a line such as "=") is left out of `result`, because no
 * environment variable can have an empty name.
 *
 * The contents are the hand-picked cases below, then 3000 random files over
 * a small alphabet of keys, =, quotes, #, backslash, n, spaces, tabs,
 * newlines, CRLF and "export ", from a fixed seed, so recording is
 * deterministic for one Node version. Recorded with Node v24.21.0. Nothing
 * touches the network or the file system except the output file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { encodeJson } from './encode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'fixtures/parity/dotenv');

const B = String.fromCharCode(92); // backslash
const N = '\n';
const T = '\t';
const CR = '\r';
const VT = String.fromCharCode(11);
const FF = String.fromCharCode(12);
const NBSP = String.fromCharCode(0xa0);
const BOM = String.fromCharCode(0xfeff);

const HAND_PICKED: string[] = [
  'A=plain' + N,
  'A=plain',
  'A=' + N + 'B=x' + N,
  'A=',
  'A' + N + 'B=x' + N,
  'A=x # c' + N,
  'A=has#hash' + N,
  'A=#x' + N,
  'A="dq" # c' + N,
  'A="#notcomment"' + N,
  "A='#nc' # c" + N,
  'A=`#nc` # c' + N,
  'A="a' + B + 'nb"' + N,
  "A='a" + B + "nb'" + N,
  'A=`a' + B + 'nb`' + N,
  'A=a' + B + 'nb' + N,
  'A="a' + B + '"b"' + N,
  'A="a' + B + B + 'nb"' + N,
  'A="a' + B + 'tb"' + N,
  'A="l1' + N + 'l2"' + N + 'B=x' + N,
  "A='l1" + N + "l2'" + N + 'B=x' + N,
  'A=`l1' + N + 'l2`' + N + 'B=x' + N,
  'A="abc' + N + 'B=x' + N,
  "A='abc" + N + 'B=x' + N,
  'A=`x' + N + 'B=y' + N,
  'A="abc',
  "A='abc",
  'A="x' + N + 'B="y"' + N + 'C=z' + N,
  'A="a"b' + N + 'B=x' + N,
  'A="  a  "' + N,
  'A="q"   ' + N + 'B=x' + N,
  'A="q"' + N + '  #C=1' + N + 'B=y' + N,
  'A= "q"' + N,
  'A=""' + N,
  "A=''" + N,
  "A='" + N,
  'A="a=b"' + N,
  'A=a"b' + N,
  '  A  =  v  ' + N,
  T + 'A' + T + '=' + T + 'v' + T + N,
  'export A=e' + N,
  'export   A=e' + N,
  'exportA=e' + N,
  'export' + T + 'A=e' + N,
  'export =v' + N + 'B=x' + N,
  'export A=' + N + 'B=x' + N,
  'A==eq' + N,
  '=v' + N + 'B=x' + N,
  '=A=1' + N,
  '   =v' + N + 'B=x' + N,
  '  # C=1' + N + 'B=x' + N,
  '#A=1' + N + 'B=2',
  'A=x' + N + '   #C=1' + N + 'B=y' + N,
  'A=   # c' + N + 'B=x' + N,
  'A=1' + N + 'A=2' + N,
  'A=crlf' + CR + N + 'B="q"' + CR + N,
  'A=a' + CR + 'b' + N,
  'A=' + CR + N + 'B=x' + N,
  'Z A=1' + N,
  '"A"=v' + N,
  VT + 'A=v' + N,
  'A=abc$HOME' + N,
  'A=${HOME}' + N,
  'A=' + NBSP + 'v' + NBSP + N,
  'A=' + VT + 'v' + VT + N,
  'A=' + FF + 'v' + FF + N,
  N + N + '  ' + N + 'A=1' + N,
  'A=1' + N + '   ' + N + 'B=2' + N,
  N + N,
  BOM + 'A=1' + N,
  'A=   ',
  'A ' + N + 'B=x' + N,
  // a value of only spaces or tabs: Node reads the next line as the value
  'A=   ' + N + 'B=x' + N,
  'A=' + T + N + 'B=x' + N,
  'MODEL_API_KEY=   ' + N + 'MODEL_PROVIDER=muse_spark' + N,
];

const ALPHABET = [
  'A',
  'B',
  'C',
  '=',
  '=',
  ' ',
  '  ',
  T,
  N,
  N,
  N,
  '#',
  '"',
  "'",
  '`',
  B,
  'n',
  'x',
  'export ',
  'v',
  CR + N,
];

/** A fixed-seed 32-bit generator (mulberry32), exact in JS integer arithmetic. */
function generator(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function randomFiles(count: number): string[] {
  const next = generator(20261028);
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    const length = 1 + next(24);
    for (let j = 0; j < length; j++) s += ALPHABET[next(ALPHABET.length)];
    files.push(s);
  }
  return files;
}

function main(): void {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const content of [...HAND_PICKED, ...randomFiles(3000)]) {
    if (seen.has(content)) continue;
    seen.add(content);
    const parsed = parseEnv(content);
    const result: Record<string, string> = {};
    for (const key of Object.keys(parsed).sort()) {
      const value = parsed[key];
      if (key !== '' && value !== undefined) result[key] = value;
    }
    lines.push(encodeJson({ fn: 'util.parseEnv', args: [content], result }));
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'node-parse-env.jsonl'), lines.join('\n') + '\n');
  console.log(
    `dotenv: ${lines.length} files (${HAND_PICKED.length} hand-picked), node ${process.version}`,
  );
}

main();
