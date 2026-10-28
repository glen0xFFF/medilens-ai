package domain

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/parity"
)

// decodeStrict decodes a recorded argument into v, failing on a field the
// Go type does not have, so an input shape drift cannot pass unnoticed.
func decodeStrict(t *testing.T, raw json.RawMessage, v any) {
	t.Helper()
	if parity.IsUndefined(raw) {
		t.Fatalf("undefined argument is not supported: %s", raw)
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("decode %T from %s: %v", v, raw, err)
	}
}

// runSummaryAnswerCase calls the Go port of c.Fn (summary.ts or answers.ts)
// and returns its result as JSON.
func runSummaryAnswerCase(t *testing.T, c parity.Case) []byte {
	t.Helper()
	arg := func(i int, v any) {
		t.Helper()
		if i >= len(c.Args) {
			t.Fatalf("%s: no argument %d in %s", c.Fn, i, c.Args)
		}
		decodeStrict(t, c.Args[i], v)
	}
	var result any
	switch c.Fn {
	case "buildSummary":
		var in SummaryInput
		arg(0, &in)
		result = BuildSummary(in)
	case "advisorySentence":
		var advisories []contracts.Advisory
		arg(0, &advisories)
		result = AdvisorySentence(advisories)
	case "verificationSentences":
		var m contracts.MatchAssessment
		arg(0, &m)
		result = VerificationSentences(m)
	case "answerFromLabel":
		var in AnswerInput
		arg(0, &in)
		result = AnswerFromLabel(in)
	case "composeExplainAnswer":
		var in AnswerInput
		var phrase string
		var explanation *string
		arg(0, &in)
		arg(1, &phrase)
		arg(2, &explanation)
		result = ComposeExplainAnswer(in, phrase, explanation)
	case "conflictWarning":
		var key contracts.FieldKey
		var ref string
		arg(0, &key)
		arg(1, &ref)
		result = ConflictWarning(key, ref)
	case "explainQuote":
		var phrase string
		var label contracts.ExtractedLabel
		arg(0, &phrase)
		arg(1, &label)
		result = ExplainQuote(phrase, label)
	case "explanationAllowed":
		var text string
		arg(0, &text)
		result = ExplanationAllowed(text)
	case "explanationFits":
		var explanation, printed string
		arg(0, &explanation)
		arg(1, &printed)
		result = ExplanationFits(explanation, printed)
	case "findPhraseInFields":
		var phrase string
		var label contracts.ExtractedLabel
		arg(0, &phrase)
		arg(1, &label)
		result = FindPhraseInFields(phrase, label)
	case "notALabelAnswer":
		var label contracts.ExtractedLabel
		arg(0, &label)
		result = NotALabelAnswer(label)
	case "quoteExplainable":
		var printed string
		arg(0, &printed)
		result = QuoteExplainable(printed)
	case "unclearAnswer":
		var text string
		arg(0, &text)
		result = UnclearAnswer(text)
	default:
		t.Fatalf("unknown fn %q", c.Fn)
	}
	out, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("%s: marshal: %v", c.Fn, err)
	}
	return out
}

func requireFns(t *testing.T, cases []parity.Case, fns ...string) {
	t.Helper()
	seen := map[string]int{}
	for _, c := range cases {
		seen[c.Fn]++
	}
	for _, fn := range fns {
		if seen[fn] == 0 {
			t.Errorf("corpus has no %s cases", fn)
		}
	}
	t.Logf("cases: %v", seen)
}

// TestSummaryParity replays every recorded TS call in fixtures/parity/summary.jsonl.
func TestSummaryParity(t *testing.T) {
	cases := parity.Load(t, "summary.jsonl")
	requireFns(t, cases, "buildSummary", "advisorySentence", "verificationSentences")
	checkCases(t, cases, runSummaryAnswerCase)
}

/* ------------------------------------------------------------ units */

