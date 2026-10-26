import type { ErrorCode } from '@medilens/contracts';
import sharp from 'sharp';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from '../config';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export type ValidationResult =
  | { ok: true; format: ImageFormat }
  | { ok: false; code: Extract<ErrorCode, 'INVALID_IMAGE' | 'IMAGE_TOO_LARGE'> };

const ACCEPTED_FORMATS: ReadonlySet<string> = new Set<ImageFormat>(['jpeg', 'png', 'webp']);

function isAcceptedFormat(format: string | undefined): format is ImageFormat {
  return format !== undefined && ACCEPTED_FORMATS.has(format);
}

/**
 * Checks byte size first (no decoding of oversized uploads), then reads the
 * header via sharp's metadata. Anything sharp cannot parse, a format outside
 * JPEG/PNG/WebP, or missing or excessive dimensions (decompression-bomb
 * guard, `MAX_IMAGE_PIXELS`) is INVALID_IMAGE.
 */
export async function validateImage(buf: Buffer): Promise<ValidationResult> {
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, code: 'IMAGE_TOO_LARGE' };
  try {
    const { format, width, height } = await sharp(buf, {
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
    const withinPixelLimit = width > 0 && height > 0 && width * height <= MAX_IMAGE_PIXELS;
    if (isAcceptedFormat(format) && withinPixelLimit) return { ok: true, format };
  } catch {
    // Fall through: unparseable input is an invalid image.
  }
  return { ok: false, code: 'INVALID_IMAGE' };
}

/** Applies EXIF orientation, fits inside 2048x2048 without enlarging, re-encodes as JPEG q85. */
export function normalizeImage(buf: Buffer): Promise<Buffer> {
  return sharp(buf, { limitInputPixels: MAX_IMAGE_PIXELS })
    .rotate()
    .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}
