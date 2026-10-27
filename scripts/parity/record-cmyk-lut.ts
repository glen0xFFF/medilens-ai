/**
 * Records sharp's CMYK to sRGB transform for the Go imaging port (task G5
 * review round 1).
 *
 *   npx tsx scripts/parity/record-cmyk-lut.ts   (after record-images.ts)
 *
 * sharp converts a CMYK image without an embedded profile to sRGB through
 * lcms, with libvips' built-in CMYK profile and the perceptual intent
 * (pipeline.cc: icc_transform("srgb", input_profile "cmyk")). For 8-bit
 * CMYK to 8-bit RGB, lcms precomputes a 17-node 4-D table of 16-bit values
 * (cmsReasonableGridpointsByColorspace: 17 for four channels) and
 * evaluates it with Eval4Inputs (cmsintrp.c): tetrahedral in M, Y, K on
 * the two C slices either side, then linear in C. The Go port evaluates
 * the same table the same way (internal/imaging/cmyk.go).
 *
 * No 8-bit input other than 0 and 255 sits on a node (node i is at
 * i * 255 / 16), and sharp's output is 8-bit, so the 16-bit node values
 * are recovered by least squares. sharp converts a fit set: every pixel of
 * each corner, edge and 2-D face of the CMYK cube (the inks not free are
 * 0 or 255, which covers plain K and no-ink colours, the commonest in
 * print), FACE3_SAMPLES seeded random pixels on each 3-D face and
 * FIT_SAMPLES in the interior. Each output is lcms' interpolation of 8
 * node values (with its fixed-point weights) rounded to 8 bits, and CGLS
 * solves for the nodes, starting from sharp's output at the inputs nearest
 * each node.
 *
 * Every pixel goes through sharp as an uncompressed 8-bit CMYK TIFF
 * (Photometric Separated, no profile). That is the same transform sharp
 * applies to a CMYK JPEG: the script checks it on every CMYK image of the
 * image parity set, byte for byte, and stops if it differs.
 *
 * Writes:
 * - internal/imaging/cmyk_srgb.lut: 17^4 RGB triples of little-endian
 *   uint16 (501,126 bytes), index ((c * 17 + m) * 17 + y) * 17 + k;
 * - fixtures/parity/cmyk/{pixels,faces}.{cmyk,srgb}: TEST_SAMPLES other
 *   seeded random CMYK pixels, in the interior and on the faces (each ink
 *   free, 0 or 255), and sharp's sRGB for each, which the Go test checks
 *   the table against;
 * - fixtures/parity/cmyk/versions.json: the sharp and libvips versions and
 *   the fit's residual.
 *
 * After the Node server is removed (task G12), re-recording needs
 * `git checkout node-fallback-v1` first (ruling R4).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NODES = 17;
const FIT_SAMPLES = 2_000_000;
const FACE3_SAMPLES = 250_000;
const TEST_SAMPLES = 20_000;
const ITERATIONS = 300;

/** An uncompressed, single-strip, 8-bit CMYK TIFF (Photometric Separated, InkSet CMYK). */
function cmykTiff(px: Buffer, width: number, height: number): Buffer {
  const BPS = -1;
  const STRIP = -2;
  // [tag, type (3 SHORT, 4 LONG), count, value]
  const entries: [number, number, number, number][] = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 4, BPS],
    [259, 3, 1, 1],
    [262, 3, 1, 5],
    [273, 4, 1, STRIP],
    [277, 3, 1, 4],
    [278, 4, 1, height],
    [279, 4, 1, px.length],
    [284, 3, 1, 1],
    [332, 3, 1, 1],
  ];
  const ifdOff = 8;
  const bpsOff = ifdOff + 2 + entries.length * 12 + 4;
  const stripOff = bpsOff + 8;
  const buf = Buffer.alloc(stripOff + px.length);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOff, 4);
  buf.writeUInt16LE(entries.length, ifdOff);
  entries.forEach(([tag, type, count, value], i) => {
    const o = ifdOff + 2 + i * 12;
    const v = value === BPS ? bpsOff : value === STRIP ? stripOff : value;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4);
    if (type === 3 && count === 1) buf.writeUInt16LE(v, o + 8);
    else buf.writeUInt32LE(v, o + 8);
  });
  for (let i = 0; i < 4; i++) buf.writeUInt16LE(8, bpsOff + i * 2);
  px.copy(buf, stripOff);
  return buf;
}

