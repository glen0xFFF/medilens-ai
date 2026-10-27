/**
 * HTTP client for the MediLens Go API (Go port spec §4, §7). The app talks
 * to nothing else and holds no keys. Every response body is parsed with the
 * shared contracts schemas, so a server/app version drift surfaces as
 * INVALID_RESPONSE instead of a half-rendered result.
 *
 * A scan or a demo scenario is asynchronous on the server: POST creates the
 * analysis (202 {id}), GET /analyses/{id} is polled every 750 ms for its
 * progress stages, then GET /analyses/{id}/result fetches the result. The
 * server also streams the stages over SSE; the app polls instead, because
 * React Native EventSource / fetch streaming was not verified (spec §7).
 */
import {
  AnalysisCreatedSchema,
  AnalysisReferencesSchema,
  AnalysisResultSchema,
  AnalysisStatusSchema,
  AnswerSchema,
  ApiErrorBodySchema,
  CapabilitiesSchema,
  DemoScenarioListSchema,
  PresetQuestionsSchema,
  type AnalysisEvent,
  type AnalysisReferences,
  type AnalysisResult,
  type Answer,
  type ApiErrorCode as ServerErrorCode,
  type Capabilities,
  type DemoScenarioSummary,
} from '@medilens/contracts';
import type { z } from 'zod';

export const REQUEST_TIMEOUT_MS = 15_000;
/** Sending up to 3 photos over a phone connection gets longer than an ordinary request. */
export const ANALYZE_TIMEOUT_MS = 60_000;
export const MAX_IMAGES = 3;
/** How often a running analysis is polled; the server's read bucket allows it (spec §7). */
export const POLL_INTERVAL_MS = 750;
/**
 * Final review I1: a live read is 40 to 120 polls, so a poll that fails for
 * a passing reason (NETWORK, TIMEOUT, a 429, a 5xx page that is not the
 * API's own error) is retried, up to this many times in a row; the count
 * starts again after any poll that gets an answer.
 */
export const POLL_MAX_RETRIES = 3;
/** The longest wait before a retried poll, whatever the server's Retry-After says. */
export const POLL_RETRY_MAX_WAIT_MS = 30_000;

/** The wait before retry number `failures` (1-based): 1.5 s, 3 s, 6 s, or the server's Retry-After if longer. */
function retryWaitMs(failures: number, retryAfterMs: number | undefined): number {
  const backoff = POLL_INTERVAL_MS * 2 ** failures;
  return Math.min(Math.max(backoff, retryAfterMs ?? 0), POLL_RETRY_MAX_WAIT_MS);
}

export type ApiErrorCode =
  ServerErrorCode | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'CANCELLED';

/** Messages for failures the server never saw or could not describe. */
const CLIENT_MESSAGES = {
  NETWORK: "I couldn't reach the MediLens server. Check your connection and try again.",
  TIMEOUT: 'The server took too long to answer. Please try again.',
  CANCELLED: 'The request was stopped.',
  INVALID_RESPONSE: 'The server sent an answer this app cannot read. Please update the app.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
  VALIDATION_FAILED: 'Please choose 1 to 3 photos.',
} as const;

export interface ApiErrorOptions {
  /**
   * The request failed for a passing reason and may be sent again: the
   * network or a timeout, a 429, or a 5xx that is not the API's own error
   * body (a proxy's page). Only analysis polling retries.
   */
  transient?: boolean;
  /** The response's Retry-After, as a wait in milliseconds. */
  retryAfterMs?: number;
}

