package ai

import (
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
)

func scenario(t *testing.T, id string) demo.Scenario {
	t.Helper()
	s, ok := demo.Get(id)
	if !ok {
		t.Fatalf("missing scenario %s", id)
	}
	return s
}

func scenarioInput(t *testing.T, id, question string, intent domain.AllowedIntent) domain.AnswerInput {
	t.Helper()
	s := scenario(t, id)
	return domain.AnswerInput{Label: s.Label, Match: domain.AssessMatch(&s.Label, s.Reference), Question: question, Intent: intent}
}

func TestFixtureReaderReturnsTheScenarioLabel(t *testing.T) {
	r, err := FixtureReader{ScenarioID: "s1-clear"}.Read(bg, nil)
	if err != nil || !r.OK {
		t.Fatalf("err %v, %+v", err, r)
	}
	if jsonOf(t, r.Label) != jsonOf(t, scenario(t, "s1-clear").Label) {
		t.Errorf("label %+v", r.Label)
	}
	if r.Model != FixtureModel || FixtureModel != "demo-fixture" || strings.Contains(r.Model, "contributor") {
		t.Errorf("model %q", r.Model)
	}
	if r.Usage != (Usage{}) {
		t.Errorf("usage %+v", r.Usage)
	}
}

func TestFixtureReaderFailsForAnUnknownOrAbsentScenario(t *testing.T) {
	for _, id := range []string{"nope", ""} {
		r, err := FixtureReader{ScenarioID: id}.Read(bg, nil)
		if err != nil || r.OK || r.Code() != contracts.ErrOCRFailed || r.Detail != "Unknown demo scenario." {
			t.Errorf("%q: err %v, %+v", id, err, r)
		}
	}
}

func TestFixtureReaderReturnsCopies(t *testing.T) {
	f := FixtureReader{ScenarioID: "s1-clear"}
	a, _ := f.Read(bg, nil)
	*a.Label.Fields[0].Value = "changed"
	if b, _ := f.Read(bg, nil); *b.Label.Fields[0].Value != "Paracelin 500" {
		t.Error("a change to a read reached the next one")
	}
}

// Go port spec \u00A73: the mock provider reads any real upload as the s1 label,
// as Node demo mode, and names the model "mock".
func TestMockReaderReadsAnyUploadAsS1(t *testing.T) {
	r, err := NewMockReader().Read(bg, [][]byte{jpeg, jpeg2})
	if err != nil || !r.OK || r.Model != "mock" || MockModel != "mock" {
		t.Fatalf("err %v, %+v", err, r)
	}
	if jsonOf(t, r.Label) != jsonOf(t, scenario(t, demo.UploadScenario).Label) {
		t.Error("not the s1 label")
	}
}

func TestMockExplainerNeverExplains(t *testing.T) {
	text, u, err := MockExplainer{}.Explain(bg, "Store in a cool dry place")
	if text != "" || u != (Usage{}) || !errors.Is(err, ErrNoModel) {
		t.Errorf("%q %+v %v", text, u, err)
	}
	if a, _ := answer(t, MockExplainer{}, input(storageQ, domain.IntentExplainText)); a.Text != quoteOnly {
		t.Errorf("%q", a.Text)
	}
}

/* ------------------------------------- FixtureAnswer (Node FixtureAnswerer) */

func TestFixtureAnswerReturnsTheCannedAnswerForTheS7Preset(t *testing.T) {
	s := scenario(t, "s7-unsupported-question")
	a := FixtureAnswer(scenarioInput(t, s.ID, *s.PresetQuestion, domain.IntentReadLabel), s.ID)
	if jsonOf(t, a) != jsonOf(t, *s.CannedAnswer) {
		t.Errorf("%+v", a)
	}
	// the preset is matched after a JS trim
	a = FixtureAnswer(scenarioInput(t, s.ID, " \u00A0"+*s.PresetQuestion+"\n", domain.IntentReadLabel), s.ID)
	if jsonOf(t, a) != jsonOf(t, *s.CannedAnswer) {
		t.Errorf("trimmed preset: %+v", a)
	}
	// with no scenario named, there is no canned answer
	if a = FixtureAnswer(scenarioInput(t, s.ID, *s.PresetQuestion, domain.IntentReadLabel), ""); a.Status == contracts.AnswerRefused {
		t.Errorf("canned answer without a scenario: %+v", a)
	}
}

func TestFixtureAnswerAnswersAStrengthQuestionDeterministically(t *testing.T) {
	in := scenarioInput(t, "s1-clear", "What strength is printed here?", domain.IntentStrength)
	a := FixtureAnswer(in, "s1-clear")
	if a.Status != contracts.AnswerAnswered || !slices.Equal(a.CitedFields, []contracts.FieldKey{contracts.FieldStrength}) ||
		!strings.Contains(a.Text, "500 mg") {
		t.Errorf("%+v", a)
	}
	if jsonOf(t, FixtureAnswer(in, "s1-clear")) != jsonOf(t, a) {
		t.Error("not deterministic")
	}
}

