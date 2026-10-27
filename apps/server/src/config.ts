/** Largest accepted upload, checked before any decoding. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface QualityThresholds {
  minSharpness: number;
  minLuminance: number;
  maxLuminance: number;
  maxGlare: number;
}

/** Starting values; calibrate against real label photos later. */
export const DEFAULT_THRESHOLDS: QualityThresholds = {
  minSharpness: 12,
  minLuminance: 40,
  maxLuminance: 235,
  maxGlare: 0.08,
};

/**
 * Largest accepted decoded size in pixels. Guards against decompression
 * bombs: a solid 16000x16000 PNG is under 1 MB on disk but ~768 MB decoded.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** How long an analysis result stays retrievable for follow-up calls (15 min, memory only). */
export const RESULT_TTL_MS = 15 * 60 * 1000;
