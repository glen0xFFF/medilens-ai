package pipeline

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
)

// Ports apps/server/test/http/explain.test.ts at the pipeline level (the
// HTTP status mapping is task G8's). All data is synthetic DEMO DATA.

var scenarioIDs = []string{
	"s1-clear", "s2-blurry", "s3-similar", "s4-conflict",
	"s5-nomatch", "s6-loose-pill", "s7-unsupported-question", "s8-registry-down",
}

var allFields = []contracts.FieldKey{
	"brandName", "genericNames", "strength", "dosageForm", "manufacturer", "registrationNumber",
	"directions", "warnings", "storage", "expiryDate", "batchNumber", "rxOrOtc",
}

func scenarioResult(t *testing.T, id string) contracts.AnalysisResult {
	t.Helper()
	r, err := AnalyzeScenario(context.Background(), "demo-"+id, id, Deps{Now: fixed(t0), TTL: fifteenMin})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func s1(t *testing.T) demo.Scenario {
	t.Helper()
	s, ok := demo.Get("s1-clear")
	if !ok {
		t.Fatal("missing s1")
	}
	return s
}

// liveResult is a live scan (isDemo false) read as label, against search.
func liveResult(t *testing.T, label contracts.ExtractedLabel, search *contracts.SearchResult) contracts.AnalysisResult {
	t.Helper()
	sharp, _ := testImages(t)
	sr := s1(t).Reference
	if search != nil {
		sr = *search
	}
	s := newSetup(okRead(label), &sr)
	r := analyze(t, s, sharp)
	if r.IsDemo {
		t.Fatal("live result is demo")
	}
	return r
}

type liveCalls struct {
	mu     sync.Mutex
	inputs []domain.AnswerInput
}

func (c *liveCalls) n() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.inputs)
}

// countingLive wraps answer as the live answerer and counts its calls.
func countingLive(answer func(context.Context, domain.AnswerInput) (contracts.Answer, ai.Usage, error)) (LiveAnswerer, *liveCalls) {
	calls := &liveCalls{}
	return func(ctx context.Context, in domain.AnswerInput) (contracts.Answer, ai.Usage, error) {
		calls.mu.Lock()
		calls.inputs = append(calls.inputs, in)
		calls.mu.Unlock()
		return answer(ctx, in)
	}, calls
}

func deterministicLive() (LiveAnswerer, *liveCalls) {
	return countingLive(func(_ context.Context, in domain.AnswerInput) (contracts.Answer, ai.Usage, error) {
		return domain.AnswerFromLabel(in), ai.Usage{}, nil
	})
}

func liveDeps(live LiveAnswerer) ExplainDeps {
	return ExplainDeps{Live: live, LiveBudgetExhausted: func() bool { return false }}
}

func ask(t *testing.T, r contracts.AnalysisResult, q string, deps ExplainDeps) contracts.Answer {
	t.Helper()
	a, err := Explain(context.Background(), r, q, deps)
	if err != nil {
		t.Fatalf("explain %q: %v", q, err)
	}
	if !a.Status.Valid() {
		t.Fatalf("status %q", a.Status)
	}
	return a
}

func noLive() ExplainDeps {
	return ExplainDeps{LiveBudgetExhausted: func() bool { return false }}
}

func refusalAnswer(reason domain.RefusalReason) contracts.Answer {
	text := domain.RefusalText[reason]
	return contracts.Answer{Status: contracts.AnswerRefused, Text: text, SpokenChunks: []string{text}, CitedFields: []contracts.FieldKey{}, SafetyNotice: contracts.Ptr(text)}
}

func unclear(text string) contracts.Answer {
	return contracts.Answer{Status: contracts.AnswerUnclear, Text: text, SpokenChunks: []string{text, domain.FinalLine}, CitedFields: []contracts.FieldKey{}}
}

/* ----------------------------------------------------- safety gate first */

