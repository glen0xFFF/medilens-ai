package pipeline

import (
	"context"
	"strings"
	"unicode/utf8"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
)

// Follow-up questions about a stored analysis (base spec §4.3, Go port
// spec §4 explanation), a port of apps/server/src/pipeline/explain.ts.
// Order matters and is the same for demo and live results:
//
//  1. The safety gate runs first: a refused question gets its fixed
//     refusal text and never reaches an answerer (an overdose report on an
//     unreadable scan still gets the emergency text).
//  2. A repeat request replays the stored summary as it was spoken; no
//     answerer.
//  3. No label was read (quality failure), or the scan is a loose pill,
//     not a medicine or unreadable: a fixed "unclear" answer.
//  4. Grounding: an explain_text question about a phrase that is printed
//     in no label field is answered "unclear" here, before any answerer.
//  5. Demo results go to the fixture answerer; live results to the live
//     one, only while the daily budget lasts.
//  6. Every answer is checked against the contract, and one that says
//     "fake" or "counterfeit" outside the fixed sentences is replaced by a
//     fixed fallback (global constraint; the app never calls the pack
//     fake).

// MaxQuestionChars is the longest question, in Unicode code points after
// the trim (ExplainRequestSchema). zod 4.6.7 measures a string's length in
// code points ($ZodCheckMaxLength, util.codePointLength), not UTF-16 units:
// an emoji counts once. The safety gate's own 300 limit is in UTF-16 units
// (domain.ClassifyQuestion), so a question of up to 300 code points but over
// 300 units passes here and is refused there, as in Node.
const MaxQuestionChars = 300

const questionMessage = `Send {"question": "..."} with 1 to 300 characters.`

// LiveAnswerer answers an allowed question about a live result: the
// answer, the usage to charge, and ctx's error when ctx ended.
type LiveAnswerer func(ctx context.Context, in domain.AnswerInput) (contracts.Answer, ai.Usage, error)

// NewLiveAnswerer is the live answerer over the configured explainer
// (ai.AnswerQuestion): deterministic answers, and for a printed phrase the
// explainer's gated explanation.
func NewLiveAnswerer(explainer ai.PhraseExplainer) LiveAnswerer {
	return func(ctx context.Context, in domain.AnswerInput) (contracts.Answer, ai.Usage, error) {
		return ai.AnswerQuestion(ctx, explainer, in)
	}
}

// ExplainDeps are what Explain answers with.
type ExplainDeps struct {
	// Live answers questions about live (non-demo) results; nil means
	// there is no live answerer (an INTERNAL_ERROR for a live result).
	Live LiveAnswerer
	// LiveBudgetExhausted is checked before the live answerer runs; nil
	// counts as exhausted (fail closed).
	LiveBudgetExhausted func() bool
	// OnUsage receives the live answerer's usage; nil ignores it.
	OnUsage func(ai.Usage)
}

// ValidateQuestion is ExplainRequestSchema: the question JS-trimmed, then
// 1 to 300 code points (task G7 review round 1). It returns the trimmed
// question or a VALIDATION_FAILED error.
//
// A lone surrogate counts as one code point in zod. A Go string never holds
// one: encoding/json decodes a lone \u escape to U+FFFD, which counts as one
// here too (fixtures/parity/explain/question-limits.jsonl).
func ValidateQuestion(question string) (string, error) {
	q := domain.JSTrim(question)
	if n := utf8.RuneCountInString(q); n < 1 || n > MaxQuestionChars {
		return "", &Error{Code: contracts.ErrValidationFailed, Message: questionMessage}
	}
	return q, nil
}

