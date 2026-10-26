import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../../src/config';
import { normalizeImage, validateImage } from '../../src/imaging/validate';
import { hugeDimensionPng, sharpGif, sharpJpeg, sharpPng, sharpWebp } from '../helpers/images';

describe('validateImage', () => {
  test('MAX_IMAGE_BYTES is 8 MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  });

  test.each([
    ['jpeg', sharpJpeg],
    ['png', sharpPng],
    ['webp', sharpWebp],
  ] as const)('accepts %s', async (format, make) => {
    expect(await validateImage(await make())).toEqual({ ok: true, format });
  });

  test('rejects a 9 MB buffer as IMAGE_TOO_LARGE', async () => {
    const buf = Buffer.alloc(9 * 1024 * 1024);
    expect(await validateImage(buf)).toEqual({ ok: false, code: 'IMAGE_TOO_LARGE' });
  });

  test('checks size before format: a 9 MB buffer starting with a JPEG is still too large', async () => {
    const jpeg = await sharpJpeg();
    const buf = Buffer.concat([jpeg, Buffer.alloc(9 * 1024 * 1024 - jpeg.length)]);
    expect(await validateImage(buf)).toEqual({ ok: false, code: 'IMAGE_TOO_LARGE' });
  });

  test('rejects a truncated GIF header as INVALID_IMAGE', async () => {
    expect(await validateImage(Buffer.from('GIF89a…'))).toEqual({
      ok: false,
      code: 'INVALID_IMAGE',
    });
  });

  test('rejects a text file as INVALID_IMAGE', async () => {
    expect(await validateImage(Buffer.from('Paracetamol 500mg\nTake two tablets.\n'))).toEqual({
      ok: false,
      code: 'INVALID_IMAGE',
    });
  });

  test('rejects an empty buffer as INVALID_IMAGE', async () => {
    expect(await validateImage(Buffer.alloc(0))).toEqual({ ok: false, code: 'INVALID_IMAGE' });
  });

  test('MAX_IMAGE_PIXELS is 40 million', () => {
    expect(MAX_IMAGE_PIXELS).toBe(40_000_000);
  });

  test('rejects a small-byte PNG with huge dimensions as INVALID_IMAGE', async () => {
    const png = await hugeDimensionPng(7000);
    expect(png.length).toBeLessThan(MAX_IMAGE_BYTES);
    expect(await validateImage(png)).toEqual({ ok: false, code: 'INVALID_IMAGE' });
  });

  test('rejects a real GIF image as INVALID_IMAGE', async () => {
    const gif = await sharpGif();
    expect((await sharp(gif).metadata()).format).toBe('gif');
    expect(await validateImage(gif)).toEqual({ ok: false, code: 'INVALID_IMAGE' });
  });
});

describe('normalizeImage', () => {
  test('outputs JPEG and keeps a small image at its size', async () => {
    const out = await normalizeImage(await sharpPng());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect([meta.width, meta.height]).toEqual([800, 600]);
  });

  test('resizes a large image to fit inside 2048 keeping aspect ratio', async () => {
    const out = await normalizeImage(await sharpJpeg(3000, 1000));
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(2048);
    expect(meta.height).toBe(683);
  });

  test('applies EXIF orientation', async () => {
    const rotated = await sharp(await sharpJpeg())
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const meta = await sharp(await normalizeImage(rotated)).metadata();
    expect([meta.width, meta.height]).toEqual([600, 800]);
  });
});
