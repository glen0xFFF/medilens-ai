/**
 * Records the image parity set for the Go imaging port (task G5):
 * synthetic test images plus what the Node build's own imaging code
 * (apps/server/src/imaging, sharp 0.35.5 / libvips 8.18.7) says about them.
 *
 *   npx tsx scripts/parity/record-images.ts
 *
 * Writes fixtures/parity/images/<file> (every image is synthetic: text-like
 * block patterns, solid colours and gradients; no real medicine photo) and
 * fixtures/parity/images/reference.json, one entry per image:
 *
 * - `validate`: validateImage(bytes), exactly as returned;
 * - `assess`: assessQuality(bytes) on the image as uploaded, or null where
 *   that call is not a meaningful reference (see `assessOriginal` below);
 * - `normalized`: for an accepted image, normalizeImage(bytes) then
 *   assessQuality on that JPEG (what the pipeline measures), its size, and
 *   `grid`, the 4x4 block means of its greyscale decode, which pin where
 *   the pixels went (EXIF orientation, resize).
 *
 * plus `fit`: [width, height, outWidth, outHeight] for edge-case and
 * seeded input sizes through normalizeImage's resize options.
 *
 * The recipes reuse apps/server/test/helpers/images.ts where the Node tests
 * have one, so the parity images are the Node tests' images. Image bytes
 * are deterministic. Metric floats vary in the last digits between runs
 * (about 1e-13), so they are rounded to 10 significant digits; `ok` and
 * `reasons` come from the real report and are not recomputed. After the
 * Node server is removed (task G12), re-recording needs
 * `git checkout node-fallback-v1` first (ruling R4).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { QualityReport } from '@medilens/contracts';
import sharp, { type Sharp } from 'sharp';
import { DEFAULT_THRESHOLDS, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../../apps/server/src/config';
import { assessQuality } from '../../apps/server/src/imaging/quality';
import { normalizeImage, validateImage } from '../../apps/server/src/imaging/validate';
import * as h from '../../apps/server/test/helpers/images';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'fixtures/parity/images');

interface Source {
  file: string;
  recipe: string;
  make: () => Promise<Buffer>;
  /**
   * Whether assessQuality on the upload itself is recorded. The pipeline
   * only ever assesses the normalised 8-bit JPEG; the direct call is also
   * recorded for 8-bit images without alpha, which is what the Node tests
   * call it on. For a 16-bit or alpha image quality.ts reads raw bytes as
   * 8-bit grey samples, which is not a reference worth matching.
   */
  assessOriginal: boolean;
  /**
   * A decode probe: record `rgb`, sharp's raw RGB decode of the image
   * itself, which pins the JPEG decoder's chroma upsampling and colour
   * conversion pixel by pixel, image edges included (small images only),
   * and no `normalized` entry. The probes are 1-2 pixel runs of saturated
   * colour, where image/jpeg's q85 encoder and sharp's (libvips with
   * mozjpeg) quantise differently: up to 5 luma and 8 chroma levels a
   * pixel on patches-33x17-444.jpg, while Go decodes sharp's own output
   * exactly. That encoder gap is reported in the task G5 report (fix round
   * 1), not measured here.
   */
  recordRGB?: boolean;
}

/** Grey cells of distinct values, so a flip or a rotation moves every cell. */
function cellsPixels(width: number, height: number, cols: number, rows: number): Buffer {
  const px = Buffer.alloc(width * height);
  const cw = width / cols;
  const ch = height / rows;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = Math.floor(y / ch) * cols + Math.floor(x / cw);
      px[y * width + x] = 20 + cell * 14;
    }
  }
  return px;
}

/** A colour gradient with an XOR blue channel: mixed hues for the sRGB-to-grey conversion. */
function colourPixels(width: number, height: number): Buffer {
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      px[i] = Math.floor((x * 255) / (width - 1));
      px[i + 1] = Math.floor((y * 255) / (height - 1));
      px[i + 2] = (x ^ y) & 255;
    }
  }
  return px;
}

/**
 * Saturated and dark colours in short random runs: chroma edges everywhere,
 * so a 4:2:0 decode shows how the chroma is upsampled, edges included.
 */
