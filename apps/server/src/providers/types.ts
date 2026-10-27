import type { Answer, ExtractedLabel, MatchAssessment, ReferenceRecord } from '@medilens/contracts';
import type { AllowedIntent } from '../domain/safety';

/** Outcome of a registry lookup, as handed to the matcher. */
export type ReferenceSearchResult =
  | { kind: 'ok'; records: ReferenceRecord[]; advisories: { title: string; url: string }[] }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'not_attempted' };

/** Per-request context; `scenarioId` selects a fixture in demo mode. */
export interface ProviderContext {
  scenarioId?: string;
}

/** Transcription result. The model only transcribes; it never decides facts. */
export type ReadResult =
  | { ok: true; label: ExtractedLabel; model: string }
  | { ok: false; code: 'OCR_FAILED'; detail: string };

export interface LabelReader {
  read(images: Buffer[], ctx: ProviderContext): Promise<ReadResult>;
}

export interface ReferenceQuery {
  registrationNumber?: string;
  name?: string;
}

export interface ReferenceProvider {
  search(q: ReferenceQuery, ctx: ProviderContext): Promise<ReferenceSearchResult>;
}

export interface AnswerInput {
  label: ExtractedLabel;
  match: MatchAssessment;
  question: string;
  /** The safety gate's allowed intent; refused questions never reach an answerer. */
  intent: AllowedIntent;
}

export interface QuestionAnswerer {
  answer(input: AnswerInput, ctx: ProviderContext): Promise<Answer>;
}