// Explain answers question about result. It returns a *Error
// (VALIDATION_FAILED, LIVE_BUDGET_EXHAUSTED, INTERNAL_ERROR), or ctx's
// error when the live answerer was cut off.
func Explain(ctx context.Context, result contracts.AnalysisResult, question string, deps ExplainDeps) (contracts.Answer, error) {
	q, err := ValidateQuestion(question)
	if err != nil {
		return contracts.Answer{}, err
	}
	verdict := domain.ClassifyQuestion(q)
	if !verdict.Allowed {
		return refusal(verdict.Reason), nil
	}
	// final review Minor 3: the stored summary is replayed as it was
	// spoken; it is deterministic, and the pack's own printed text is read
	// verbatim even when it says "counterfeit" (Task 5 ruling)
	if verdict.Intent == domain.IntentOtherLabel {
		return repeat(result.Explanation), nil
	}

	if result.Label == nil {
		return domain.UnclearAnswer(domain.NoLabelText), nil
	}
	label := *result.Label
	// final review I2: a loose pill, a photo with no medicine or an
	// unreadable label is answered with the summary's sentence
	if a := domain.NotALabelAnswer(label); a != nil {
		return *a, nil
	}

	if verdict.Intent == domain.IntentExplainText {
		if phrase := domain.ExtractExplainPhrase(q); phrase != nil && domain.ExplainQuote(*phrase, label) == nil {
			return domain.UnclearAnswer(domain.PhraseNotFoundText), nil
		}
	}

	in := domain.AnswerInput{Label: label, Match: result.Match, Question: q, Intent: verdict.Intent}
	var answer contracts.Answer
	if result.IsDemo {
		// the Node route passed the fixture answerer no scenario id
		answer = ai.FixtureAnswer(in, "")
	} else {
		if deps.Live == nil {
			return contracts.Answer{}, NewError(contracts.ErrInternal)
		}
		if deps.LiveBudgetExhausted == nil || deps.LiveBudgetExhausted() {
			return contracts.Answer{}, NewError(contracts.ErrLiveBudgetExhausted)
		}
		a, usage, err := deps.Live(ctx, in)
		if deps.OnUsage != nil && usage != (ai.Usage{}) {
			deps.OnUsage(usage)
		}
		if err != nil {
			return contracts.Answer{}, err
		}
		answer = a
	}
	if !conformAnswer(answer) {
		return contracts.Answer{}, NewError(contracts.ErrInternal)
	}
	return withoutFakeClaims(answer), nil
}

func refusal(reason domain.RefusalReason) contracts.Answer {
	text := domain.RefusalText[reason]
	return contracts.Answer{
		Status:       contracts.AnswerRefused,
		Text:         text,
		SpokenChunks: []string{text},
		CitedFields:  []contracts.FieldKey{},
		SafetyNotice: contracts.Ptr(text),
	}
}

func repeat(e contracts.Explanation) contracts.Answer {
	a := contracts.Answer{
		Status:       contracts.AnswerAnswered,
		Text:         e.DisplayText,
		SpokenChunks: append([]string{}, e.SpokenChunks...),
		CitedFields:  append([]contracts.FieldKey{}, e.SupportingFields...),
	}
	if len(e.SafetyNotices) > 0 {
		a.SafetyNotice = contracts.Ptr(strings.Join(e.SafetyNotices, " "))
	}
	return a
}

// withoutFakeClaims replaces any answer that calls something fake or
// counterfeit with the fixed fallback.
func withoutFakeClaims(a contracts.Answer) contracts.Answer {
	texts := append([]string{a.Text}, a.SpokenChunks...)
	if a.SafetyNotice != nil {
		texts = append(texts, *a.SafetyNotice)
	}
	for _, t := range texts {
		if MentionsFake(t) {
			return domain.UnclearAnswer(domain.AnswerFallbackText)
		}
	}
	return a
}

// allowedFakeSentences are the only sentences that may say "fake" or
// "counterfeit": the fixed FDA advisory sentence and the no-match sentence
// ("This does not mean the product is fake."), split per sentence because
// spoken chunks are cut at sentence boundaries.
var allowedFakeSentences = func() []string {
	var out []string
	for _, s := range []string{domain.CounterfeitAdvisorySentence, domain.StatusSentence[contracts.MatchNoMatch]} {
		for _, part := range splitAfterSentenceEnd(s) {
			if fakeWord(part) {
				out = append(out, part)
			}
		}
	}
	return out
}()

// splitAfterSentenceEnd is s.split(/(?<=[.!?])\s+/) for the fixed ASCII
// sentences above: a cut at each whitespace run after . ! or ?.
func splitAfterSentenceEnd(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if (s[i] == '.' || s[i] == '!' || s[i] == '?') && i+1 < len(s) && isASCIISpace(s[i+1]) {
			out = append(out, s[start:i+1])
			j := i + 1
			for j < len(s) && isASCIISpace(s[j]) {
				j++
			}
			start = j
			i = j - 1
		}
	}
	return append(out, s[start:])
}

func isASCIISpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}

// fakeWord is /fake|counterfeit/i: without the u flag JS folds ASCII
// letters only (a non-ASCII character never matches an ASCII one), so a
// byte-wise ASCII lowercase is exact.
func fakeWord(s string) bool {
	b := []byte(s)
	for i, c := range b {
		if 'A' <= c && c <= 'Z' {
			b[i] = c + 'a' - 'A'
		}
	}
	lower := string(b)
	return strings.Contains(lower, "fake") || strings.Contains(lower, "counterfeit")
}

// MentionsFake reports whether text says fake or counterfeit (inside any
// word too) outside the fixed sentences.
func MentionsFake(text string) bool {
	rest := text
	for _, s := range allowedFakeSentences {
		rest = strings.ReplaceAll(rest, s, " ")
	}
	return fakeWord(rest)
}