export class ApiError extends Error {
  readonly transient: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.transient = options.transient ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Reads Retry-After (delay-seconds or an HTTP-date) as a wait in milliseconds. */
function retryAfterOf(res: Response): number | undefined {
  const raw = res.headers?.get?.('Retry-After')?.trim();
  if (raw === undefined || raw === '') return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** GET /api/v1/analyses/{id}/references: the registry side of a stored analysis. */
export type References = AnalysisReferences;

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

export interface AnalysisOptions extends RequestOptions {
  /**
   * Called with the newest progress event each time a poll brings a new one
   * (its `label` is the server's plain English for speech), including the
   * terminal completed, needs_attention or failed event.
   */
  onStage?: (event: AnalysisEvent) => void;
}

export interface ApiClient {
  /** The server's providers and limits; `modelProvider: "mock"` means demo mode. */
  capabilities(): Promise<Capabilities>;
  /**
   * Uploads the photos, then follows the analysis to its result. Rejects
   * with CANCELLED once `options.signal` aborts: before the upload is sent,
   * nothing reaches the server; after it, polling stops and the analysis is
   * deleted (best effort).
   */
  analyze(images: UploadImage[], options?: AnalysisOptions): Promise<AnalysisResult>;
  result(id: string): Promise<AnalysisResult>;
  /** Runs a demo scenario through the server pipeline and follows it as analyze does. */
  scenario(scenarioId: string, options?: AnalysisOptions): Promise<AnalysisResult>;
  scenarios(): Promise<DemoScenarioSummary[]>;
  explain(id: string, question: string): Promise<Answer>;
  references(id: string): Promise<References>;
  presets(): Promise<string[]>;
  /** Drops the server's copy of an analysis (204). */
  deleteAnalysis(id: string): Promise<void>;
}

function extensionFor(type: string): string {
  if (type === 'image/png') return 'png';
  if (type === 'image/webp') return 'webp';
  return 'jpg';
}

const cancelledError = () => new ApiError('CANCELLED', CLIENT_MESSAGES.CANCELLED);

/** Resolves after `ms`, or rejects CANCELLED as soon as `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createApiClient(baseUrl: string, fetchImpl: FetchLike = fetch): ApiClient {
  const root = baseUrl.replace(/\/+$/, '');
  const api = `${root}/api/v1`;

  /** `schema` null: a success has no body to read (DELETE answers 204). */
  async function request<T>(
    url: string,
    schema: z.ZodType<T> | null,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
    caller?: AbortSignal,
  ): Promise<T> {
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
          ? new ApiError('TIMEOUT', CLIENT_MESSAGES.TIMEOUT, { transient: true })
          : new ApiError('NETWORK', CLIENT_MESSAGES.NETWORK, { transient: true });
      }

      if (res.ok && schema === null) {
        if (cancelled) throw cancelledError();
        return undefined as T;
      }

      let body: unknown;
      let isJson = true;
      try {
        body = await res.json();
      } catch {
        if (cancelled) throw cancelledError();
        if (timedOut) throw new ApiError('TIMEOUT', CLIENT_MESSAGES.TIMEOUT, { transient: true });
        isJson = false;
      }
      if (cancelled) throw cancelledError();

      if (!res.ok) {
        const error = ApiErrorBodySchema.safeParse(body);
        const ownBody = isJson && error.success;
        // A 429 (the rate limit) passes; so does a 5xx whose body is not the
        // API's own error, such as a proxy's 502 page. The API's own 5xx
        // errors are answers, not passing failures.
        const options: ApiErrorOptions = {
          transient: res.status === 429 || (res.status >= 500 && !ownBody),
          retryAfterMs: retryAfterOf(res),
        };
        if (ownBody) {
          throw new ApiError(error.data.error.code, error.data.error.message, options);
        }
        throw new ApiError('INTERNAL_ERROR', CLIENT_MESSAGES.INTERNAL_ERROR, options);
      }

      const parsed = schema === null ? null : schema.safeParse(body);
      if (!isJson || parsed === null || !parsed.success) {
        throw new ApiError('INVALID_RESPONSE', CLIENT_MESSAGES.INVALID_RESPONSE);
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    }
  }

