/**
 * The analysis pipeline (spec §4.1). Steps 1–3 (validate, normalise, quality)
 * run on the uploaded bytes in memory; steps 4–9 (read, lookup, match,
 * summarise, store) are shared with demo scenarios, which supply their own
 * quality report. The model only transcribes: the registry query, the match
 * and the summary are deterministic code.
 */
import {
  AnalysisResultSchema,
  type AnalysisResult,
  type ErrorCode,
  type ExtractedLabel,
  type MatchAssessment,
  type PipelineState,
  type QualityReport,
} from '@medilens/contracts';
import { getScenario } from '../demo/scenarios';
import { assessMatch, clearValue, NOT_ATTEMPTED_NOTE } from '../domain/matcher';
import { normalizeRegistrationNumber } from '../domain/parsers';
import { buildSummary } from '../domain/summary';
import { assessQuality } from '../imaging/quality';
import { normalizeImage, validateImage } from '../imaging/validate';
import type {
  LabelReader,
  ProviderContext,
  ReferenceProvider,
  ReferenceQuery,
  ReferenceSearchResult,
} from '../providers/types';
import type { ResultStore } from './store';

export const MIN_IMAGES = 1;
export const MAX_IMAGES = 3;
export const NOT_ENOUGH_TEXT_NOTE = 'Not enough clear text to search the registry.';

/** A whole-request failure: no AnalysisResult can be produced. */
export class PipelineError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

export interface PipelineDeps {
  reader: LabelReader;
  references: ReferenceProvider;
  store: ResultStore;
  now: () => number;
  newId: () => string;
  isDemo: boolean;
}

/** Live scan: validate, normalise and check quality of 1–3 uploads, then read, match, summarise, store. */
export async function analyzeImages(images: Buffer[], deps: PipelineDeps): Promise<AnalysisResult> {
  if (images.length < MIN_IMAGES || images.length > MAX_IMAGES) {
    throw new PipelineError('VALIDATION_FAILED', 'Send between 1 and 3 images.');
  }

  // 1. validate every upload before decoding any of them further.
  for (const img of images) {
    const v = await validateImage(img);
    if (!v.ok) throw new PipelineError(v.code);
  }

  // 2. normalise (in memory only).
  let normalized: Buffer[];
  try {
    normalized = await Promise.all(images.map((img) => normalizeImage(img)));
  } catch {
    throw new PipelineError('INVALID_IMAGE');
  }

  // 3. quality: any failing photo fails the scan, so a blurry side is never half-read.
  let reports: QualityReport[];
  try {
    reports = await Promise.all(normalized.map((img) => assessQuality(img)));
  } catch {
    throw new PipelineError('INVALID_IMAGE');
  }
  const quality = reports.find((r) => !r.ok) ?? reports[0];
  if (quality === undefined) throw new PipelineError('VALIDATION_FAILED');

  return readMatchStore(normalized, quality, {}, deps, deps.isDemo);
}

/** Demo scenario: steps 1–3 are skipped and the fixture's quality report is used. */
export async function analyzeScenario(
  scenarioId: string,
  deps: PipelineDeps,
): Promise<AnalysisResult> {
  const scenario = getScenario(scenarioId);
  if (scenario === undefined) throw new PipelineError('NOT_FOUND', 'Unknown demo scenario.');
  return readMatchStore([], structuredClone(scenario.quality), { scenarioId }, deps, true);
}

/** Steps 4–9. Quality failure short-circuits before the reader is called. */
async function readMatchStore(
  images: Buffer[],
  quality: QualityReport,
  ctx: ProviderContext,
  deps: PipelineDeps,
  isDemo: boolean,
): Promise<AnalysisResult> {
  let label: ExtractedLabel | null = null;
  let match: MatchAssessment;
  let pipelineState: PipelineState;

  if (!quality.ok) {
    pipelineState = 'label_unreadable';
    match = notAttempted(NOT_ATTEMPTED_NOTE);
  } else {
    const read = await deps.reader.read(images, ctx);
    if (!read.ok) throw new PipelineError('OCR_FAILED');
    label = read.label;

    switch (label.imageKind) {
      case 'loose_pill':
        pipelineState = 'loose_pill';
        match = assessMatch(label, { kind: 'not_attempted' });
        break;
      case 'not_medicine':
        pipelineState = 'not_a_label';
        match = assessMatch(label, { kind: 'not_attempted' });
        break;
      case 'unreadable':
        pipelineState = 'label_unreadable';
        match = assessMatch(label, { kind: 'not_attempted' });
        break;
      case 'label': {
        const query = registryQuery(label);
        match =
          query === null
            ? notAttempted(NOT_ENOUGH_TEXT_NOTE)
            : assessMatch(label, await search(deps.references, query, ctx));
        pipelineState = 'explanation_ready';
        break;
      }
    }
  }

  const explanation = buildSummary({ label, quality, match, isDemo, pipelineState });
  const created = deps.now();
  const parsed = AnalysisResultSchema.safeParse({
    id: deps.newId(),
    isDemo,
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + deps.store.ttlMs).toISOString(),
    pipelineState,
    quality,
    label,
    match,
    explanation,
    imageRetention: 'none',
  } satisfies AnalysisResult);
  if (!parsed.success) {
    throw new PipelineError('INTERNAL_ERROR', 'Analysis result failed validation.');
  }
  deps.store.put(parsed.data);
  return parsed.data;
}

/**
 * Registry query from clear label text only: the registration number when
 * clear and well-formed, and the brand name when clear, else the generic
 * name when clear. Null when there is nothing clear to search for.
 */
function registryQuery(label: ExtractedLabel): ReferenceQuery | null {
  const query: ReferenceQuery = {};
  const reg = clearValue(label, 'registrationNumber');
  const normalizedReg = reg === null ? null : normalizeRegistrationNumber(reg);
  if (normalizedReg !== null) query.registrationNumber = normalizedReg;
  const name = clearValue(label, 'brandName') ?? clearValue(label, 'genericNames');
  if (name !== null) query.name = name;
  return query.registrationNumber === undefined && query.name === undefined ? null : query;
}

/** A registry that throws is reported as unavailable: the user still gets what was read. */
async function search(
  references: ReferenceProvider,
  query: ReferenceQuery,
  ctx: ProviderContext,
): Promise<ReferenceSearchResult> {
  try {
    return await references.search(query, ctx);
  } catch {
    return { kind: 'unavailable', reason: 'Registry lookup failed.' };
  }
}

function notAttempted(limitation: string): MatchAssessment {
  return {
    status: 'not_attempted',
    matched: [],
    conflicting: [],
    missing: [],
    candidates: [],
    advisories: [],
    limitations: [limitation],
  };
}
