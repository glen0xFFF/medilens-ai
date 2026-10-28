import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isContributorModel,
  recordingClient,
  recordingFetch,
  renderSmokeReport,
  type CompletionRecord,
  type FetchRecord,
} from '../../src/eval/smoke';
import { createMuseSparkLabelReader, type ChatClient } from '../../src/providers/museSpark';

/* Synthetic recorded responses (DEMO DATA, fictional product). No network. */
function fixture(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/${path}.json`, import.meta.url), 'utf8'));
}

function clientReturning(response: unknown): ChatClient {
  return { create: () => Promise.resolve(response) } as unknown as ChatClient;
}

const IMAGE = Buffer.from('not-decoded-by-the-reader');

describe('recordingClient', () => {
  it('records model, finish reason and token usage including reasoning_tokens', async () => {
    const res = fixture('muse/label-ok');
    res.usage = {
      prompt_tokens: 1200,
      completion_tokens: 900,
      total_tokens: 2100,
      completion_tokens_details: { reasoning_tokens: 640 },
    };
    const sink: CompletionRecord[] = [];
    const reader = createMuseSparkLabelReader(recordingClient(clientReturning(res), sink));
    const read = await reader.read([IMAGE], {});
    expect(read.ok).toBe(true);
    expect(sink).toEqual([
      {
        model: 'muse-spark-1.3',
        finishReason: 'stop',
        promptTokens: 1200,
        completionTokens: 900,
        totalTokens: 2100,
        reasoningTokens: 640,
      },
    ]);
  });

  it('records reasoningTokens as null when the API does not report them', async () => {
    const res = fixture('muse/label-ok');
    res.usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    const sink: CompletionRecord[] = [];
    await createMuseSparkLabelReader(recordingClient(clientReturning(res), sink)).read([IMAGE], {});
    expect(sink[0]?.reasoningTokens).toBeNull();
  });
});

describe('isContributorModel', () => {
  it('flags any model id containing "contributor", case-insensitively', () => {
    expect(isContributorModel('muse-spark-1.3-Contributor')).toBe(true);
    expect(isContributorModel('muse-spark-1.3')).toBe(false);
    expect(isContributorModel(null)).toBe(true);
  });
});

describe('recordingFetch', () => {
  it('records the status and key names only, and leaves the body readable', async () => {
    const body = JSON.stringify({
      cdrr: [{ brand_name: 'Paracelin' }],
      fdawebsite: [{ title: 'Advisory', link: 'https://example.org/a' }],
    });
    const inner = (() => Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch;
    const sink: FetchRecord[] = [];
    const res = await recordingFetch(inner, sink)('https://x.test/api/search?q=a');
    expect(await res.text()).toBe(body);
    expect(sink).toEqual([
      { status: 200, topLevelKeys: ['cdrr', 'fdawebsite'], advisoryRowKeys: ['link', 'title'] },
    ]);
    expect(JSON.stringify(sink)).not.toContain('Paracelin');
  });

  it('records empty key lists for a non-JSON body', async () => {
    const inner = (() => Promise.resolve(new Response('<html>', { status: 503 }))) as typeof fetch;
    const sink: FetchRecord[] = [];
    await recordingFetch(inner, sink)('https://x.test/');
    expect(sink).toEqual([{ status: 503, topLevelKeys: [], advisoryRowKeys: [] }]);
  });
});

describe('renderSmokeReport', () => {
  const completion: CompletionRecord = {
    model: 'muse-spark-1.3',
    finishReason: 'stop',
    promptTokens: 1200,
    completionTokens: 900,
    totalTokens: 2100,
    reasoningTokens: 640,
  };
  const label = {
    imageKind: 'label' as const,
    fields: [
      {
        key: 'brandName' as const,
        value: 'SECRET BRAND',
        legibility: 'clear' as const,
        evidenceText: 'SECRET EVIDENCE',
        imageIndex: null,
        notes: null,
      },
      {
        key: 'strength' as const,
        value: null,
        legibility: 'unreadable' as const,
        evidenceText: null,
        imageIndex: null,
        notes: null,
      },
    ],
    rawText: 'SECRET RAW TEXT',
    warnings: ['SECRET WARNING'],
  };

  it('prints model id, status and usage, and never any read text', () => {
    const { lines, aborted } = renderSmokeReport({
      completions: [completion],
      read: { ok: true, label, model: 'muse-spark-1.3' },
      fetches: [{ status: 200, topLevelKeys: ['cdrr'], advisoryRowKeys: [] }],
      fda: { kind: 'ok', records: [], advisories: [] },
    });
    const out = lines.join('\n');
    expect(aborted).toBe(false);
    expect(out).toContain('model=muse-spark-1.3');
    expect(out).toContain('reasoning_tokens=640');
    expect(out).toContain('prompt_tokens=1200');
    expect(out).toContain('Label read: ok');
    expect(out).toContain('PH FDA lookup: ok');
    expect(out).not.toMatch(/SECRET/);
  });

  it('says reasoning tokens were not reported when absent', () => {
    const { lines } = renderSmokeReport({
      completions: [{ ...completion, reasoningTokens: null }],
      read: { ok: false, code: 'OCR_FAILED', detail: 'invalid_output' },
      fetches: [],
      fda: undefined,
    });
    expect(lines.join('\n')).toContain('reasoning_tokens=not reported');
    expect(lines.join('\n')).toContain('Label read: failed (OCR_FAILED: invalid_output)');
  });

  it('aborts when any completion came from a contributor model', () => {
    const { lines, aborted } = renderSmokeReport({
      completions: [{ ...completion, model: 'muse-spark-1.3-contributor' }],
      read: { ok: false, code: 'OCR_FAILED', detail: 'contributor_model' },
      fetches: [],
      fda: undefined,
    });
    expect(aborted).toBe(true);
    expect(lines.join('\n')).toMatch(/ABORT/);
  });
});
