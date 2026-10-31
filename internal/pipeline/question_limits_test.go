package pipeline

import (
	"context"
	"encoding/json"
	"testing"
	"unicode/utf16"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/parity"
)

// The explain route's question limits against the Node build (task G7
// review round 1): fixtures/parity/explain/question-limits.jsonl, recorded
// by scripts/parity/record-question-limits.ts from ExplainRequestSchema
// (zod 4.6.7) and Node's explainQuestion on the 8 demo scenario results.

const questionLimitsCorpus = "explain/question-limits.jsonl"

func TestValidateQuestionMatchesExplainRequestSchema(t *testing.T) {
	n, overUnits := 0, 0
	for i, c := range parity.Load(t, questionLimitsCorpus) {
		if c.Fn != "ExplainRequestSchema" {
			continue
		}
		n++
		var body struct {
			Question string `json:"question"`
		}
		if err := json.Unmarshal(c.Args[0], &body); err != nil {
			t.Fatalf("#%d: %v", i, err)
		}
		var want struct {
			Success  bool   `json:"success"`
			Question string `json:"question"`
		}
		if err := json.Unmarshal(c.Result, &want); err != nil {
			t.Fatalf("#%d: %v", i, err)
		}
		got, err := ValidateQuestion(body.Question)
		if (err == nil) != want.Success || got != want.Question {
			t.Errorf("%+q: got (%+q, %v), zod gave (%+q, %v)", body.Question, got, err, want.Question, want.Success)
			continue
		}
		if err != nil {
			pe := wantCode(t, err, contracts.ErrValidationFailed)
			if pe.Message != questionMessage {
				t.Errorf("%+q: message %q", body.Question, pe.Message)
			}
		}
		if want.Success && len(utf16.Encode([]rune(want.Question))) > MaxQuestionChars {
			overUnits++
		}
	}
	// the corpus must pin both sides of the limit, and questions that are
	// over 300 UTF-16 units yet within 300 code points
	if n < 50 || overUnits < 10 {
		t.Fatalf("%d schema probes, %d accepted over %d UTF-16 units", n, overUnits, MaxQuestionChars)
	}
}

func TestExplainMatchesNodeAtTheQuestionLimits(t *testing.T) {
	results := map[string]contracts.AnalysisResult{}
	n := 0
	for i, c := range parity.Load(t, questionLimitsCorpus) {
		if c.Fn != "explainQuestion" {
			continue
		}
		n++
		var scenario struct {
			ScenarioID string `json:"scenarioId"`
		}
		var question string
		if err := json.Unmarshal(c.Args[0], &scenario); err != nil {
			t.Fatalf("#%d: %v", i, err)
		}
		if err := json.Unmarshal(c.Args[1], &question); err != nil {
			t.Fatalf("#%d: %v", i, err)
		}
		r, ok := results[scenario.ScenarioID]
		if !ok {
			r = scenarioResult(t, scenario.ScenarioID)
			results[scenario.ScenarioID] = r
		}
		a, err := Explain(context.Background(), r, question, noLive())
		if err != nil {
			t.Errorf("%s %+q: %v", scenario.ScenarioID, question, err)
			continue
		}
		got, err := parity.Normalize([]byte(jsonOf(t, a)))
		if err != nil {
			t.Fatal(err)
		}
		want, err := parity.Normalize(c.Result)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Errorf("%s %+q:\n got %s\nwant %s", scenario.ScenarioID, question, got, want)
		}
	}
	if n != 200 || len(results) != len(scenarioIDs) {
		t.Fatalf("%d explainQuestion cases over %d scenarios", n, len(results))
	}
}