func TestBuildSummaryArraysNeverNull(t *testing.T) {
	e := BuildSummary(SummaryInput{
		Label:         nil,
		Match:         contracts.MatchAssessment{Status: contracts.MatchNotAttempted},
		PipelineState: contracts.PipelineLabelUnreadable,
	})
	b, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"displayText":"I couldn't read this label. Please take another photo.\nConfirm with your pharmacist or doctor.",` +
		`"spokenChunks":["I couldn't read this label. Please take another photo.","Confirm with your pharmacist or doctor."],` +
		`"safetyNotices":["Confirm with your pharmacist or doctor."],"supportingFields":[]}`
	if string(b) != want {
		t.Errorf("\n got %s\nwant %s", b, want)
	}
}

func TestAdvisorySentenceCounterfeitOnlyFromTheTitle(t *testing.T) {
	if s := AdvisorySentence(nil); s != nil {
		t.Errorf("no advisory: got %q", *s)
	}
	for _, tc := range []struct {
		titles []string
		want   string
	}{
		{[]string{"Recall of DEMO lot 12"}, NeutralAdvisorySentence},
		{[]string{"Recall", "Public warning against COUNTERFEIT DemoCap"}, CounterfeitAdvisorySentence},
		{[]string{"Unregistered product: DemoCap"}, NeutralAdvisorySentence},
	} {
		var as []contracts.Advisory
		for _, title := range tc.titles {
			as = append(as, contracts.Advisory{Title: title, URL: "https://verification.fda.gov.ph/demo"})
		}
		got := AdvisorySentence(as)
		if got == nil || *got != tc.want {
			t.Errorf("%v: got %v, want %q", tc.titles, got, tc.want)
		}
	}
	if strings.Contains(NeutralAdvisorySentence, "counterfeit") || strings.Contains(NeutralAdvisorySentence, "fake") {
		t.Error("the neutral advisory sentence says counterfeit or fake")
	}
}

func TestChunkSpeech(t *testing.T) {
	sentence := "Keep this medicine out of the reach of children and store below thirty degrees."
	long := strings.TrimSpace(strings.Repeat(sentence+" ", 15))

	words := make([]string, 120)
	for i := range words {
		words[i] = "word" + strconv.Itoa(i)
	}

	for _, tc := range []struct {
		name string
		in   string
		want []string
	}{
		{"empty", "", []string{}},
		{"blank", " \t\u00a0\n ", []string{}},
		{"short, whitespace collapsed", "  Take\t2.5 mL\u00a0 daily.  ", []string{"Take 2.5 mL daily."}},
		{"exactly 400", strings.Repeat("a", 400), []string{strings.Repeat("a", 400)}},
		{"401 unbroken is hard-cut", strings.Repeat("a", 401), []string{strings.Repeat("a", 400), "a"}},
		{"sentences pack up to 400", long, []string{
			strings.TrimSpace(strings.Repeat(sentence+" ", 5)),
			strings.TrimSpace(strings.Repeat(sentence+" ", 5)),
			strings.TrimSpace(strings.Repeat(sentence+" ", 5)),
		}},
		{"a decimal point is not a sentence end", strings.Repeat("x", 395) + " 2.5 mL. Next", []string{strings.Repeat("x", 395) + " 2.5", "mL. Next"}},
		{"astral characters count two units", strings.Repeat("\U0001F48A", 200) + " a", []string{strings.Repeat("\U0001F48A", 200), "a"}},
	} {
		got := ChunkSpeech(tc.in)
		if got == nil {
			t.Errorf("%s: nil, want a non-nil slice", tc.name)
			continue
		}
		if strings.Join(got, "\x00") != strings.Join(tc.want, "\x00") || len(got) != len(tc.want) {
			t.Errorf("%s:\n got %q\nwant %q", tc.name, got, tc.want)
		}
		for _, c := range got {
			if jsLen(c) > 400 || c == "" {
				t.Errorf("%s: chunk of %d units", tc.name, jsLen(c))
			}
		}
	}

	got := ChunkSpeech(strings.Join(words, " "))
	if !strings.Contains(strings.Join(got, " "), "word119") || len(got) < 2 {
		t.Errorf("a long single sentence is split at words: %q", got)
	}
	for _, c := range got {
		if jsLen(c) > 400 {
			t.Errorf("chunk of %d units", jsLen(c))
		}
	}
}

// TestPartlyUnclearMarkerOnEveryChunk: no part of a partly unclear dose is
// ever read as certain (final review I1).
func TestPartlyUnclearMarkerOnEveryChunk(t *testing.T) {
	var steps []string
	for i := 1; i <= 12; i++ {
		steps = append(steps, "Step "+strconv.Itoa(i)+": shake well and take 2.5 mL using the cup provided.")
	}
	directions := strings.Join(steps, " ")
	label := &contracts.ExtractedLabel{ImageKind: contracts.ImageKindLabel, Fields: []contracts.LabelField{
		clearField(contracts.FieldBrandName, "Fevrinol"),
		{Key: contracts.FieldDirections, Value: &directions, Legibility: contracts.LegibilityPartial},
	}}
	e := BuildSummary(SummaryInput{
		Label:         label,
		Match:         contracts.MatchAssessment{Status: contracts.MatchNotAttempted},
		PipelineState: contracts.PipelineExplanationReady,
	})
	carrying := 0
	for _, c := range e.SpokenChunks {
		if !strings.Contains(c, "Step ") {
			continue
		}
		carrying++
		if !strings.HasPrefix(c, "Directions as printed, partly unclear: ") && !strings.HasPrefix(c, "Directions continued, partly unclear: ") {
			t.Errorf("chunk without the marker: %q", c)
		}
		if jsLen(c) > 400 {
			t.Errorf("chunk of %d units", jsLen(c))
		}
	}
	if carrying < 2 {
		t.Errorf("want the value split over several chunks, got %d", carrying)
	}
}
