package ai

import (
	"context"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
)

// The mock providers (Go port spec §3; Node apps/server/src/providers/
// fixture.ts). Deterministic: no network, no model, no key. Every result
// made with them is DEMO DATA and must carry isDemo: true.

const (
	// MockModel is the provenance model of a read by the mock provider.
	MockModel = "mock"
	// FixtureModel is the model a demo scenario read reports (Node
	// FIXTURE_MODEL).
	FixtureModel = "demo-fixture"
)

// FixtureReader reads every request as the label of the demo scenario
// ScenarioID, a fresh copy, whatever the images. Model names the read's
// model; empty means FixtureModel.
type FixtureReader struct {
	ScenarioID string
	Model      string
}

// Read returns the scenario label, or OCR_FAILED for an unknown scenario.
func (f FixtureReader) Read(_ context.Context, _ [][]byte) (ReadResult, error) {
	s, ok := demo.Get(f.ScenarioID)
	if !ok {
		return ReadResult{Detail: "Unknown demo scenario."}, nil
	}
	model := f.Model
	if model == "" {
		model = FixtureModel
	}
	return ReadResult{OK: true, Label: s.Label, Model: model}, nil
}

// NewMockReader is the mock model provider's reader: any real upload reads
// as the s1 label, as Node demo mode does (Task 10 ruling), with model
// "mock".
func NewMockReader() FixtureReader {
	return FixtureReader{ScenarioID: demo.UploadScenario, Model: MockModel}
}

// MockExplainer is the mock model provider's explainer: there is no model,
// so it never explains and an explain_text answer is the printed quote
// alone, as in Node demo mode.
type MockExplainer struct{}

// Explain always returns ErrNoModel and no usage.
func (MockExplainer) Explain(context.Context, string) (string, Usage, error) {
	return "", Usage{}, ErrNoModel
}

// FixtureAnswer is the Node FixtureAnswerer: deterministic grounded answers
// built only from the label fields. The s7 preset question returns its
// canned refusal when scenarioID names s7 (the safety gate refuses it
// before any answerer in the API). An explain_text question about a
// printed phrase gets the quote-only answer; one that names no phrase reads
// back the printed field it names.
func FixtureAnswer(in domain.AnswerInput, scenarioID string) contracts.Answer {
	if s, ok := demo.Get(scenarioID); ok && s.CannedAnswer != nil && s.PresetQuestion != nil &&
		domain.JSTrim(in.Question) == *s.PresetQuestion {
		return *s.CannedAnswer
	}
	if in.Intent == domain.IntentExplainText {
		if phrase := domain.ExtractExplainPhrase(in.Question); phrase != nil {
			return domain.ComposeExplainAnswer(in, *phrase, nil)
		}
	}
	return domain.AnswerFromLabel(in)
}