/** sharp's sRGB for each CMYK pixel of px (4 bytes each), 3 bytes each. */
async function toSRGB(px: Buffer): Promise<Buffer> {
  const n = px.length / 4;
  const width = 4096;
  const height = Math.ceil(n / width);
  const padded = Buffer.alloc(width * height * 4);
  px.copy(padded);
  const { data, info } = await sharp(cmykTiff(padded, width, height), { limitInputPixels: false })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`sharp returned ${info.channels} channels`);
  return data.subarray(0, n * 3);
}

/** sharp(jpeg).raw() equals the TIFF route on the JPEG's own decoded CMYK. */
async function checkSameTransform(file: string): Promise<void> {
  const jpeg = readFileSync(file);
  const cmyk = await sharp(jpeg)
    .pipelineColourspace('cmyk')
    .toColourspace('cmyk')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (cmyk.info.channels !== 4) throw new Error(`${file}: not CMYK`);
  const direct = await sharp(jpeg).raw().toBuffer();
  const viaTiff = await sharp(cmykTiff(cmyk.data, cmyk.info.width, cmyk.info.height)).raw().toBuffer();
  if (!direct.equals(viaTiff)) throw new Error(`${file}: the TIFF route differs from sharp's JPEG route`);
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  };
}

function randomPixels(n: number, seed: number): Buffer {
  const rand = lcg(seed);
  const px = Buffer.alloc(n * 4);
  for (let i = 0; i < px.length; i++) px[i] = rand();
  return px;
}

/** Random pixels on the faces: each ink free (1/2), 0 (1/3) or 255 (1/6). */
function facePixels(n: number, seed: number): Buffer {
  const rand = lcg(seed);
  const px = Buffer.alloc(n * 4);
  for (let i = 0; i < px.length; i++) {
    const pick = rand();
    px[i] = pick < 128 ? rand() : pick < 213 ? 0 : 255;
  }
  return px;
}

/**
 * The fit set: for each way of holding inks at 0 or 255 (the rest free),
 * every pixel when at most 2 inks are free, FACE3_SAMPLES random pixels
 * when 3 are, FIT_SAMPLES when all 4 are.
 */
function fitPixels(): Buffer {
  const parts: Buffer[] = [];
  const rand = lcg(20261030);
  for (let combo = 0; combo < 81; combo++) {
    const mode = [0, 1, 2, 3].map((i) => Math.floor(combo / 3 ** i) % 3); // 0 free, 1 at 0, 2 at 255
    const free = mode.filter((m) => m === 0).length;
    const n = free <= 2 ? 256 ** free : free === 3 ? FACE3_SAMPLES : FIT_SAMPLES;
    const px = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      let e = i;
      for (let ch = 0; ch < 4; ch++) {
        const m = mode[ch];
        let v: number;
        if (m === 1) v = 0;
        else if (m === 2) v = 255;
        else if (free <= 2) {
          v = e & 255;
          e >>= 8;
        } else v = rand();
        px[4 * i + ch] = v;
      }
    }
    parts.push(px);
  }
  return Buffer.concat(parts);
}

interface Located {
  node: number;
  rest: number;
  last: boolean;
}

/** lcms: an 8-bit input's node and 16.16 remainder (FROM_8_TO_16, then _cmsToFixedDomain). */
function locate(v8: number): Located {
  const v = v8 * 257;
  const a = v * (NODES - 1);
  const f = a + Math.trunc((a + 0x7fff) / 0xffff);
  return { node: f >> 16, rest: f & 0xffff, last: v === 0xffff };
}

const STRIDE_C = NODES ** 3;
const STRIDE_M = NODES ** 2;
const STRIDE_Y = NODES;

/**
 * The 8 node indices and weights Eval4Inputs combines for one pixel, at
 * idx/w[o..o+8): tetrahedral in M, Y, K (the case order of cmsintrp.c), on
 * the C slices below and above, mixed linearly in C.
 */
