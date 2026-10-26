import { QualityReportSchema } from '@medilens/contracts';
import { describe, expect, test } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../../src/config';
import { assessQuality } from '../../src/imaging/quality';
import { blurredJpeg, darkJpeg, glareJpeg, sharpJpeg } from '../helpers/images';

describe('DEFAULT_THRESHOLDS', () => {
  test('has the agreed starting values', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      minSharpness: 12,
      minLuminance: 40,
      maxLuminance: 235,
      maxGlare: 0.08,
    });
  });
});

describe('assessQuality', () => {
  test('a sharp, well-lit text-like pattern is ok', async () => {
    const report = await assessQuality(await sharpJpeg());
    expect(QualityReportSchema.parse(report)).toEqual(report);
    expect(report.reasons).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.sharpness).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.minSharpness);
    expect(report.glareFraction).toBeLessThan(DEFAULT_THRESHOLDS.maxGlare);
  });

  test('a blurred copy is BLURRY', async () => {
    const report = await assessQuality(await blurredJpeg());
    expect(report.reasons).toContain('BLURRY');
    expect(report.ok).toBe(false);
    expect(report.sharpness).toBeLessThan(DEFAULT_THRESHOLDS.minSharpness);
  });

  test('a dark copy is TOO_DARK', async () => {
    const report = await assessQuality(await darkJpeg());
    expect(report.reasons).toContain('TOO_DARK');
    expect(report.ok).toBe(false);
    expect(report.luminance).toBeLessThan(DEFAULT_THRESHOLDS.minLuminance);
  });

  test('a 30% white patch is GLARE', async () => {
    const report = await assessQuality(await glareJpeg());
    expect(report.reasons).toContain('GLARE');
    expect(report.ok).toBe(false);
    expect(report.glareFraction).toBeGreaterThan(0.25);
    expect(report.glareFraction).toBeLessThan(0.35);
  });

  test('accepts custom thresholds', async () => {
    const report = await assessQuality(await sharpJpeg(), {
      ...DEFAULT_THRESHOLDS,
      minSharpness: Number.MAX_SAFE_INTEGER,
    });
    expect(report.reasons).toEqual(['BLURRY']);
    expect(report.ok).toBe(false);
  });
});