function patchPixels(width: number, height: number): Buffer {
  const palette = [
    [200, 30, 30],
    [20, 20, 180],
    [10, 5, 0],
    [230, 230, 40],
    [40, 160, 60],
    [90, 90, 90],
    [250, 250, 250],
  ];
  let state = 7;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const px = Buffer.alloc(width * height * 3);
  let c = palette[0] ?? [0, 0, 0];
  for (let i = 0; i < width * height; i++) {
    if (rand() < 0.5) c = palette[Math.floor(rand() * palette.length)] ?? c;
    px.set(c, i * 3);
  }
  return px;
}

const patches = (width: number, height: number) =>
  sharp(patchPixels(width, height), { raw: { width, height, channels: 3 } });

const colour = () => sharp(colourPixels(320, 240), { raw: { width: 320, height: 240, channels: 3 } });

/**
 * The text-like pattern of the Node helper at a coarser block size: a light
 * paper with about 35% dark ink blocks, from the same seeded LCG. Large
 * images of it stay small on disk, and the blocks survive a 3x to 5x shrink.
 */
function blocksPixels(width: number, height: number, block: number): Buffer {
  let state = 42;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const px = Buffer.alloc(width * height, 215);
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      if (rand() >= 0.35) continue;
      for (let y = by; y < Math.min(by + block, height); y++) {
        px.fill(25, y * width + bx, y * width + Math.min(bx + block, width));
      }
    }
  }
  return px;
}

const blocks = (width: number, height: number, block: number) =>
  sharp(blocksPixels(width, height, block), { raw: { width, height, channels: 1 } });

/** blocks() as RGBA with alpha falling from 255 (left) to 64 (right). */
function blocksAlpha(width: number, height: number, block: number) {
  const grey = blocksPixels(width, height, block);
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = grey[i] ?? 0;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255 - Math.floor((((i % width) * 191) / (width - 1)));
  }
  return sharp(rgba, { raw: { width, height, channels: 4 } });
}

async function alphaPng(): Promise<Buffer> {
  // The sharp pattern as RGB, with alpha falling from 255 (left) to 0 (right).
  const { data, info } = await sharp(await h.sharpPng())
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(info.width * info.height * 4);
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * info.channels;
      const d = (y * info.width + x) * 4;
      rgba[d] = data[s] ?? 0;
      rgba[d + 1] = data[s + 1] ?? 0;
      rgba[d + 2] = data[s + 2] ?? 0;
      rgba[d + 3] = 255 - Math.floor((x * 255) / (info.width - 1));
    }
  }
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}

/** The top-left 400x300 of the Node helper's sharpPng() (cmyk.jpg's source). */
const cmykCrop = async () =>
  sharp(await sharp(await h.sharpPng()).extract({ left: 0, top: 0, width: 400, height: 300 }).toBuffer());

/** As sharp writes a CMYK JPEG (Adobe APP14, inverted, no ICC profile). */
const cmykOf = (img: Sharp) => img.toColourspace('cmyk').jpeg({ quality: 90 }).toBuffer();

const orientCells = (o: number) => () =>
  sharp(cellsPixels(96, 64, 4, 4), { raw: { width: 96, height: 64, channels: 1 } })
    .jpeg({ quality: 95 })
    .toBuffer()
    .then((b) => sharp(b).withMetadata({ orientation: o }).jpeg({ quality: 95 }).toBuffer());