function weights(px: Buffer, i: number, idx: Int32Array, w: Float32Array, o: number): void {
  const lc = locate(px[4 * i] ?? 0);
  const lx = locate(px[4 * i + 1] ?? 0);
  const ly = locate(px[4 * i + 2] ?? 0);
  const lz = locate(px[4 * i + 3] ?? 0);
  const [rx, ry, rz, rc] = [lx.rest / 65536, ly.rest / 65536, lz.rest / 65536, lc.rest / 65536];
  const at = (dx: number, dy: number, dz: number) =>
    (lx.node + (lx.last ? 0 : dx)) * STRIDE_M + (ly.node + (ly.last ? 0 : dy)) * STRIDE_Y + lz.node + (lz.last ? 0 : dz);
  // [vertex, weight] x4: the case's c0 + c1*rx + c2*ry + c3*rz regrouped.
  let t: [number, number][];
  if (lx.rest >= ly.rest && ly.rest >= lz.rest) {
    t = [[at(0, 0, 0), 1 - rx], [at(1, 0, 0), rx - ry], [at(1, 1, 0), ry - rz], [at(1, 1, 1), rz]];
  } else if (lx.rest >= lz.rest && lz.rest >= ly.rest) {
    t = [[at(0, 0, 0), 1 - rx], [at(1, 0, 0), rx - rz], [at(1, 0, 1), rz - ry], [at(1, 1, 1), ry]];
  } else if (lz.rest >= lx.rest && lx.rest >= ly.rest) {
    t = [[at(0, 0, 0), 1 - rz], [at(0, 0, 1), rz - rx], [at(1, 0, 1), rx - ry], [at(1, 1, 1), ry]];
  } else if (ly.rest >= lx.rest && lx.rest >= lz.rest) {
    t = [[at(0, 0, 0), 1 - ry], [at(0, 1, 0), ry - rx], [at(1, 1, 0), rx - rz], [at(1, 1, 1), rz]];
  } else if (ly.rest >= lz.rest && lz.rest >= lx.rest) {
    t = [[at(0, 0, 0), 1 - ry], [at(0, 1, 0), ry - rz], [at(0, 1, 1), rz - rx], [at(1, 1, 1), rx]];
  } else {
    t = [[at(0, 0, 0), 1 - rz], [at(0, 0, 1), rz - ry], [at(0, 1, 1), ry - rx], [at(1, 1, 1), rx]];
  }
  const c0 = lc.node * STRIDE_C;
  const c1 = (lc.node + (lc.last ? 0 : 1)) * STRIDE_C;
  t.forEach(([vertex, wt], j) => {
    idx[o + j] = c0 + vertex;
    w[o + j] = wt * (1 - rc);
    idx[o + 4 + j] = c1 + vertex;
    w[o + 4 + j] = wt * rc;
  });
}

/**
 * CGLS for min |A x - b| on the three output channels at once (x and b
 * interleaved RGB), A given as 8 (index, weight) pairs per row. Returns
 * each channel's residual RMS.
 */
function cgls(idx: Int32Array, w: Float32Array, b: Float64Array, x: Float64Array): number[] {
  const rows = b.length / 3;
  const mul = (v: Float64Array, out: Float64Array) => {
    for (let i = 0; i < rows; i++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      for (let j = i * 8; j < i * 8 + 8; j++) {
        const wj = w[j] as number;
        const n = 3 * (idx[j] as number);
        s0 += wj * (v[n] as number);
        s1 += wj * (v[n + 1] as number);
        s2 += wj * (v[n + 2] as number);
      }
      out[3 * i] = s0;
      out[3 * i + 1] = s1;
      out[3 * i + 2] = s2;
    }
  };
  const mulT = (r: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let i = 0; i < rows; i++) {
      const r0 = r[3 * i] as number;
      const r1 = r[3 * i + 1] as number;
      const r2 = r[3 * i + 2] as number;
      for (let j = i * 8; j < i * 8 + 8; j++) {
        const wj = w[j] as number;
        const n = 3 * (idx[j] as number);
        out[n] = (out[n] as number) + wj * r0;
        out[n + 1] = (out[n + 1] as number) + wj * r1;
        out[n + 2] = (out[n + 2] as number) + wj * r2;
      }
    }
  };
  const dot = (a: Float64Array, c: Float64Array): number[] => {
    const s = [0, 0, 0];
    for (let i = 0; i < a.length; i += 3) {
      s[0] = (s[0] as number) + (a[i] as number) * (c[i] as number);
      s[1] = (s[1] as number) + (a[i + 1] as number) * (c[i + 1] as number);
      s[2] = (s[2] as number) + (a[i + 2] as number) * (c[i + 2] as number);
    }
    return s;
  };
  const r = new Float64Array(b.length);
  mul(x, r);
  for (let i = 0; i < r.length; i++) r[i] = (b[i] as number) - (r[i] as number);
  const s = new Float64Array(x.length);
  mulT(r, s);
  const p = Float64Array.from(s);
  const q = new Float64Array(b.length);
  let gamma = dot(s, s);
  for (let it = 0; it < ITERATIONS && gamma.some((g) => g > 0); it++) {
    mul(p, q);
    const qq = dot(q, q);
    const alpha = gamma.map((g, ch) => (g > 0 ? g / (qq[ch] as number) : 0));
    for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) + (alpha[i % 3] as number) * (p[i] as number);
    for (let i = 0; i < r.length; i++) r[i] = (r[i] as number) - (alpha[i % 3] as number) * (q[i] as number);
    mulT(r, s);
    const next = dot(s, s);
    const beta = next.map((g, ch) => ((gamma[ch] as number) > 0 ? g / (gamma[ch] as number) : 0));
    gamma = next;
    for (let i = 0; i < x.length; i++) p[i] = (s[i] as number) + (beta[i % 3] as number) * (p[i] as number);
  }
  return dot(r, r).map((v) => Number(Math.sqrt(v / rows).toFixed(2)));
}

