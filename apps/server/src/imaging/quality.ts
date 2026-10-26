import type { QualityReason, QualityReport } from '@medilens/contracts';
import sharp from 'sharp';
import { DEFAULT_THRESHOLDS, type QualityThresholds } from '../config';

/** Greyscale level at or above which a pixel counts as glare. */
const GLARE_LEVEL = 250;

/**
 * Measures sharpness, mean luminance and glare on a normalised JPEG and maps
 * them to retake reasons. `ok` is true exactly when `reasons` is empty.
 *
 * Luminance above `maxLuminance` adds no reason code: the contract only has
 * BLURRY / TOO_DARK / GLARE, and an overexposed frame surfaces as GLARE via
 * `glareFraction` instead.
 */
export async function assessQuality(
  jpeg: Buffer,
  t: QualityThresholds = DEFAULT_THRESHOLDS,
): Promise<QualityReport> {
  const [stats, raw] = await Promise.all([
    sharp(jpeg).greyscale().stats(),
    sharp(jpeg).greyscale().raw().toBuffer({ resolveWithObject: true }),
  ]);

  const sharpness = stats.sharpness;
  const luminance = stats.channels[0]?.mean ?? 0;

  // Step by the reported channel count and read the first (grey) channel, in
  // case an alpha channel survives greyscale conversion.
  const { data, info } = raw;
  const channels = info.channels;
  const pixelCount = info.width * info.height;
  let glarePixels = 0;
  for (let i = 0; i < data.length; i += channels) {
    if ((data[i] ?? 0) >= GLARE_LEVEL) glarePixels++;
  }
  const glareFraction = pixelCount === 0 ? 0 : glarePixels / pixelCount;

  const reasons: QualityReason[] = [];
  if (sharpness < t.minSharpness) reasons.push('BLURRY');
  if (luminance < t.minLuminance) reasons.push('TOO_DARK');
  if (glareFraction > t.maxGlare) reasons.push('GLARE');

  return { ok: reasons.length === 0, sharpness, luminance, glareFraction, reasons };
}