const SOURCES: Source[] = [
  { file: 'sharp.jpg', recipe: 'helpers sharpJpeg()', make: () => h.sharpJpeg(), assessOriginal: true },
  { file: 'sharp.png', recipe: 'helpers sharpPng()', make: h.sharpPng, assessOriginal: true },
  { file: 'sharp.webp', recipe: 'helpers sharpWebp() (lossy VP8)', make: h.sharpWebp, assessOriginal: true },
  {
    file: 'sharp-lossless.webp',
    recipe: 'sharpPng() as lossless WebP (VP8L)',
    make: async () => sharp(await h.sharpPng()).webp({ lossless: true }).toBuffer(),
    assessOriginal: true,
  },
  { file: 'sharp.gif', recipe: 'helpers sharpGif()', make: h.sharpGif, assessOriginal: false },
  { file: 'blurred.jpg', recipe: 'helpers blurredJpeg()', make: h.blurredJpeg, assessOriginal: true },
  { file: 'dark.jpg', recipe: 'helpers darkJpeg()', make: h.darkJpeg, assessOriginal: true },
  { file: 'glare.jpg', recipe: 'helpers glareJpeg()', make: h.glareJpeg, assessOriginal: true },
  { file: 'blue.jpg', recipe: 'helpers solidRgbJpeg(0, 0, 255)', make: () => h.solidRgbJpeg(0, 0, 255), assessOriginal: true },
  { file: 'green.jpg', recipe: 'helpers solidRgbJpeg(0, 255, 0)', make: () => h.solidRgbJpeg(0, 255, 0), assessOriginal: true },
  { file: 'wide.jpg', recipe: 'helpers sharpJpeg(3000, 1000)', make: () => h.sharpJpeg(3000, 1000), assessOriginal: true },
  { file: 'tall.jpg', recipe: 'helpers sharpJpeg(600, 2400)', make: () => h.sharpJpeg(600, 2400), assessOriginal: true },
  {
    file: 'progressive.jpg',
    recipe: 'sharpPng() as progressive JPEG q90',
    make: async () => sharp(await h.sharpPng()).jpeg({ quality: 90, progressive: true }).toBuffer(),
    assessOriginal: true,
  },
  {
    file: 'cmyk.jpg',
    recipe: 'sharpPng() top-left 400x300, as CMYK JPEG q90',
    make: async () =>
      sharp(await sharp(await h.sharpPng()).extract({ left: 0, top: 0, width: 400, height: 300 }).toBuffer())
        .toColourspace('cmyk')
        .jpeg({ quality: 90 })
        .toBuffer(),
    assessOriginal: true,
  },
  // CMYK near the thresholds (task G5 review round 1): Go has to match
  // sharp's lcms transform where a metric decides the verdict, not just on
  // average. Contrast steps straddle minSharpness (12), darkness steps
  // straddle minLuminance (40).
  ...[0.62, 0.66, 0.68, 0.74].map(
    (a): Source => ({
      file: `cmyk-contrast-${a.toFixed(2).slice(2)}.jpg`,
      recipe: `cmyk.jpg's crop linear(${a}, ${((1 - a) * 140).toFixed(1)}), as CMYK JPEG q90`,
      make: async () => cmykOf((await cmykCrop()).linear(a, (1 - a) * 140)),
      assessOriginal: true,
    }),
  ),
  ...[0.3, 0.32, 0.34, 0.38].map(
    (a): Source => ({
      file: `cmyk-dark-${a.toFixed(2).slice(2)}.jpg`,
      recipe: `cmyk.jpg's crop linear(${a}, 0), as CMYK JPEG q90`,
      make: async () => cmykOf((await cmykCrop()).linear(a, 0)),
      assessOriginal: true,
    }),
  ),
  {
    file: 'large-shrink3-cmyk.jpg',
    recipe: 'blocks 6400x400 (8 px) as CMYK JPEG q90: shrink 3.125, CMYK loaded at 1/2',
    make: () => cmykOf(blocks(6400, 400, 8)),
    assessOriginal: false,
  },
  // JPEG decode edges (task G5 review round 1): odd and tiny sizes, where
  // libjpeg's fancy upsampling handles the first and last chroma column
  // and row specially, or falls back to replication (2 or fewer columns).
  ...([
    [1, 1],
    [2, 3],
    [3, 2],
    [5, 4],
    [7, 5],
    [9, 2],
    [33, 17],
  ] as const).map(
    ([w, hh]): Source => ({
      file: `patches-${w}x${hh}.jpg`,
      recipe: `${w}x${hh} saturated colour runs, JPEG q90 4:2:0`,
      make: () => patches(w, hh).jpeg({ quality: 90 }).toBuffer(),
      assessOriginal: true,
      recordRGB: true,
    }),
  ),
  {
    file: 'patches-33x17-444.jpg',
    recipe: '33x17 saturated colour runs, JPEG q90 4:4:4',
    make: () => patches(33, 17).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer(),
    assessOriginal: true,
    recordRGB: true,
  },
  { file: 'colour.png', recipe: '320x240 gradient, PNG', make: () => colour().png().toBuffer(), assessOriginal: true },
  {
    file: 'colour-p3.jpg',
    recipe: '320x240 gradient converted to and tagged with Display P3, JPEG q90',
    make: () => colour().withIccProfile('p3').jpeg({ quality: 90 }).toBuffer(),
    assessOriginal: true,
  },
  {
    file: 'sharp-p3.jpg',
    recipe: 'sharpPng() tagged with Display P3 (grey content), JPEG q90',
    make: async () => sharp(await h.sharpPng()).withIccProfile('p3').jpeg({ quality: 90 }).toBuffer(),
    assessOriginal: true,
  },
  { file: 'colour.jpg', recipe: '320x240 gradient, JPEG q90 4:2:0', make: () => colour().jpeg({ quality: 90 }).toBuffer(), assessOriginal: true },
  {
    file: 'colour-444.jpg',
    recipe: '320x240 gradient, JPEG q90 4:4:4',
    make: () => colour().jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer(),
    assessOriginal: true,
  },
  { file: 'alpha.png', recipe: 'sharp pattern RGBA, alpha 255 to 0 left to right', make: alphaPng, assessOriginal: false },
  {
    file: 'grey16.png',
    recipe: 'sharpPng() as 16-bit grey PNG',
    make: async () => sharp(await h.sharpPng()).toColourspace('grey16').png().toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'orient6.jpg',
    recipe: 'the Node test: sharpJpeg() withMetadata({orientation: 6}).jpeg()',
    make: async () => sharp(await h.sharpJpeg()).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    assessOriginal: true,
  },
  {
    file: 'orient6.png',
    recipe: 'sharpPng() withMetadata({orientation: 6}).png() (eXIf chunk)',
    make: async () => sharp(await h.sharpPng()).withMetadata({ orientation: 6 }).png().toBuffer(),
    assessOriginal: true,
  },
  {
    file: 'orient6.webp',
    recipe: 'sharpPng() withMetadata({orientation: 6}).webp() (VP8X EXIF chunk)',
    make: async () => sharp(await h.sharpPng()).withMetadata({ orientation: 6 }).webp().toBuffer(),
    assessOriginal: true,
  },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map(
    (o): Source => ({
      file: `cells-o${o}.jpg`,
      recipe: `96x64 grey 4x4 cells, JPEG q95, EXIF orientation ${o}`,
      make: orientCells(o),
      assessOriginal: true,
    }),
  ),
  // Large uploads, where sharp shrinks on load (pipeline.cc): JPEG by DCT
  // scaling once the shrink is 3 or more, WebP by libwebp's rescaler for any
  // shrink, and libvips' reduce box-shrinks first at a ratio of 4 or more.
  {
    file: 'large-shrink3.jpg',
    recipe: 'blocks 6400x400 (8 px), JPEG q90: shrink 3.125, loaded at 1/2',
    make: () => blocks(6400, 400, 8).jpeg({ quality: 90 }).toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'large-shrink5.jpg',
    recipe: 'blocks 10240x300 (8 px), JPEG q90: shrink 5, loaded at 1/4',
    make: () => blocks(10240, 300, 8).jpeg({ quality: 90 }).toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'large-shrink9.jpg',
    recipe: 'blocks 18432x200 (16 px), JPEG q90: shrink 9, loaded at 1/8',
    make: () => blocks(18432, 200, 16).jpeg({ quality: 90 }).toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'large-shrink5.png',
    recipe: 'blocks 10240x300 (8 px), PNG: shrink 5, box 2 then Lanczos3',
    make: () => blocks(10240, 300, 8).png().toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'large-2400.webp',
    recipe: 'helpers sharpJpeg(2400, 800) as lossy WebP: libwebp rescaler',
    make: async () => sharp(await h.sharpJpeg(2400, 800)).webp().toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'large-3000.webp',
    recipe: 'helpers sharpJpeg(3000, 1000) as lossy WebP: libwebp rescaler',
    make: async () => sharp(await h.sharpJpeg(3000, 1000)).webp().toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'large-alpha.webp',
    recipe: 'blocks 3000x600 (6 px) RGBA, lossy WebP with alpha: libwebp rescaler',
    make: () => blocksAlpha(3000, 600, 6).webp().toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'large-lossless.webp',
    recipe: 'blocks 3000x1000 (6 px), lossless WebP: libwebp rescaler',
    make: () => blocks(3000, 1000, 6).webp({ lossless: true }).toBuffer(),
    assessOriginal: false,
  },
  {
    file: 'tiny.jpg',
    recipe: '1x1 grey JPEG (no sample deviation: sharpness 0)',
    make: () => sharp({ create: { width: 1, height: 1, channels: 3, background: '#808080' } }).jpeg().toBuffer(),
    assessOriginal: true,
  },
  { file: 'huge.png', recipe: 'helpers hugeDimensionPng(7000)', make: () => h.hugeDimensionPng(7000), assessOriginal: false },
];

