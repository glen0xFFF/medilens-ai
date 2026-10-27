// Package ai holds the model providers (Go port spec §3): the Muse Spark
// adapters over internal/metaapi, the deterministic mock, and the factory
// that picks them from the configuration with no fallback between them.
//
// The model only ever transcribes a label (LabelReader) and explains one
// printed phrase (PhraseExplainer). Every answer is built by the
// deterministic domain code; a model explanation reaches a user only after
// the closed-vocabulary gate (domain.ExplanationFits), quoted after the
// printed field it explains. Claude is never a runtime model here.
package ai

import (
	"context"
	"errors"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
)

// Usage is the token usage a call is charged for. Counts are JS numbers
// in the API response, so they are float64 here too.
type Usage struct {
	PromptTokens     float64
	CompletionTokens float64
}

// Add sums two usages.
func (u Usage) Add(v Usage) Usage {
	return Usage{u.PromptTokens + v.PromptTokens, u.CompletionTokens + v.CompletionTokens}
}

// UsageEstimate is what a call is charged when it reports no usage, or a
// request that may have run failed (final review Minor 11): the full prompt
// and completion budgets, so the spend meter fails closed.
var UsageEstimate = Usage{PromptTokens: maxCompletionTokens, CompletionTokens: maxCompletionTokens}

// ReadResult is a transcription (Node ReadResult). When OK is false the
// label could not be read (OCR_FAILED) and Detail says why: bad_image_count,
// request_failed, contributor_model or invalid_output. Usage is what the
// read is charged, failed attempts included.
type ReadResult struct {
	OK     bool
	Label  contracts.ExtractedLabel
	Model  string
	Detail string
	Usage  Usage
}

// Code is OCR_FAILED for a failed read, else "".
func (r ReadResult) Code() contracts.ErrorCode {
	if r.OK {
		return ""
	}
	return contracts.ErrOCRFailed
}

// LabelReader transcribes 1 to 3 photos of one package. It never decides
// facts. err is non-nil only when ctx ended; the ReadResult then still
// carries the usage to charge.
type LabelReader interface {
	Read(ctx context.Context, images [][]byte) (ReadResult, error)
}

// PhraseExplainer explains one printed field value in plain words. The
// explanation is untrusted: AnswerQuestion gates it. Usage is what the call
// is charged, also when err is non-nil.
type PhraseExplainer interface {
	Explain(ctx context.Context, phrase string) (string, Usage, error)
}

// Explain errors.
var (
	// ErrContributorModel: the response named no model, an empty one, or a
	// contributor model (ToS routing caveat): its output is never used and
	// the answer aborts.
	ErrContributorModel = errors.New("ai: the response came from a contributor model or named none")
	// ErrInvalidOutput: the output failed validation twice.
	ErrInvalidOutput = errors.New("ai: the model output failed validation twice")
	// ErrRequestFailed: the request failed (status, timeout, network).
	ErrRequestFailed = errors.New("ai: the model request failed")
	// ErrNoModel: the mock provider never explains.
	ErrNoModel = errors.New("ai: no model explains phrases in demo mode")
)

// RequestFailure is a failed model request as it may be logged: how it
// failed and the HTTP status (0 when there was none). No message text.
type RequestFailure struct {
	Kind   string
	Status int
}

// AnswerQuestion answers a question the safety gate already allowed (a
// refused question never reaches here), as the Node Muse Spark answerer.
// Every intent but explain_text is answered by domain.AnswerFromLabel with
// no model call, and so is an explain_text question that names no printed
// phrase (the "What does this warning mean?" preset). For a printed phrase
// the explainer is sent only the whole printed field around it
// (domain.ExplainQuote), and only when that field has no printed negation
// or condition and is about a topic the explanation vocabulary covers
// (domain.QuoteExplainable). Its explanation is spoken only if
// domain.ExplanationFits passes, else the answer is the quote alone. A
// contributor model aborts with the fallback answer. A nil explainer is no
// model. err is non-nil only when ctx ended.
func AnswerQuestion(ctx context.Context, explainer PhraseExplainer, in domain.AnswerInput) (contracts.Answer, Usage, error) {
	if in.Intent != domain.IntentExplainText {
		return domain.AnswerFromLabel(in), Usage{}, nil
	}
	phrase := domain.ExtractExplainPhrase(in.Question)
	// Task 7b review round 1: a preset that names no phrase reads the
	// printed field it names back, as in demo mode; no model call
	if phrase == nil {
		return domain.AnswerFromLabel(in), Usage{}, nil
	}
	// the whole printed field, never a fragment without its "Do not"
	quote := domain.ExplainQuote(*phrase, in.Label)
	if quote == nil {
		return domain.UnclearAnswer(domain.PhraseNotFoundText), Usage{}, nil
	}
	// Task 7b review round 2: printed text with a negation or condition,
	// or that no explanation could fit, is never sent: the quote alone
	if explainer == nil || !domain.QuoteExplainable(*quote) {
		return domain.ComposeExplainAnswer(in, *phrase, nil), Usage{}, nil
	}
	explanation, usage, err := explainer.Explain(ctx, *quote)
	switch {
	case errors.Is(err, ErrContributorModel):
		return domain.UnclearAnswer(domain.AnswerFallbackText), usage, nil
	case err != nil && ctx.Err() != nil:
		return contracts.Answer{}, usage, ctx.Err()
	case err != nil:
		return domain.ComposeExplainAnswer(in, *phrase, nil), usage, nil
	}
	if !domain.ExplanationFits(explanation, *quote) {
		return domain.ComposeExplainAnswer(in, *phrase, nil), usage, nil
	}
	return domain.ComposeExplainAnswer(in, *phrase, &explanation), usage, nil
}