func TestExplainS7PresetQuestionIsRefusedWithThePharmacistRedirect(t *testing.T) {
	s7, _ := demo.Get("s7-unsupported-question")
	a := ask(t, scenarioResult(t, "s7-unsupported-question"), *s7.PresetQuestion, noLive())
	if jsonOf(t, a) != jsonOf(t, refusalAnswer(domain.RefusalPersonalDose)) {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainAPossibleOverdoseGetsTheEmergencyTextEvenOnAnUnreadableScan(t *testing.T) {
	a := ask(t, scenarioResult(t, "s2-blurry"), "My child swallowed the whole bottle", noLive())
	if a.Status != contracts.AnswerRefused || a.Text != domain.RefusalText[domain.RefusalPossibleOverdose] {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainAFreeTypedQuestionOutsideTheLabelIsRefused(t *testing.T) {
	a := ask(t, scenarioResult(t, "s1-clear"), "Tell me a joke about pharmacists", noLive())
	if a.Status != contracts.AnswerRefused || a.Text != domain.RefusalText[domain.RefusalOutsideLabel] {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainARefusedQuestionNeverReachesTheLiveAnswerer(t *testing.T) {
	live, calls := deterministicLive()
	a := ask(t, liveResult(t, s1(t).Label, nil), "How many should I take for my headache?", liveDeps(live))
	if a.Status != contracts.AnswerRefused || calls.n() != 0 {
		t.Errorf("status %s calls %d", a.Status, calls.n())
	}
}

/* --------------------------------------------------------------- answers */

func TestExplainS1AllowedQuestionIsAnsweredWithCitedFields(t *testing.T) {
	a := ask(t, scenarioResult(t, "s1-clear"), "What strength is printed here?", noLive())
	if a.Status != contracts.AnswerAnswered || !slices.Equal(a.CitedFields, []contracts.FieldKey{"strength"}) ||
		!strings.Contains(a.Text, "500 mg") || a.SpokenChunks[len(a.SpokenChunks)-1] != domain.FinalLine {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainEveryS1PresetIsAnsweredNeverRefused(t *testing.T) {
	r := scenarioResult(t, "s1-clear")
	for _, q := range domain.AllowedQuestionExamples {
		if a := ask(t, r, q, noLive()); a.Status == contracts.AnswerRefused {
			t.Errorf("%q refused", q)
		}
	}
}

func TestExplainS1PresetsCiteTheFieldTheyAskAbout(t *testing.T) {
	table := []struct {
		q          string
		cited      []contracts.FieldKey
		firstChunk string
	}{
		{"Can you read this label?", allFields, "Brand name as printed: Paracelin 500."},
		{"What does this warning mean?", []contracts.FieldKey{"warnings"}, "Warnings as printed: Do not use with other products containing paracetamol. Keep out of reach of children."},
		{"What strength is printed here?", []contracts.FieldKey{"strength"}, "Strength as printed: 500 mg."},
		{"Explain the directions in simpler words.", []contracts.FieldKey{"directions"}, "Directions as printed: Adults: 1 to 2 tablets every 4 to 6 hours as needed. Do not take more than 8 tablets in 24 hours."},
		{"Which parts were unclear?", allFields, "Every part I read on this label was clear."},
		{"What did the FDA registry say?", []contracts.FieldKey{"registrationNumber"}, domain.StatusSentence[contracts.MatchVerified]},
		{"Who makes this medicine?", []contracts.FieldKey{"manufacturer"}, "Manufacturer as printed: Demo Pharma Labs."},
		{"What is the expiry date on the pack?", []contracts.FieldKey{"expiryDate"}, "Expiry date as printed: 05/2028."},
		{"How should it be stored?", []contracts.FieldKey{"storage"}, "Storage as printed: Store below 30 degrees Celsius in a dry place."},
	}
	var qs []string
	for _, row := range table {
		qs = append(qs, row.q)
	}
	presets := slices.DeleteFunc(slices.Clone(domain.AllowedQuestionExamples), func(q string) bool { return q == "Can you repeat that?" })
	if !slices.Equal(qs, presets) {
		t.Fatalf("the table does not cover the presets: %v", presets)
	}
	r := scenarioResult(t, "s1-clear")
	for _, row := range table {
		a := ask(t, r, row.q, noLive())
		if a.Status != contracts.AnswerAnswered || !slices.Equal(a.CitedFields, row.cited) ||
			a.SpokenChunks[0] != row.firstChunk || a.SpokenChunks[len(a.SpokenChunks)-1] != domain.FinalLine {
			t.Errorf("%q: %s", row.q, jsonOf(t, a))
		}
	}
}

func TestExplainRepeatReplaysTheStoredSummaryWithoutAnyAnswerer(t *testing.T) {
	live, calls := deterministicLive()
	r := liveResult(t, s1(t).Label, nil)
	a := ask(t, r, "Can you repeat that?", liveDeps(live))
	if a.Status != contracts.AnswerAnswered || a.Text != r.Explanation.DisplayText ||
		!slices.Equal(a.SpokenChunks, r.Explanation.SpokenChunks) || !slices.Equal(a.CitedFields, r.Explanation.SupportingFields) {
		t.Errorf("answer %s", jsonOf(t, a))
	}
	if calls.n() != 0 {
		t.Errorf("answerer called %d times", calls.n())
	}
	wantNotice := strings.Join(r.Explanation.SafetyNotices, " ")
	if (len(r.Explanation.SafetyNotices) == 0) != (a.SafetyNotice == nil) || (a.SafetyNotice != nil && *a.SafetyNotice != wantNotice) {
		t.Errorf("safety notice %v", a.SafetyNotice)
	}
}

func TestExplainRepeatWorksOnAnUnreadableScanToo(t *testing.T) {
	r := scenarioResult(t, "s2-blurry")
	a := ask(t, r, "Can you repeat that?", noLive())
	if a.Status != contracts.AnswerAnswered || !slices.Equal(a.SpokenChunks, r.Explanation.SpokenChunks) {
		t.Errorf("answer %s", jsonOf(t, a))
	}
	wantNotice := strings.Join(r.Explanation.SafetyNotices, " ")
	if (len(r.Explanation.SafetyNotices) == 0) != (a.SafetyNotice == nil) || (a.SafetyNotice != nil && *a.SafetyNotice != wantNotice) {
		t.Errorf("safety notice %v", a.SafetyNotice)
	}
}

func TestExplainNoLabelReadIsUnclearWithNothingCited(t *testing.T) {
	r := scenarioResult(t, "s2-blurry")
	if r.Label != nil {
		t.Fatal("s2 has a label")
	}
	a := ask(t, r, "What strength is printed here?", noLive())
	if jsonOf(t, a) != jsonOf(t, unclear(domain.NoLabelText)) ||
		domain.NoLabelText != "I couldn't read this label, so I can't answer questions about it." {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainS5RegistryAnswerKeepsTheDoesNotMeanFakeSentence(t *testing.T) {
	a := ask(t, scenarioResult(t, "s5-nomatch"), "What did the FDA registry say?", noLive())
	if a.Status != contracts.AnswerAnswered || !strings.Contains(a.Text, domain.StatusSentence[contracts.MatchNoMatch]) {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainALiveRegistryAnswerKeepsTheFixedAdvisorySentence(t *testing.T) {
	sr := okSearch(s1(t).Reference.Records...)
	sr.Advisories = []contracts.Advisory{{Title: "DEMO DATA counterfeit advisory", URL: "https://www.fda.gov.ph/demo-advisory"}}
	live, _ := deterministicLive()
	a := ask(t, liveResult(t, s1(t).Label, &sr), "What did the FDA registry say?", liveDeps(live))
	if a.Status != contracts.AnswerAnswered || !strings.Contains(a.Text, domain.CounterfeitAdvisorySentence) {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

/* ------------------------------------------------------- answerer routing */

func TestExplainALiveResultIsAnsweredByTheLiveAnswerer(t *testing.T) {
	live, calls := deterministicLive()
	r := liveResult(t, s1(t).Label, nil)
	a := ask(t, r, "What strength is printed here?", liveDeps(live))
	if a.Status != contracts.AnswerAnswered || calls.n() != 1 {
		t.Fatalf("status %s calls %d", a.Status, calls.n())
	}
	in := calls.inputs[0]
	if in.Intent != domain.IntentStrength || in.Question != "What strength is printed here?" ||
		jsonOf(t, in.Label) != jsonOf(t, r.Label) || jsonOf(t, in.Match) != jsonOf(t, r.Match) {
		t.Errorf("input %s", jsonOf(t, in))
	}
}

func TestExplainADemoResultIsAnsweredByTheFixtureAnswerer(t *testing.T) {
	live, calls := deterministicLive()
	a := ask(t, scenarioResult(t, "s1-clear"), "What strength is printed here?", liveDeps(live))
	if a.Status != contracts.AnswerAnswered || calls.n() != 0 {
		t.Errorf("status %s calls %d", a.Status, calls.n())
	}
}

// The question reaches the answerer trimmed, as ExplainRequestSchema
// outputs it.
func TestExplainTrimsTheQuestion(t *testing.T) {
	live, calls := deterministicLive()
	ask(t, liveResult(t, s1(t).Label, nil), " \tWhat strength is printed here?\n ", liveDeps(live))
	if calls.n() != 1 || calls.inputs[0].Question != "What strength is printed here?" {
		t.Errorf("inputs %d", calls.n())
	}
}

/* -------------------------------------------------------------- grounding */

const notPrinted = `What does "xyzzy tincture" mean?`

func TestExplainDemoAPhraseNotPrintedIsUnclear(t *testing.T) {
	a := ask(t, scenarioResult(t, "s1-clear"), notPrinted, noLive())
	if a.Status != contracts.AnswerUnclear || a.Text != domain.PhraseNotFoundText {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainLiveAPhraseNotPrintedIsUnclearAndTheAnswererIsNeverCalled(t *testing.T) {
	live, calls := countingLive(func(context.Context, domain.AnswerInput) (contracts.Answer, ai.Usage, error) {
		return contracts.Answer{Status: contracts.AnswerAnswered, Text: "Xyzzy tincture is a herbal remedy.",
			SpokenChunks: []string{"Xyzzy tincture is a herbal remedy."}, CitedFields: []contracts.FieldKey{"warnings"}}, ai.Usage{}, nil
	})
	a := ask(t, liveResult(t, s1(t).Label, nil), notPrinted, liveDeps(live))
	if a.Status != contracts.AnswerUnclear || a.Text != domain.PhraseNotFoundText || calls.n() != 0 {
		t.Errorf("answer %s calls %d", jsonOf(t, a), calls.n())
	}
}

func TestExplainDemoAPrintedPhraseIsQuotedFromTheLabel(t *testing.T) {
	a := ask(t, scenarioResult(t, "s1-clear"), `What does "dry place" mean?`, noLive())
	if a.Status != contracts.AnswerAnswered || !strings.Contains(a.Text, "dry place") {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainLiveAPrintedPhrasePassesTheCheckAndReachesTheAnswerer(t *testing.T) {
	live, calls := deterministicLive()
	ask(t, liveResult(t, s1(t).Label, nil), `What does "dry place" mean?`, liveDeps(live))
	if calls.n() != 1 || calls.inputs[0].Intent != domain.IntentExplainText {
		t.Errorf("calls %d", calls.n())
	}
}

/* ------------------------------------------- the live answerer and usage */

type fakeExplainer struct {
	mu      sync.Mutex
	phrases []string
	reply   string
	usage   ai.Usage
	err     error
}

func (f *fakeExplainer) Explain(_ context.Context, phrase string) (string, ai.Usage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.phrases = append(f.phrases, phrase)
	return f.reply, f.usage, f.err
}

// NewLiveAnswerer is ai.AnswerQuestion over the configured explainer: the
// explainer is sent the whole printed field and its usage is charged.
func TestNewLiveAnswererSendsThePrintedFieldAndChargesTheUsage(t *testing.T) {
	ex := &fakeExplainer{reply: "Keep it in a dry place.", usage: ai.Usage{PromptTokens: 100, CompletionTokens: 20}}
	var charged ai.Usage
	deps := ExplainDeps{
		Live:                NewLiveAnswerer(ex),
		LiveBudgetExhausted: func() bool { return false },
		OnUsage:             func(u ai.Usage) { charged = charged.Add(u) },
	}
	a := ask(t, liveResult(t, s1(t).Label, nil), `What does "dry place" mean?`, deps)
	// the printed field as domain.ExplainQuote gives it
	quote := domain.ExplainQuote("dry place", s1(t).Label)
	if quote == nil || !slices.Equal(ex.phrases, []string{*quote}) || !strings.Contains(*quote, "Store below 30 degrees Celsius") {
		t.Errorf("phrases %v", ex.phrases)
	}
	if charged != ex.usage {
		t.Errorf("charged %+v", charged)
	}
	if a.Status != contracts.AnswerAnswered || !strings.Contains(a.Text, "dry place") {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestNewLiveAnswererReturnsTheContextErrorWhenTheCallIsCutOff(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ex := &fakeExplainer{err: ai.ErrRequestFailed, usage: ai.UsageEstimate}
	var charged ai.Usage
	deps := ExplainDeps{Live: NewLiveAnswerer(ex), LiveBudgetExhausted: func() bool { return false }, OnUsage: func(u ai.Usage) { charged = charged.Add(u) }}
	_, err := Explain(ctx, liveResult(t, s1(t).Label, nil), `What does "dry place" mean?`, deps)
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err %v", err)
	}
	if charged != ai.UsageEstimate {
		t.Errorf("the cut-off call was not charged: %+v", charged)
	}
}

/* ------------------------------------------- never "fake" or "counterfeit" */

func TestExplainAnAnswerSayingFakeOrCounterfeitIsReplacedByTheFixedFallback(t *testing.T) {
	adv := domain.CounterfeitAdvisorySentence
	for name, bad := range map[string]contracts.Answer{
		"in the text": {Status: contracts.AnswerAnswered, Text: "This pack is counterfeit.",
			SpokenChunks: []string{"This pack is counterfeit.", domain.FinalLine}, CitedFields: []contracts.FieldKey{"brandName"}},
		"only in a spoken chunk": {Status: contracts.AnswerAnswered, Text: "Strength as printed: 500 mg.",
			SpokenChunks: []string{"Strength as printed: 500 mg.", "It may be FAKE.", domain.FinalLine}, CitedFields: []contracts.FieldKey{"strength"}},
		"only in the safety notice": {Status: contracts.AnswerAnswered, Text: "Strength as printed: 500 mg.",
			SpokenChunks: []string{"Strength as printed: 500 mg.", domain.FinalLine}, CitedFields: []contracts.FieldKey{"strength"},
			SafetyNotice: contracts.Ptr("Watch out for fakes.")},
		"next to the fixed advisory sentence": {Status: contracts.AnswerAnswered, Text: adv + " Yours looks counterfeit.",
			SpokenChunks: []string{adv, "Yours looks counterfeit.", domain.FinalLine}, CitedFields: []contracts.FieldKey{"brandName"},
			SafetyNotice: contracts.Ptr(adv)},
	} {
		t.Run(name, func(t *testing.T) {
			live, _ := countingLive(func(context.Context, domain.AnswerInput) (contracts.Answer, ai.Usage, error) {
				return bad, ai.Usage{}, nil
			})
			a := ask(t, liveResult(t, s1(t).Label, nil), "What strength is printed here?", liveDeps(live))
			if jsonOf(t, a) != jsonOf(t, unclear(domain.AnswerFallbackText)) {
				t.Errorf("answer %s", jsonOf(t, a))
			}
			if lower := strings.ToLower(jsonOf(t, a)); strings.Contains(lower, "fake") || strings.Contains(lower, "counterfeit") {
				t.Errorf("answer %s", jsonOf(t, a))
			}
		})
	}
}

func TestMentionsFakeAllowsOnlyTheFixedSentences(t *testing.T) {
	for text, want := range map[string]bool{
		domain.CounterfeitAdvisorySentence:            false,
		domain.StatusSentence[contracts.MatchNoMatch]: false,
		"This does not mean the product is fake.":     false,
		"The product is fake.":                        true,
		"COUNTERFEIT":                                 true,
		"fakes":                                       true,
		domain.StatusSentence[contracts.MatchNoMatch] + " But it is fake.": true,
		// JS /fake|counterfeit/i without the u flag folds ASCII only: the
		// Kelvin sign is not a k
		"faKe":       false,
		"FaKe":       true,
		"":           false,
		"faking":     false,
		"Counterfei": false,
	} {
		if got := MentionsFake(text); got != want {
			t.Errorf("MentionsFake(%q) = %v", text, got)
		}
	}
	if !slices.Equal(allowedFakeSentences, []string{
		"The FDA has issued an advisory about counterfeit versions of this product.",
		"This does not mean the product is fake.",
	}) {
		t.Errorf("allowed %q", allowedFakeSentences)
	}
}

/* ------------------------------------------------------------------ budget */

func TestExplainLiveResultWithTheBudgetExhaustedIsLiveBudgetExhaustedAndTheAnswererIsNotCalled(t *testing.T) {
	live, calls := deterministicLive()
	deps := ExplainDeps{Live: live, LiveBudgetExhausted: func() bool { return true }}
	_, err := Explain(context.Background(), liveResult(t, s1(t).Label, nil), "What strength is printed here?", deps)
	wantCode(t, err, contracts.ErrLiveBudgetExhausted)
	if calls.n() != 0 {
		t.Errorf("answerer called %d times", calls.n())
	}
}

func TestExplainRefusalsAndRepeatsStillWorkWithTheBudgetExhausted(t *testing.T) {
	live, _ := deterministicLive()
	deps := ExplainDeps{Live: live, LiveBudgetExhausted: func() bool { return true }}
	r := liveResult(t, s1(t).Label, nil)
	if a := ask(t, r, "My child swallowed the whole bottle", deps); a.Text != domain.RefusalText[domain.RefusalPossibleOverdose] {
		t.Errorf("answer %s", jsonOf(t, a))
	}
	if a := ask(t, r, "Can you repeat that?", deps); a.Status != contracts.AnswerAnswered {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

func TestExplainADemoResultIsAnsweredWithTheBudgetExhausted(t *testing.T) {
	deps := ExplainDeps{LiveBudgetExhausted: func() bool { return true }}
	if a := ask(t, scenarioResult(t, "s1-clear"), "What strength is printed here?", deps); a.Status != contracts.AnswerAnswered {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

/* ------------------------------------------------- validation and errors */

func TestExplainValidatesTheQuestion(t *testing.T) {
	r := scenarioResult(t, "s1-clear")
	emoji := func(n int) string { return strings.Repeat("😀", n) }
	for _, q := range []string{"", "   ", " \t", strings.Repeat("x", 301), emoji(301), " " + emoji(301) + " ",
		strings.Repeat("x", 300) + "😀", strings.Repeat("\U00020000", 301),
	} {
		_, err := Explain(context.Background(), r, q, noLive())
		pe := wantCode(t, err, contracts.ErrValidationFailed)
		if pe.Message != `Send {"question": "..."} with 1 to 300 characters.` {
			t.Errorf("message %q", pe.Message)
		}
	}
	// zod 4.6.7 counts the trimmed question in code points, not UTF-16
	// units (task G7 review round 1): 300 are accepted, an astral character
	// counting once. Node's safety gate then refuses a question over 300
	// UTF-16 units, so these reach the gate and get its refusal, not a 400.
	for _, q := range []string{
		"  " + strings.Repeat("x", 300) + "  ", emoji(150), " " + emoji(151) + " ", emoji(300),
		strings.Repeat("x", 299) + "😀", strings.Repeat("\U00020000", 300),
	} {
		a, err := Explain(context.Background(), r, q, noLive())
		if err != nil {
			t.Errorf("%d bytes: %v", len(q), err)
			continue
		}
		if a.Status != contracts.AnswerRefused {
			t.Errorf("%d bytes: answer %s", len(q), jsonOf(t, a))
		}
	}
}

func TestValidateQuestionCountsCodePointsAfterTheTrim(t *testing.T) {
	for _, tc := range []struct {
		in, want string
		ok       bool
	}{
		{"  What strength?  ", "What strength?", true},
		{"\u3000\ufeff", "", false},
		{"\u200b", "\u200b", true},
		{strings.Repeat("😀", 151), strings.Repeat("😀", 151), true},
		{" " + strings.Repeat("😀", 300) + " ", strings.Repeat("😀", 300), true},
		{strings.Repeat("😀", 301), "", false},
		{strings.Repeat("e\u0301", 150), strings.Repeat("e\u0301", 150), true},
		{strings.Repeat("e\u0301", 151), "", false},
		// a lone surrogate reaches Go as U+FFFD (encoding/json), one code
		// point, as the lone surrogate is in zod
		{strings.Repeat("\uFFFD", 300), strings.Repeat("\uFFFD", 300), true},
		{strings.Repeat("\uFFFD", 301), "", false},
	} {
		got, err := ValidateQuestion(tc.in)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("%+q: got (%+q, %v), want (%+q, ok %v)", tc.in, got, err, tc.want, tc.ok)
		}
		if err != nil {
			wantCode(t, err, contracts.ErrValidationFailed)
		}
	}
}

func TestExplainAMalformedAnswerIsInternalError(t *testing.T) {
	for name, bad := range map[string]contracts.Answer{
		"unknown status":    {Status: "maybe"},
		"unknown cited key": {Status: contracts.AnswerAnswered, Text: "x", SpokenChunks: []string{"x"}, CitedFields: []contracts.FieldKey{"dose"}},
		"empty status":      {},
	} {
		t.Run(name, func(t *testing.T) {
			live, _ := countingLive(func(context.Context, domain.AnswerInput) (contracts.Answer, ai.Usage, error) {
				return bad, ai.Usage{}, nil
			})
			_, err := Explain(context.Background(), liveResult(t, s1(t).Label, nil), "What strength is printed here?", liveDeps(live))
			wantCode(t, err, contracts.ErrInternal)
		})
	}
}

func TestExplainALiveResultWithNoLiveAnswererIsInternalError(t *testing.T) {
	_, err := Explain(context.Background(), liveResult(t, s1(t).Label, nil), "What strength is printed here?", noLive())
	wantCode(t, err, contracts.ErrInternal)
}

/* ------------------------------------------------------ final review I2 */

func TestExplainALoosePillNonMedicineOrUnreadableResultReadsOutNoField(t *testing.T) {
	questions := append(slices.DeleteFunc(slices.Clone(domain.AllowedQuestionExamples), func(q string) bool {
		return q == "Can you repeat that?"
	}), "What is the brand name?", `What does "Paracelin" mean?`)
	for kind, text := range map[contracts.ImageKind]string{
		contracts.ImageKindLoosePill:   domain.LoosePillSentence,
		contracts.ImageKindNotMedicine: domain.NotALabelSentence,
		contracts.ImageKindUnreadable:  domain.NoLabelText,
	} {
		t.Run(string(kind), func(t *testing.T) {
			l := s1(t).Label
			l.ImageKind = kind
			r := liveResult(t, l, nil)
			if len(r.Label.Fields) == 0 {
				t.Fatal("no fields")
			}
			for _, f := range r.Label.Fields {
				if f.Value != nil {
					t.Fatalf("field %s kept a value", f.Key)
				}
			}
			live, calls := deterministicLive()
			for _, q := range questions {
				if a := ask(t, r, q, liveDeps(live)); jsonOf(t, a) != jsonOf(t, unclear(text)) {
					t.Errorf("%q: %s", q, jsonOf(t, a))
				}
			}
			if calls.n() != 0 {
				t.Errorf("answerer called %d times", calls.n())
			}
		})
	}
}

func TestExplainS6WhichPartsWereUnclearNeverSaysOnThePack(t *testing.T) {
	a := ask(t, scenarioResult(t, "s6-loose-pill"), "Which parts were unclear?", noLive())
	if a.Status != contracts.AnswerUnclear || a.Text != domain.LoosePillSentence {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

/* ---------------------------------------------------- final review Minor 3 */

func TestExplainRepeatReplaysPrintedCounterfeitTextVerbatim(t *testing.T) {
	l := s1(t).Label
	for i := range l.Fields {
		if l.Fields[i].Key == contracts.FieldWarnings {
			l.Fields[i].Value = contracts.Ptr("Beware of counterfeit products. Keep out of reach of children.")
		}
	}
	r := liveResult(t, l, nil)
	if !strings.Contains(r.Explanation.DisplayText, "Beware of counterfeit products.") {
		t.Fatalf("display %q", r.Explanation.DisplayText)
	}
	live, _ := deterministicLive()
	a := ask(t, r, "Can you repeat that?", liveDeps(live))
	if a.Status != contracts.AnswerAnswered || a.Text != r.Explanation.DisplayText || !slices.Equal(a.SpokenChunks, r.Explanation.SpokenChunks) {
		t.Errorf("answer %s", jsonOf(t, a))
	}
}

/* --------------------------------------------------- final review Minor 34 */

func TestExplainForAllEightDemoScenarios(t *testing.T) {
	answered := func(first string) func(*testing.T, contracts.Answer) {
		return func(t *testing.T, a contracts.Answer) {
			if a.Status != contracts.AnswerAnswered || a.SpokenChunks[0] != first || a.SpokenChunks[len(a.SpokenChunks)-1] != domain.FinalLine {
				t.Errorf("answer %s", jsonOf(t, a))
			}
		}
	}
	isUnclear := func(text string) func(*testing.T, contracts.Answer) {
		return func(t *testing.T, a contracts.Answer) {
			if jsonOf(t, a) != jsonOf(t, unclear(text)) {
				t.Errorf("answer %s", jsonOf(t, a))
			}
		}
	}
	table := []struct {
		id, q string
		check func(*testing.T, contracts.Answer)
	}{
		{"s1-clear", "What strength is printed here?", answered("Strength as printed: 500 mg.")},
		{"s2-blurry", "Can you read this label?", isUnclear(domain.NoLabelText)},
		{"s3-similar", "What is the brand name?", func(t *testing.T, a contracts.Answer) {
			answered("Brand name as printed, partly unclear: Paracel.")(t, a)
			if !slices.Equal(a.CitedFields, []contracts.FieldKey{"brandName"}) {
				t.Errorf("cited %v", a.CitedFields)
			}
		}},
		{"s3-similar", "What did the FDA registry say?", answered(domain.StatusSentence[contracts.MatchAmbiguous])},
		{"s4-conflict", "What strength is printed here?", func(t *testing.T, a contracts.Answer) {
			answered("Strength as printed: 500 mg.")(t, a)
			if !slices.Contains(a.SpokenChunks, domain.ConflictWarning(contracts.FieldStrength, "250 mg Tablet")) {
				t.Errorf("chunks %v", a.SpokenChunks)
			}
		}},
		{"s4-conflict", "What did the FDA registry say?", answered("The strength on the label does not match the registry.")},
		{"s5-nomatch", "What did the FDA registry say?", answered(domain.StatusSentence[contracts.MatchNoMatch])},
		{"s6-loose-pill", "Can you read this label?", isUnclear(domain.LoosePillSentence)},
		{"s7-unsupported-question", "How many should I take for my headache?", func(t *testing.T, a contracts.Answer) {
			if a.Status != contracts.AnswerRefused || a.Text != domain.RefusalText[domain.RefusalPersonalDose] {
				t.Errorf("answer %s", jsonOf(t, a))
			}
		}},
		{"s7-unsupported-question", "Who makes this medicine?", answered("Manufacturer as printed: Demo Pharma Labs.")},
		{"s8-registry-down", "What did the FDA registry say?", answered(domain.StatusSentence[contracts.MatchUnavailable])},
		{"s8-registry-down", "What is the expiry date on the pack?", answered("Expiry date as printed: 05/2028.")},
	}
	var covered []string
	for _, row := range table {
		if !slices.Contains(covered, row.id) {
			covered = append(covered, row.id)
		}
		t.Run(row.id+" "+row.q, func(t *testing.T) {
			row.check(t, ask(t, scenarioResult(t, row.id), row.q, noLive()))
		})
	}
	if !slices.Equal(covered, scenarioIDs) {
		t.Errorf("covered %v", covered)
	}
	for _, id := range scenarioIDs {
		r := scenarioResult(t, id)
		for _, q := range domain.AllowedQuestionExamples {
			a := ask(t, r, q, noLive())
			if a.Status == contracts.AnswerRefused || a.SpokenChunks[len(a.SpokenChunks)-1] != domain.FinalLine {
				t.Errorf("%s %q: %s", id, q, jsonOf(t, a))
			}
			for _, s := range append([]string{a.Text}, a.SpokenChunks...) {
				if MentionsFake(s) {
					t.Errorf("%s %q says fake: %q", id, q, s)
				}
			}
		}
	}
}
