/**
 * Helpers for the live smoke script (scripts/smoke-live.ts, spec §9). They
 * wrap the real Muse Spark client and fetch so the smoke run goes through the
 * production adapters, and record only metadata: model id, finish reason,
 * token counts, HTTP status and response key names. No label text, raw text,
 * evidence or registry values are ever recorded or printed.
 */
import type { ChatClient } from '../providers/museSpark';
import type { ReadResult, ReferenceSearchResult } from '../providers/types';

export interface CompletionRecord {
  model: string | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** `usage.completion_tokens_details.reasoning_tokens`; null when not reported. */
  reasoningTokens: number | null;
}

export interface FetchRecord {
  status: number;
  /** Top-level key names of a JSON body; [] when the body is not a JSON object. */
  topLevelKeys: string[];
  /** Key names of the first `fdawebsite` row (advisory field names to confirm). */
  advisoryRowKeys: string[];
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** ToS routing caveat (spec §3): a contributor model, or no model id at all, aborts. */
export function isContributorModel(model: string | null): boolean {
  return model === null || /contributor/i.test(model);
}

/** Passes every call through to `inner` and appends one metadata record per completion. */
export function recordingClient(inner: ChatClient, sink: CompletionRecord[]): ChatClient {
  return {
    create: (async (...args: Parameters<ChatClient['create']>) => {
      const res: unknown = await inner.create(...args);
      const r = isObject(res) ? res : {};
      const usage = isObject(r.usage) ? r.usage : {};
      const details = isObject(usage.completion_tokens_details)
        ? usage.completion_tokens_details
        : {};
      const choice = Array.isArray(r.choices) && isObject(r.choices[0]) ? r.choices[0] : {};
      sink.push({
        model: typeof r.model === 'string' ? r.model : null,
        finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
        promptTokens: num(usage.prompt_tokens),
        completionTokens: num(usage.completion_tokens),
        totalTokens: num(usage.total_tokens),
        reasoningTokens: num(details.reasoning_tokens),
      });
      return res;
    }) as ChatClient['create'],
  };
}

/** Passes every request through to `inner`; reads a clone so the caller still gets the body. */
export function recordingFetch(inner: typeof fetch, sink: FetchRecord[]): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    let topLevelKeys: string[] = [];
    let advisoryRowKeys: string[] = [];
    try {
      const json: unknown = JSON.parse(await res.clone().text());
      if (isObject(json)) {
        topLevelKeys = Object.keys(json).sort();
        const rows = json.fdawebsite;
        if (Array.isArray(rows) && isObject(rows[0])) advisoryRowKeys = Object.keys(rows[0]).sort();
      }
    } catch {
      // non-JSON body: key lists stay empty
    }
    sink.push({ status: res.status, topLevelKeys, advisoryRowKeys });
    return res;
  };
}

export interface SmokeReportInput {
  completions: CompletionRecord[];
  read: ReadResult;
  fetches: FetchRecord[];
  /** Undefined when the lookup was not run (e.g. after an abort). */
  fda: ReferenceSearchResult | undefined;
}

const show = (n: number | null): string => (n === null ? 'not reported' : String(n));

/** Report lines with counts and metadata only. `aborted` is true for a contributor model. */
export function renderSmokeReport(input: SmokeReportInput): { lines: string[]; aborted: boolean } {
  const lines: string[] = [];
  let aborted = false;

  input.completions.forEach((c, i) => {
    lines.push(
      `Muse Spark call ${i + 1}: model=${c.model ?? '(none)'} finish_reason=${c.finishReason ?? '(none)'} ` +
        `prompt_tokens=${show(c.promptTokens)} completion_tokens=${show(c.completionTokens)} ` +
        `total_tokens=${show(c.totalTokens)} reasoning_tokens=${show(c.reasoningTokens)}`,
    );
    if (isContributorModel(c.model)) aborted = true;
  });
  if (input.completions.length === 0) lines.push('Muse Spark: no completion returned.');

  if (input.read.ok) {
    const fields = input.read.label.fields;
    const withValue = fields.filter((f) => f.value !== null).length;
    const clear = fields.filter((f) => f.legibility === 'clear').length;
    lines.push(
      `Label read: ok (imageKind=${input.read.label.imageKind}, fields with a value: ${withValue}/${fields.length}, clear: ${clear})`,
    );
  } else {
    lines.push(`Label read: failed (${input.read.code}: ${input.read.detail})`);
  }

  if (aborted) {
    lines.push('ABORT: a contributor model served this request; its output is not used.');
    return { lines, aborted };
  }

  input.fetches.forEach((f, i) => {
    lines.push(
      `PH FDA request ${i + 1}: HTTP ${f.status}; top-level keys: ${f.topLevelKeys.join(', ') || '(none)'}; ` +
        `fdawebsite row keys: ${f.advisoryRowKeys.join(', ') || '(none)'}`,
    );
  });
  if (input.fda === undefined) {
    lines.push('PH FDA lookup: not run');
  } else if (input.fda.kind === 'ok') {
    lines.push(
      `PH FDA lookup: ok (records: ${input.fda.records.length}, advisories: ${input.fda.advisories.length}` +
        `${input.fda.advisoriesUnchecked === true ? ', advisories unchecked' : ''})`,
    );
  } else if (input.fda.kind === 'unavailable') {
    lines.push(`PH FDA lookup: unavailable (${input.fda.reason})`);
  } else {
    lines.push('PH FDA lookup: not attempted');
  }
  return { lines, aborted };
}