  function postJson<T>(
    url: string,
    schema: z.ZodType<T>,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return request(
      url,
      schema,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }

  const analysisUrl = (analysisId: string) => `${api}/analyses/${encodeURIComponent(analysisId)}`;

  const deleteAnalysis = (analysisId: string) =>
    request<void>(analysisUrl(analysisId), null, { method: 'DELETE' });

  /**
   * Polls a created analysis until it ends, then fetches its result. A
   * failed analysis rejects with its stored error; ANALYSIS_NOT_READY from
   * /result polls again. A poll (or the result fetch) that fails for a
   * passing reason (ApiError.transient) is retried after a backoff of
   * 1.5 s, 3 s, then 6 s, or the server's Retry-After when longer, up to
   * POLL_MAX_RETRIES failures in a row; only a round with no failure resets the count
   * (final review I1). Any other error ends the wait. Each request keeps
   * its own 15 s timeout; the server ends every analysis (each provider call
   * has its own timeout, and an analysis it no longer has is NOT_FOUND).
   *
   * When the client gives up on an analysis the server may still be
   * working on (a cancel, retries used up, an answer it cannot read), it
   * deletes the analysis, best effort, which stops the server's work. A
   * failed analysis or a NOT_FOUND was ended by the server: nothing to stop.
   */
  async function follow(analysisId: string, options: AnalysisOptions): Promise<AnalysisResult> {
    const { signal, onStage } = options;
    const url = analysisUrl(analysisId);
    let lastSeq = 0;
    let failures = 0;
    let endedByServer = false;
    try {
      for (;;) {
        let wait = POLL_INTERVAL_MS;
        try {
          const status = await request(url, AnalysisStatusSchema, {}, REQUEST_TIMEOUT_MS, signal);
          const newest = status.events.at(-1);
          if (newest !== undefined && newest.seq > lastSeq) {
            lastSeq = newest.seq;
            onStage?.(newest);
          }
          if (status.status === 'failed') {
            endedByServer = true;
            // The schema guarantees the error of a failed analysis.
            const error = status.error!;
            throw new ApiError(error.code, error.message);
          }
          if (status.status === 'completed') {
            try {
              return await request(
                `${url}/result`,
                AnalysisResultSchema,
                {},
                REQUEST_TIMEOUT_MS,
                signal,
              );
            } catch (e) {
              if (!(e instanceof ApiError && e.code === 'ANALYSIS_NOT_READY')) throw e;
            }
          }
          // Only a round with no failure resets the count: a status that
          // answers while its result keeps failing still runs out.
          failures = 0;
        } catch (e) {
          if (!(e instanceof ApiError) || !e.transient || failures >= POLL_MAX_RETRIES) throw e;
          failures += 1;
          wait = retryWaitMs(failures, e.retryAfterMs);
        }
        await pause(wait, signal);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NOT_FOUND') endedByServer = true;
      if (!endedByServer) {
        deleteAnalysis(analysisId).catch(() => {
          // Best effort: the server drops it after its TTL anyway.
        });
      }
      throw e;
    }
  }

  return {
    capabilities: () => request(`${api}/config/capabilities`, CapabilitiesSchema),

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
      const created = await request(
        `${api}/analyses`,
        AnalysisCreatedSchema,
        { method: 'POST', headers: { Accept: 'application/json' }, body: form },
        ANALYZE_TIMEOUT_MS,
        options.signal,
      );
      return follow(created.id, options);
    },

    result: (resultId) => request(`${analysisUrl(resultId)}/result`, AnalysisResultSchema),

    async scenario(scenarioId, options = {}) {
      const created = await postJson(
        `${api}/demo/scenarios`,
        AnalysisCreatedSchema,
        { scenarioId },
        options.signal,
      );
      return follow(created.id, options);
    },

    scenarios: () => request(`${api}/demo/scenarios`, DemoScenarioListSchema),

    explain: (resultId, question) =>
      postJson(`${analysisUrl(resultId)}/explanation`, AnswerSchema, { question }),

    references: (resultId) =>
      request(`${analysisUrl(resultId)}/references`, AnalysisReferencesSchema),

    presets: () => request(`${api}/questions/presets`, PresetQuestionsSchema),

    deleteAnalysis,
  };
}
