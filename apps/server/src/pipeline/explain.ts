/**
 * Follow-up questions about a stored analysis (spec §4.3, §5.1 explain).
 * Order matters and is the same in demo and live mode:
 *
 * 1. The safety gate runs first: a refused question gets its fixed refusal
 *    text and never reaches an answerer (an overdose report on an unreadable
 *    scan still gets the emergency text).
 * 2. A repeat request replays the stored summary; no answerer.
 * 3. No label was read (quality failure): a fixed "unclear" answer.
 * 4. Grounding: an explain_text question about a phrase that is printed in no
 *    label field is answered "unclear" here, before any answerer, so demo and
 *    live behave the same and no model is asked about text the scan never
 *    transcribed.
 * 5. Demo results go to the fixture answerer; live results to the live one,
 *    only while the daily budget lasts.
 * 6. Every answer is checked against the contract, and one that says "fake"
 *    or "counterfeit" outside the fixed sentences is replaced by a fixed
 *    fallback (global constraint; the app never calls the pack fake).
 */
import {
  AnswerSchema,
  type AnalysisResult,
  type Answer,
  type Explanation,
} from '@medilens/contracts';
import {
  ANSWER_FALLBACK_TEXT,
  PHRASE_NOT_FOUND_TEXT,
  explainQuote,
  unclearAnswer,
} from '../domain/answers';
import {
  REFUSAL_TEXT,
  classifyQuestion,
  extractExplainPhrase,
  type RefusalReason,
} from '../domain/safety';
import { ADVISORY_SENTENCE, STATUS_SENTENCE } from '../domain/summary';
import type { QuestionAnswerer } from '../providers/types';
import { PipelineError } from './analyze';

export const NO_LABEL_TEXT = "I couldn't read this label, so I can't answer questions about it.";

export interface ExplainDeps {
  /** Answers questions about demo results (no model, no network). */
  fixture: QuestionAnswerer;
  /** Answers questions about live results; absent in demo mode. */
  live: QuestionAnswerer | undefined;
  liveBudgetExhausted: () => boolean;
}

const FAKE_WORDS = /fake|counterfeit/i;

/**
 * The only sentences that may say "fake" or "counterfeit": the fixed FDA
 * advisory sentence and the no-match sentence ("This does not mean the
 * product is fake."). Split per sentence because spoken chunks are cut at
 * sentence boundaries.
 */
const ALLOWED_FAKE_SENTENCES: readonly string[] = [ADVISORY_SENTENCE, STATUS_SENTENCE.no_match]
  .flatMap((s) => s.split(/(?<=[.!?])\s+/))
  .filter((s) => FAKE_WORDS.test(s));

/** True when `text` says fake or counterfeit (inside any word too) outside the fixed sentences. */
export function mentionsFake(text: string): boolean {
  let rest = text;
  for (const s of ALLOWED_FAKE_SENTENCES) rest = rest.split(s).join(' ');
  return FAKE_WORDS.test(rest);
}

function refusal(reason: RefusalReason): Answer {
  const text = REFUSAL_TEXT[reason];
  return { status: 'refused', text, spokenChunks: [text], citedFields: [], safetyNotice: text };
}

function repeat(explanation: Explanation): Answer {
  return {
    status: 'answered',
    text: explanation.displayText,
    spokenChunks: [...explanation.spokenChunks],
    citedFields: [...explanation.supportingFields],
    safetyNotice: explanation.safetyNotices.length > 0 ? explanation.safetyNotices.join(' ') : null,
  };
}

/** The fixed fallback replaces any answer that calls something fake or counterfeit. */
function withoutFakeClaims(answer: Answer): Answer {
  const texts = [answer.text, ...answer.spokenChunks, answer.safetyNotice ?? ''];
  return texts.some(mentionsFake) ? unclearAnswer(ANSWER_FALLBACK_TEXT) : answer;
}

export async function explainQuestion(
  result: AnalysisResult,
  question: string,
  deps: ExplainDeps,
): Promise<Answer> {
  const verdict = classifyQuestion(question);
  if (!verdict.allowed) return refusal(verdict.reason);
  if (verdict.intent === 'other_label') return withoutFakeClaims(repeat(result.explanation));

  const label = result.label;
  if (label === null) return unclearAnswer(NO_LABEL_TEXT);

  if (verdict.intent === 'explain_text') {
    const phrase = extractExplainPhrase(question);
    if (phrase !== null && explainQuote(phrase, label) === null) {
      return unclearAnswer(PHRASE_NOT_FOUND_TEXT);
    }
  }

  let answerer: QuestionAnswerer;
  if (result.isDemo) {
    answerer = deps.fixture;
  } else {
    if (deps.live === undefined) throw new PipelineError('INTERNAL_ERROR', 'No live answerer.');
    if (deps.liveBudgetExhausted()) throw new PipelineError('LIVE_BUDGET_EXHAUSTED');
    answerer = deps.live;
  }

  const raw = await answerer.answer(
    { label, match: result.match, question, intent: verdict.intent },
    {},
  );
  const parsed = AnswerSchema.safeParse(raw);
  if (!parsed.success) throw new PipelineError('INTERNAL_ERROR', 'Answer failed validation.');
  return withoutFakeClaims(parsed.data);
}
