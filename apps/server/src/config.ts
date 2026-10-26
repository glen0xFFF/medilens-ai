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
