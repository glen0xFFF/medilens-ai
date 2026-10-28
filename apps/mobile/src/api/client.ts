/**
 * HTTP client for the MediLens server (spec §5.1). The app talks to nothing
 * else and holds no keys. Every response body is parsed with the shared
 * contracts schemas, so a server/app version drift surfaces as
 * INVALID_RESPONSE instead of a half-rendered result.
 */
import {
  AdvisorySchema,
  AnalysisResultSchema,
  AnswerSchema,
  DemoScenarioSummarySchema,
  ErrorBodySchema,
  ReferenceRecordSchema,
  type AnalysisResult,
  type Answer,
  type DemoScenarioSummary,
  type ErrorCode,
} from '@medilens/contracts';
import { z } from 'zod';

export const REQUEST_TIMEOUT_MS = 15_000;
/** A live scan reads the label with a model and checks the registry; it gets longer. */
export const ANALYZE_TIMEOUT_MS = 60_000;
export const MAX_IMAGES = 3;

export type ApiErrorCode = ErrorCode | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'CANCELLED';

/** Messages for failures the server never saw or could not describe. */
const CLIENT_MESSAGES = {
  NETWORK: "I couldn't reach the MediLens server. Check your connection and try again.",
  TIMEOUT: 'The server took too long to answer. Please try again.',
  CANCELLED: 'The request was stopped.',
  INVALID_RESPONSE: 'The server sent an answer this app cannot read. Please update the app.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
  VALIDATION_FAILED: 'Please choose 1 to 3 photos.',
} as const;

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** GET /health (served at the server root, not under /api/v1). */
export const HealthSchema = z.object({
  status: z.string(),
  version: z.string(),
  providerMode: z.enum(['live', 'demo']),
});
export type Health = z.infer<typeof HealthSchema>;

/** GET /api/v1/references/:id: the registry side of a stored analysis. */
export const ReferencesSchema = z.object({
  candidates: z.array(ReferenceRecordSchema),
  advisories: z.array(AdvisorySchema),
  limitations: z.array(z.string()),
  checkedAt: z.iso.datetime().nullable(),
});
export type References = z.infer<typeof ReferencesSchema>;

const ScenarioListSchema = z.array(DemoScenarioSummarySchema);
const PresetListSchema = z.array(z.string());

/** A photo already on the device (camera cache or picker), sent as a React Native file part. */
export interface UploadImage {
  uri: string;
  type: string;
  name?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Lets the caller stop a request, e.g. when the user leaves the screen that started it. */
export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ApiClient {
  health(): Promise<Health>;
  /** Rejects with CANCELLED, and never reaches the server, once `options.signal` aborts. */
  analyze(images: UploadImage[], options?: RequestOptions): Promise<AnalysisResult>;
  result(id: string): Promise<AnalysisResult>;
  scenario(scenarioId: string): Promise<AnalysisResult>;
  scenarios(): Promise<DemoScenarioSummary[]>;
  explain(id: string, question: string): Promise<Answer>;
  references(id: string): Promise<References>;
  presets(): Promise<string[]>;
}

function extensionFor(type: string): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

export function createApiClient(baseUrl: string, fetchImpl: FetchLike = fetch): ApiClient {
  const root = baseUrl.replace(/\/+$/, '');
  const api = `${root}/api/v1`;

  async function request<T>(
    url: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    caller?: AbortSignal,
  ): Promise<T> {
    const cancelledError = () => new ApiError('CANCELLED', CLIENT_MESSAGES.CANCELLED);
    if (caller?.aborted) throw cancelledError();
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => {
      cancelled = true;
      controller.abort();
    };
    caller?.addEventListener('abort', onCallerAbort);
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, { ...init, signal: controller.signal });
      } catch {
        if (cancelled) throw cancelledError();
        throw timedOut
          ? new ApiError('TIMEOUT', CLIENT_MESSAGES.TIMEOUT)
          : new ApiError('NETWORK', CLIENT_MESSAGES.NETWORK);
      }

      let body: unknown;
      let isJson = true;
      try {
        body = await res.json();
      } catch {
        if (cancelled) throw cancelledError();
        if (timedOut) throw new ApiError('TIMEOUT', CLIENT_MESSAGES.TIMEOUT);
        isJson = false;
      }
      if (cancelled) throw cancelledError();

      if (!res.ok) {
        const error = ErrorBodySchema.safeParse(body);
        if (isJson && error.success) {
          throw new ApiError(error.data.error.code, error.data.error.message);
        }
        throw new ApiError('INTERNAL_ERROR', CLIENT_MESSAGES.INTERNAL_ERROR);
      }

      const parsed = schema.safeParse(body);
      if (!isJson || !parsed.success) {
        throw new ApiError('INVALID_RESPONSE', CLIENT_MESSAGES.INVALID_RESPONSE);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  }

  function postJson<T>(url: string, schema: z.ZodType<T>, payload: unknown): Promise<T> {
    return request(url, schema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    health: () => request(`${root}/health`, HealthSchema),

    async analyze(images, options = {}) {
      if (images.length === 0 || images.length > MAX_IMAGES) {
        throw new ApiError('VALIDATION_FAILED', CLIENT_MESSAGES.VALIDATION_FAILED);
      }
      const form = new FormData();
      images.forEach((img, i) => {
        const file = {
          uri: img.uri,
          type: img.type,
          name: img.name ?? `photo-${i + 1}.${extensionFor(img.type)}`,
        };
        // React Native's FormData takes {uri, name, type} file objects; the DOM typing expects a Blob.
        form.append('images', file as unknown as Blob);
      });
      return request(
        `${api}/labels/analyze`,
        AnalysisResultSchema,
        { method: 'POST', headers: { Accept: 'application/json' }, body: form },
        ANALYZE_TIMEOUT_MS,
        options.signal,
      );
    },

    result: (resultId) => request(`${api}/labels/${id(resultId)}`, AnalysisResultSchema),

    scenario: (scenarioId) =>
      postJson(`${api}/demo/scenario`, AnalysisResultSchema, { scenarioId }),

    scenarios: () => request(`${api}/demo/scenarios`, ScenarioListSchema),

    explain: (resultId, question) =>
      postJson(`${api}/labels/${id(resultId)}/explain`, AnswerSchema, { question }),

    references: (resultId) => request(`${api}/references/${id(resultId)}`, ReferencesSchema),

    presets: () => request(`${api}/questions/presets`, PresetListSchema),
  };
}
