/**
 * Demo-mode providers (spec §4.2). Each one looks up the demo scenario named
 * by `ctx.scenarioId` and returns a copy of its fixture, so callers can never
 * mutate the shared scenarios. No network, no model, no keys.
 */
import type { Answer } from '@medilens/contracts';
import { getScenario } from '../demo/scenarios';
import { answerFromLabel, composeExplainAnswer } from '../domain/answers';
import { extractExplainPhrase } from '../domain/safety';
import type {
  AnswerInput,
  LabelReader,
  ProviderContext,
  QuestionAnswerer,
  ReadResult,
  ReferenceProvider,
  ReferenceQuery,
  ReferenceSearchResult,
} from './types';

export const FIXTURE_MODEL = 'demo-fixture';

export class FixtureLabelReader implements LabelReader {
  read(_images: Buffer[], ctx: ProviderContext): Promise<ReadResult> {
    const s = ctx.scenarioId === undefined ? undefined : getScenario(ctx.scenarioId);
    if (s === undefined) {
      return Promise.resolve({ ok: false, code: 'OCR_FAILED', detail: 'Unknown demo scenario.' });
    }
    return Promise.resolve({ ok: true, label: structuredClone(s.label), model: FIXTURE_MODEL });
  }
}

export class FixtureReferenceProvider implements ReferenceProvider {
  search(_q: ReferenceQuery, ctx: ProviderContext): Promise<ReferenceSearchResult> {
    const s = ctx.scenarioId === undefined ? undefined : getScenario(ctx.scenarioId);
    if (s === undefined) {
      return Promise.resolve({ kind: 'unavailable', reason: 'Unknown demo scenario.' });
    }
    return Promise.resolve(structuredClone(s.reference));
  }
}

/**
 * Deterministic grounded answers built only from the label fields of the
 * scan (domain/answers.ts). Refusals are made upstream by the safety gate; the
 * s7 preset question still returns its canned refusal if it reaches this
 * answerer. There is no model here, so an explain_text question about a
 * printed phrase gets the quote-only answer; one that names no phrase ("what
 * does this warning mean?") reads the printed directions and warnings back.
 */
export class FixtureAnswerer implements QuestionAnswerer {
  answer(input: AnswerInput, ctx: ProviderContext): Promise<Answer> {
    const s = ctx.scenarioId === undefined ? undefined : getScenario(ctx.scenarioId);
    if (s?.cannedAnswer !== undefined && input.question.trim() === s.presetQuestion) {
      return Promise.resolve(structuredClone(s.cannedAnswer));
    }
    if (input.intent === 'explain_text') {
      const phrase = extractExplainPhrase(input.question);
      if (phrase !== null) return Promise.resolve(composeExplainAnswer(input, phrase, null));
    }
    return Promise.resolve(answerFromLabel(input));
  }
}