/** Rounds to 10 significant digits: run-to-run sharp float noise is about 1e-13. */
const r10 = (n: number) => (Number.isInteger(n) ? n : Number(n.toPrecision(10)));

function stable(q: QualityReport) {
  return {
    ok: q.ok,
    sharpness: r10(q.sharpness),
    luminance: r10(q.luminance),
    glareFraction: r10(q.glareFraction),
    reasons: q.reasons,
  };
}

/** 4x4 block means of the greyscale decode (block edges at floor(i*size/4)). */
async function grid(jpeg: Buffer): Promise<number[]> {
  const { data, info } = await sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  const out: number[] = [];
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x0 = Math.floor((gx * info.width) / 4);
      const x1 = Math.floor(((gx + 1) * info.width) / 4);
      const y0 = Math.floor((gy * info.height) / 4);
      const y1 = Math.floor(((gy + 1) * info.height) / 4);
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) sum += data[(y * info.width + x) * info.channels] ?? 0;
      }
      out.push(Number((sum / ((x1 - x0) * (y1 - y0))).toFixed(4)));
    }
  }
  return out;
}

/**
 * The output size of normalizeImage's resize step (same options, on a
 * blank image of each size, so no large image is encoded): edge cases
 * around half-pixel rounding plus a seeded sample.
 */
