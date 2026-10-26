import sharp, { type Sharp } from 'sharp';

export const WIDTH = 800;
export const HEIGHT = 600;

const BLOCK = 4;
const INK = 25;
const PAPER = 215;

/** Deterministic LCG so the pattern is identical on every run. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Raw greyscale pixels of a text-like pattern: a light "paper" background
 * with ~35% dark 4x4 "ink" blocks. High-frequency edges everywhere, no
 * pixel reaches the glare level.
 */
function textLikePixels(width = WIDTH, height = HEIGHT): Buffer {
  const rand = lcg(42);
  const pixels = Buffer.alloc(width * height, PAPER);
  for (let by = 0; by < height; by += BLOCK) {
    for (let bx = 0; bx < width; bx += BLOCK) {
      if (rand() >= 0.35) continue;
      for (let y = by; y < Math.min(by + BLOCK, height); y++) {
        pixels.fill(INK, y * width + bx, y * width + Math.min(bx + BLOCK, width));
      }
    }
  }
  return pixels;
}

function textLike(width = WIDTH, height = HEIGHT): Sharp {
  return sharp(textLikePixels(width, height), { raw: { width, height, channels: 1 } });
}

export function sharpJpeg(width = WIDTH, height = HEIGHT): Promise<Buffer> {
  return textLike(width, height).jpeg({ quality: 90 }).toBuffer();
}

export function sharpPng(): Promise<Buffer> {
  return textLike().png().toBuffer();
}

export function sharpWebp(): Promise<Buffer> {
  return textLike().webp().toBuffer();
}

export function sharpGif(): Promise<Buffer> {
  return textLike().gif().toBuffer();
}

export function blurredJpeg(): Promise<Buffer> {
  return textLike().blur(8).jpeg({ quality: 90 }).toBuffer();
}

export function darkJpeg(): Promise<Buffer> {
  return textLike().linear(0.1).jpeg({ quality: 90 }).toBuffer();
}

/** Sharp pattern with a pure-white patch covering 30% of the frame. */
export async function glareJpeg(): Promise<Buffer> {
  const patchWidth = Math.round(WIDTH * 0.3);
  const patch = await sharp({
    create: { width: patchWidth, height: HEIGHT, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return textLike()
    .composite([{ input: patch, left: 0, top: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