func TestFixtureAnswerCitesOnlyFieldsPresentOnTheLabel(t *testing.T) {
	s := scenario(t, "s8-registry-down")
	a := FixtureAnswer(scenarioInput(t, s.ID, "Can you read this label?", domain.IntentReadLabel), s.ID)
	if a.Status != contracts.AnswerAnswered || len(a.CitedFields) == 0 || strings.Contains(a.Text, "..") ||
		a.SpokenChunks[len(a.SpokenChunks)-1] != "Confirm with your pharmacist or doctor." {
		t.Errorf("%+v", a)
	}
	for _, k := range a.CitedFields {
		if !slices.ContainsFunc(s.Label.Fields, func(f contracts.LabelField) bool { return f.Key == k && f.Value != nil }) {
			t.Errorf("cited %s, which the label lacks", k)
		}
	}
}

func TestFixtureAnswerMarksAFieldThatIsNotClearAsUncertain(t *testing.T) {
	a := FixtureAnswer(scenarioInput(t, "s3-similar", "Which parts were unclear?", domain.IntentUnclearParts), "s3-similar")
	if a.Status != contracts.AnswerAnswered || !slices.Contains(a.CitedFields, contracts.FieldBrandName) || a.SafetyNotice == nil {
		t.Errorf("%+v", a)
	}
}

func TestFixtureAnswerIsUnclearWhenTheLabelHasNothingToCite(t *testing.T) {
	a := FixtureAnswer(scenarioInput(t, "s6-loose-pill", "Can you read this label?", domain.IntentReadLabel), "s6-loose-pill")
	if a.Status != contracts.AnswerUnclear || len(a.CitedFields) != 0 {
		t.Errorf("%+v", a)
	}
}

func TestFixtureAnswerWarnsAboutTheS4RegistryConflict(t *testing.T) {
	for _, intent := range []domain.AllowedIntent{domain.IntentStrength, domain.IntentReadLabel} {
		in := scenarioInput(t, "s4-conflict", "What strength is this?", intent)
		var ref string
		for _, c := range in.Match.Conflicting {
			if c.Key == contracts.FieldStrength {
				ref = c.ReferenceValue
			}
		}
		if ref == "" {
			t.Fatal("no strength conflict")
		}
		a := FixtureAnswer(in, "s4-conflict")
		warning := "The FDA registry record lists " + ref + " for the strength, which does not match the pack. Confirm with your pharmacist."
		if !slices.Contains(a.CitedFields, contracts.FieldStrength) || !strings.Contains(a.Text, warning) ||
			!slices.Contains(a.SpokenChunks, warning) || a.SafetyNotice == nil || *a.SafetyNotice != warning ||
			a.SpokenChunks[len(a.SpokenChunks)-1] != "Confirm with your pharmacist or doctor." {
			t.Errorf("%s: %+v", intent, a)
		}
	}
}

func TestFixtureAnswerAddsNoConflictWarningWhenTheRegistryAgrees(t *testing.T) {
	a := FixtureAnswer(scenarioInput(t, "s1-clear", "Strength?", domain.IntentStrength), "s1-clear")
	if strings.Contains(a.Text, "does not match the pack") || a.SafetyNotice != nil {
		t.Errorf("%+v", a)
	}
}

func TestFixtureAnswerExplainTextQuotesThePrintedField(t *testing.T) {
	a := FixtureAnswer(scenarioInput(t, "s1-clear", `What does "keep out of reach of children" mean?`, domain.IntentExplainText), "s1-clear")
	want := `The warnings on the label say "Do not use with other products containing paracetamol. Keep out of reach of children". ` + noExpl
	if a.Status != contracts.AnswerAnswered || a.Text != want || !slices.Equal(a.CitedFields, []contracts.FieldKey{contracts.FieldWarnings}) ||
		a.SpokenChunks[len(a.SpokenChunks)-1] != "Confirm with your pharmacist or doctor." {
		t.Errorf("%+v", a)
	}
}

func TestFixtureAnswerExplainTextWithAPhraseNotPrintedIsUnclear(t *testing.T) {
	a := FixtureAnswer(scenarioInput(t, "s1-clear", `What does "DEMO DATA" mean?`, domain.IntentExplainText), "s1-clear")
	if a.Status != contracts.AnswerUnclear || a.Text != "I can't find that phrase on this label." || len(a.CitedFields) != 0 {
		t.Errorf("%+v", a)
	}
}

func TestFixtureAnswerExplainTextNamingNoPhraseReadsTheField(t *testing.T) {
	a := FixtureAnswer(scenarioInput(t, "s1-clear", "What does this warning mean?", domain.IntentExplainText), "s1-clear")
	if a.Status != contracts.AnswerAnswered || !slices.Equal(a.CitedFields, []contracts.FieldKey{contracts.FieldWarnings}) ||
		!strings.Contains(a.Text, "Warnings as printed: Do not use with other products") {
		t.Errorf("%+v", a)
	}
}

func TestFixtureAnswerRegistryIntent(t *testing.T) {
	a := FixtureAnswer(scenarioInput(t, "s4-conflict", "What did the FDA registry say?", domain.IntentRegistry), "s4-conflict")
	if a.Status != contracts.AnswerAnswered || a.Text != "The strength on the label does not match the registry." {
		t.Errorf("%+v", a)
	}
	in := scenarioInput(t, "s1-clear", "What did the FDA registry say?", domain.IntentRegistry)
	in.Match.Advisories = []contracts.Advisory{{Title: "DEMO DATA counterfeit advisory", URL: "https://www.fda.gov.ph/demo-advisory"}}
	a = FixtureAnswer(in, "s1-clear")
	if a.Text != "This matches a product in the Philippine FDA registry. "+domain.CounterfeitAdvisorySentence {
		t.Errorf("%q", a.Text)
	}
}