async function main(): Promise<void> {
  const meta = await sharp(cmykTiff(Buffer.alloc(4), 1, 1)).metadata();
  if (meta.space !== 'cmyk') throw new Error(`the TIFF loads as ${meta.space}, not cmyk`);
  const images = path.join(ROOT, 'fixtures/parity/images');
  const cmykImages = readdirSync(images).filter((f) => f.includes('cmyk') && f.endsWith('.jpg'));
  if (cmykImages.length === 0) throw new Error('no CMYK parity images: run record-images.ts first');
  for (const f of cmykImages) await checkSameTransform(path.join(images, f));

  // Starting point: sharp's output at the 8-bit inputs nearest the nodes.
  const near = Array.from({ length: NODES }, (_, i) => Math.round((i * 255) / (NODES - 1)));
  const grid = Buffer.alloc(NODES ** 4 * 4);
  let p = 0;
  for (const c of near) for (const m of near) for (const y of near) for (const k of near) {
    grid[p++] = c;
    grid[p++] = m;
    grid[p++] = y;
    grid[p++] = k;
  }
  const start = await toSRGB(grid);

  const fit = fitPixels();
  const rows = fit.length / 4;
  // FROM_16_TO_8 rounds x / 257, so sharp's 8-bit v observes about v * 257.
  const b = Float64Array.from(await toSRGB(fit), (v) => v * 257);
  const idx = new Int32Array(rows * 8);
  const w = new Float32Array(rows * 8);
  for (let i = 0; i < rows; i++) weights(fit, i, idx, w, i * 8);
  const x = Float64Array.from(start, (v) => v * 257);
  const residuals = cgls(idx, w, b, x);
  const lut = Buffer.alloc(NODES ** 4 * 3 * 2);
  x.forEach((v, n) => lut.writeUInt16LE(Math.min(65535, Math.max(0, Math.round(v))), n * 2));
  writeFileSync(path.join(ROOT, 'internal/imaging/cmyk_srgb.lut'), lut);

  const dir = path.join(ROOT, 'fixtures/parity/cmyk');
  mkdirSync(dir, { recursive: true });
  for (const [name, test] of [
    ['pixels', randomPixels(TEST_SAMPLES, 20261029)],
    ['faces', facePixels(TEST_SAMPLES, 20261031)],
  ] as const) {
    writeFileSync(path.join(dir, `${name}.cmyk`), test);
    writeFileSync(path.join(dir, `${name}.srgb`), await toSRGB(test));
  }
  const info = {
    note: 'Recorded by scripts/parity/record-cmyk-lut.ts. Do not edit by hand.',
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
    nodes: NODES,
    fitSamples: rows,
    iterations: ITERATIONS,
    // RMS of (sharp's 8-bit output * 257 - the fitted table's 16-bit
    // value), per channel; 8-bit rounding alone gives 257 / sqrt(12) = 74.2.
    fitResidualRms: residuals,
  };
  writeFileSync(path.join(dir, 'versions.json'), `${JSON.stringify(info, null, 2)}\n`);
  console.log(`checked ${cmykImages.length} CMYK JPEGs; ${JSON.stringify(info)}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
