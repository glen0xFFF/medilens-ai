import { z } from 'zod';

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

/* ------------------------------------------------------------ environment */

/** Reported by GET /health; keep in step with apps/server/package.json. */
export const APP_VERSION = '0.1.0';

/** Used in the PH FDA User-Agent when PUBLIC_REPO_URL is not set. */
export const DEFAULT_REPO_URL = 'https://github.com/medilens-ai';

/** express-rate-limit window and per-IP request budget on /api/* (spec §5.1). */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const RATE_LIMIT_PER_WINDOW = 30;

/** Largest accepted JSON request body (explain question, demo scenario id). */
export const JSON_BODY_LIMIT = '16kb';

export type ProviderMode = 'demo' | 'live';

export interface AppConfig {
  port: number;
  providerMode: ProviderMode;
  /** Server-only secret; present (non-blank) whenever providerMode is live. */
  modelApiKey: string | undefined;
  dailySpendCapUsd: number;
  publicRepoUrl: string | undefined;
  corsOrigin: string | undefined;
}

/** `KEY=` in a .env file means "not set": blank values fall back to the default. */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema);

const EnvSchema = z
  .object({
    PORT: optional(z.coerce.number().int().min(1).max(65535).default(8787)),
    PROVIDER_MODE: optional(z.enum(['demo', 'live']).default('demo')),
    MODEL_API_KEY: optional(z.string().trim().optional()),
    DAILY_SPEND_CAP_USD: optional(z.coerce.number().finite().nonnegative().default(5)),
    PUBLIC_REPO_URL: optional(z.httpUrl().optional()),
    CORS_ORIGIN: optional(z.url({ protocol: /^https?$/ }).optional()),
  })
  .superRefine((env, ctx) => {
    if (env.PROVIDER_MODE === 'live' && env.MODEL_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['MODEL_API_KEY'],
        message: 'required when PROVIDER_MODE=live',
      });
    }
  });

/**
 * Validates the server environment (spec §4.2: live mode without a key fails
 * fast at startup). Throws an Error naming each invalid variable; the message
 * never contains a value, so a key can't leak into a startup log.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (i) => `${i.path.map(String).join('.') || 'env'}: ${i.message}`,
    );
    throw new Error(`Invalid server configuration. ${problems.join('; ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    providerMode: e.PROVIDER_MODE,
    modelApiKey: e.MODEL_API_KEY,
    dailySpendCapUsd: e.DAILY_SPEND_CAP_USD,
    publicRepoUrl: e.PUBLIC_REPO_URL,
    corsOrigin: e.CORS_ORIGIN,
  };
}

/** Honest User-Agent for PH FDA lookups (spec §3). */
export function userAgent(config: AppConfig): string {
  return `MediLensAI/0.1 (+${config.publicRepoUrl ?? DEFAULT_REPO_URL})`;
}