async function fitSizes(): Promise<[number, number, number, number][]> {
  const sizes: [number, number][] = [
    [800, 600], [2048, 2048], [2049, 2049], [3000, 1000], [1000, 3000], [4096, 1001],
    [1001, 4096], [4096, 1003], [4096, 1005], [2049, 1], [1, 2049], [2050, 1025],
    [2050, 1027], [4100, 2049], [8192, 3], [6000, 1001], [2049, 1023], [2049, 1025],
  ];
  let seed = 20261028;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < 200; i++) {
    const long = 2049 + Math.floor(rand() * 4000);
    const short = 1 + Math.floor(rand() * 3000);
    sizes.push(rand() < 0.5 ? [long, short] : [short, long]);
  }
  const out: [number, number, number, number][] = [];
  for (const [w, hgt] of sizes) {
    const { info } = await sharp({ create: { width: w, height: hgt, channels: 3, background: '#808080' } })
      .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    out.push([w, hgt, info.width, info.height]);
  }
  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const images = [];
  for (const src of SOURCES) {
    const bytes = await src.make();
    writeFileSync(path.join(OUT, src.file), bytes);
    const validate = await validateImage(bytes);
    let normalized = null;
    if (validate.ok && !src.recordRGB) {
      const norm = await normalizeImage(bytes);
      const meta = await sharp(norm).metadata();
      normalized = {
        width: meta.width,
        height: meta.height,
        channels: meta.channels,
        quality: stable(await assessQuality(norm)),
        grid: await grid(norm),
      };
    }
    const assess = validate.ok && src.assessOriginal ? stable(await assessQuality(bytes)) : null;
    const rgb = src.recordRGB ? { rgb: [...(await sharp(bytes).raw().toBuffer())] } : {};
    images.push({ file: src.file, recipe: src.recipe, bytes: bytes.length, validate, assess, normalized, ...rgb });
    console.log(`${src.file.padEnd(22)} ${String(bytes.length).padStart(7)} B  ${JSON.stringify(validate)}`);
  }
  const reference = {
    note: 'Recorded by scripts/parity/record-images.ts from apps/server/src/imaging. Do not edit by hand.',
    versions: { sharp: sharp.versions.sharp, vips: sharp.versions.vips },
    thresholds: DEFAULT_THRESHOLDS,
    maxImageBytes: MAX_IMAGE_BYTES,
    maxImagePixels: MAX_IMAGE_PIXELS,
    images,
    fit: await fitSizes(),
  };
  // One line per number array (grids, fit sizes), so the file stays readable.
  const text = JSON.stringify(reference, null, 2).replace(
    /\[\s*(-?[\d.e+-]+(?:,\s*-?[\d.e+-]+)*)\s*\]/g,
    (_m, inner: string) => `[${inner.split(/,\s*/).join(', ')}]`,
  );
  writeFileSync(path.join(OUT, 'reference.json'), `${text}\n`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
