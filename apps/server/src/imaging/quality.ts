import type { QualityReason, QualityReport } from '@medilens/contracts';
import sharp from 'sharp';
import { DEFAULT_THRESHOLDS, MAX_IMAGE_PIXELS, type QualityThresholds } from '../config';

/** Greyscale level at or above which a pixel counts as glare. */
const GLARE_LEVEL = 250;

/**
 * Measures sharpness, mean luminance and glare on a normalised JPEG and maps
 * them to retake reasons. `ok` is true exactly when `reasons` is empty.
 *
 * All three metrics are computed on greyscale pixels. `stats()` reads the
 * pipeline *input* and ignores operations such as `.greyscale()`, so the grey
 * image is materialised first: luminance and glare come from one raw grey
 * decode, sharpness from `stats()` on an encoded grey buffer.
 *
 * Luminance above `maxLuminance` adds no reason code: the contract only has
 * BLURRY / TOO_DARK / GLARE, and an overexposed frame surfaces as GLARE via
 * `glareFraction` instead.
 */
export async function assessQuality(
  jpeg: Buffer,
  t: QualityThresholds = DEFAULT_THRESHOLDS,
): Promise<QualityReport> {
  const input = { limitInputPixels: MAX_IMAGE_PIXELS };
  const [raw, greyPng] = await Promise.all([
    sharp(jpeg, input).greyscale().raw().toBuffer({ resolveWithObject: true }),
    sharp(jpeg, input).greyscale().png({ compressionLevel: 0 }).toBuffer(),
  ]);

  const { sharpness } = await sharp(greyPng, input).stats();

  // Step by the reported channel count and read the first (grey) channel, in
  // case an alpha channel survives greyscale conversion.
  const { data, info } = raw;
  const channels = info.channels;
  const pixelCount = info.width * info.height;
  let sum = 0;
  let glarePixels = 0;
  for (let i = 0; i < data.length; i += channels) {
    const v = data[i] ?? 0;
    sum += v;
    if (v >= GLARE_LEVEL) glarePixels++;
  }
  const luminance = pixelCount === 0 ? 0 : sum / pixelCount;
  const glareFraction = pixelCount === 0 ? 0 : glarePixels / pixelCount;

  const reasons: QualityReason[] = [];
  if (sharpness < t.minSharpness) reasons.push('BLURRY');
  if (luminance < t.minLuminance) reasons.push('TOO_DARK');
  if (glareFraction > t.maxGlare) reasons.push('GLARE');

  return { ok: reasons.length === 0, sharpness, luminance, glareFraction, reasons };
}
