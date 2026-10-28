/**
 * Copies ada's IDNA tables for the Go URL host check (task G6 review round 1).
 *
 *   npx tsx scripts/parity/extract-ada-idna.ts <ada_idna.cpp>
 *
 * zod's z.httpUrl() checks the hostname Node's URL parser gives, and the
 * Node build's URL parser is ada (Node v24.21.0, process.versions.ada
 * 4.0.0). For a non-ASCII host, ada runs its own IDNA code
 * (ada::idna::to_ascii) over tables it ships as one raw DEFLATE blob
 * (src/table_blob.inc, packed by ada's scripts/pack_tables.py), inlined in
 * the single-file src/ada_idna.cpp of the release:
 * https://raw.githubusercontent.com/ada-url/ada/v4.0.0/src/ada_idna.cpp
 *
 * Give the script that file. It checks that the file is the v4.0.0 one
 * (sha256) and that this Node runs ada 4.0.0, that the blob has the
 * compressed size, inflated size and CRC32 ada records, that the layout
 * constants are the ones internal/contracts/ada_tables.go reads, and that
 * the ContextJ lists (src/validity.cpp) are the ones internal/contracts/
 * idna.go holds. It then writes the blob byte for byte to
 * internal/contracts/ada_idna_tables.deflate. No network.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'internal/contracts/ada_idna_tables.deflate');
const GO_IDNA = path.join(ROOT, 'internal/contracts/idna.go');

const ADA_VERSION = '4.0.0';
const ADA_IDNA_CPP_SHA256 = '0a222e97282aeb75c7956440d2b68acba59b0183301f1a644b80de4e09739b5d';

/* internal/contracts/ada_tables.go's layout constants, by ada's names. */
const LAYOUT: Record<string, number> = {
  compressed_size: 62377,
  uncompressed_size: 224608,
  decomposition_block_rows: 67,
  decomposition_block_cols: 257,
  ccc_block_rows: 67,
  ccc_block_cols: 256,
  composition_block_rows: 67,
  composition_block_cols: 257,
  dir_table_count: 1449,
  combining_range_count: 290,
  off_idna_stage1: 0,
  count_idna_stage1: 3282,
  off_idna_stage2: 6564,
  count_idna_stage2: 11456,
  off_idna_bool_blocks: 29480,
  count_idna_bool_blocks: 225,
  off_idna_utf8_mappings: 31280,
  count_idna_utf8_mappings: 17383,
  off_decomposition_index: 48663,
  count_decomposition_index: 4352,
  off_decomposition_block: 53016,
  count_decomposition_block: 17219,
  off_decomposition_data: 87456,
  count_decomposition_data: 9102,
  off_ccc_index: 123864,
  count_ccc_index: 4352,
  off_ccc_block: 128216,
  count_ccc_block: 17152,
  off_composition_index: 145368,
  count_composition_index: 4352,
  off_composition_block: 149720,
  count_composition_block: 17219,
  off_composition_data: 184160,
  count_composition_data: 1883,
  off_dir_start: 209244,
  count_dir_start: 1449,
  off_dir_final: 215040,
  count_dir_final: 1449,
  off_dir_value: 220836,
  count_dir_value: 1449,
  off_combining_flat: 222288,
  count_combining_flat: 580,
};
const CRC32 = 0x6f4a6b2e;

/* IDNA mapping constants (src/mapping_tables.cpp) that ada_tables.go copies. */
const MAPPING: Record<string, string> = {
  IDNA_LOW_RANGE_END: '0x00033480',
  IDNA_HIGH_IGNORED_START: '0x000E0100',
  IDNA_HIGH_IGNORED_END: '0x000E01F0',
  IDNA_VALID: '0xFFFF',
  IDNA_DISALLOWED: '0xFFFE',
  IDNA_BOOL_FLAG: '0x8000',
};

function fail(message: string): never {
  throw new Error(`extract-ada-idna: ${message}`);
}

function sizeConstant(src: string, name: string): number {
  const m = new RegExp(`constexpr size_t ${name} = ([0-9]+);`).exec(src);
  if (!m) fail(`no ${name} in the ada source`);
  return Number(m[1]);
}

function sortedList(text: string, name: string, open: string): number[] {
  const at = text.indexOf(open);
  if (at < 0) fail(`no ${name} list`);
  const body = text.slice(at + open.length, text.indexOf('}', at));
  return body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

function main(): void {
  const input = process.argv[2];
  if (!input) fail('usage: npx tsx scripts/parity/extract-ada-idna.ts <ada_idna.cpp>');
  if (process.versions.ada !== ADA_VERSION) {
    fail(`this Node runs ada ${process.versions.ada}, the Node build ran ada ${ADA_VERSION}`);
  }
  const bytes = readFileSync(input);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== ADA_IDNA_CPP_SHA256)
    fail(`${input} is not ada v${ADA_VERSION}'s ada_idna.cpp (sha256 ${sha})`);
  const src = bytes.toString('utf8');

  for (const [name, want] of Object.entries(LAYOUT)) {
    const got = sizeConstant(src, name);
    if (got !== want) fail(`${name} is ${got} in the ada source, ${want} in ada_tables.go`);
  }
  if (
    !src.includes(`constexpr uint32_t uncompressed_crc32 = 0x${CRC32.toString(16).toUpperCase()}u;`)
  ) {
    fail('uncompressed_crc32 differs');
  }
  for (const [name, want] of Object.entries(MAPPING)) {
    if (!new RegExp(`constexpr uint(16|32)_t ${name}\\s*= ${want};`).test(src))
      fail(`${name} is not ${want}`);
  }

  const open = 'alignas(8) inline constexpr uint8_t compressed[] = {';
  const start = src.indexOf(open);
  if (start < 0) fail('no compressed blob');
  const blob = Buffer.from(
    src
      .slice(start + open.length, src.indexOf('};', start))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
  if (blob.length !== LAYOUT.compressed_size) fail(`blob is ${blob.length} bytes`);
  const raw = inflateRawSync(blob);
  if (raw.length !== LAYOUT.uncompressed_size) fail(`blob inflates to ${raw.length} bytes`);
  if (crc32(raw) >>> 0 !== CRC32) fail('blob CRC32 differs');

  // The ContextJ lists live in code (is_label_valid), not in the blob.
  const validity = src.slice(src.indexOf('bool is_label_valid(const std::u32string_view label) {'));
  const goSrc = readFileSync(GO_IDNA, 'utf8');
  for (const [cpp, go] of [
    ['virama', 'adaVirama'],
    ['R', 'adaJoiningR'],
    ['L', 'adaJoiningL'],
    ['D', 'adaJoiningD'],
  ] as const) {
    const want = sortedList(validity, cpp, `constexpr static uint32_t ${cpp}[] = {`);
    const got = sortedList(goSrc, go, `var ${go} = []rune{`);
    if (want.join() !== got.join()) fail(`${go} in idna.go differs from ada's ${cpp}[]`);
  }

  writeFileSync(OUT, blob);
  console.log(
    `ada ${ADA_VERSION}: wrote ${path.relative(ROOT, OUT)} (${blob.length} bytes, inflates to ${raw.length}, CRC32 ${CRC32.toString(16)})`,
  );
}

main();
