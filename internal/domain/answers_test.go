package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/parity"
)

// TestAnswersParity replays every recorded TS call in fixtures/parity/answers.jsonl.
func TestAnswersParity(t *testing.T) {
	cases := parity.Load(t, "answers.jsonl")
	requireFns(t, cases, "answerFromLabel", "composeExplainAnswer", "conflictWarning", "explainQuote",
		"explanationAllowed", "explanationFits", "findPhraseInFields", "notALabelAnswer",
		"quoteExplainable", "unclearAnswer")
	checkCases(t, cases, runSummaryAnswerCase)
}

// TestAnswersUnicodeProbes replays the V8 outputs recorded by
// scripts/parity/go-probes-answers.ts: phrase lookup under case folding
// (Kelvin sign, long s, final sigma, ypogegrammeni, dotted and dotless i,
// sharp s, Deseret), NFKC forms and format characters in the explanation
// gate, and read-backs and summaries of long values with astral characters.
func TestAnswersUnicodeProbes(t *testing.T) {
	cases := loadTestdata(t, "answers_unicode.jsonl")
	requireFns(t, cases, "findPhraseInFields", "explainQuote", "composeExplainAnswer", "explanationAllowed",
		"explanationFits", "quoteExplainable", "answerFromLabel", "buildSummary")
	checkCases(t, cases, runSummaryAnswerCase)
}

type caseFoldTables struct {
	Note       string           `json:"note"`
	Node       string           `json:"node"`
	Unicode    string           `json:"unicode"`
	LNFold     [][2]int         `json:"lnFold"`
	Candidates int              `json:"candidates"`
	Fold       map[string][]int `json:"fold"`
}

// TestCaseFoldTables checks, for every code point, the two `iu` RegExp
// behaviours locate (answers.ts) relies on against V8: which code points a
// /^\u{c}$/iu literal matches besides c, and which ones /^[\p{L}\p{N}]$/iu
// matches.
func TestCaseFoldTables(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "answers_casefold.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tables caseFoldTables
	if err := json.Unmarshal(raw, &tables); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(unicode.Version, tables.Unicode) {
		t.Errorf("Node (%s) has Unicode %s, Go has %s", tables.Node, tables.Unicode, unicode.Version)
	}
	if len(tables.Fold) < 1000 {
		t.Fatalf("only %d fold classes recorded", len(tables.Fold))
	}
	bad := map[string]int{}
	for cp := 0; cp <= 0x10FFFF; cp++ {
		if cp >= 0xD800 && cp <= 0xDFFF {
			continue
		}
		r := rune(cp)
		if got, want := isLNFold(r), inRanges(tables.LNFold, cp); got != want {
			bad["lnFold"]++
			if bad["lnFold"] <= 3 {
				t.Errorf("[\\p{L}\\p{N}]/iu on U+%04X: Go %v, JS %v", cp, got, want)
			}
		}
		var got []int
		for o := unicode.SimpleFold(r); o != r; o = unicode.SimpleFold(o) {
			got = append(got, int(o))
		}
		slices.Sort(got)
		want := tables.Fold[strconv.FormatInt(int64(cp), 16)]
		if !slices.Equal(got, want) {
			bad["fold"]++
			if bad["fold"] <= 3 {
				t.Errorf("/^\\u{%x}$/iu: Go folds with %x, JS with %x", cp, got, want)
			}
		}
		for _, o := range want {
			if !foldEqual(r, rune(o)) {
				bad["foldEqual"]++
				if bad["foldEqual"] <= 3 {
					t.Errorf("foldEqual(U+%04X, U+%04X) = false", cp, o)
				}
			}
		}
	}
	for name, n := range bad {
		t.Errorf("%s: %d code points differ", name, n)
	}
}

/* ------------------------------------------------------------ units */

func TestExplanationWordsArePinned(t *testing.T) {
	want := []string{
		"a", "an", "and", "bottle", "closed", "container", "cool", "dark", "dry", "first", "gently",
		"in", "it", "its", "keep", "lid", "means", "or", "place", "shake", "shut", "somewhere",
		"store", "the", "this", "tightly", "well",
	}
	if !slices.Equal(ExplanationWords(), want) {
		t.Errorf("vocabulary drifted:\n got %q\nwant %q", ExplanationWords(), want)
	}
}

func TestExplanationAllowedRejectsOutsideTheVocabulary(t *testing.T) {
	for _, w := range []string{"friend", "okay", "with", "use", "for", "as", "is", "not", "need", "no", "you"} {
		if ExplanationAllowed("Keep it in a cool place " + w + ".") {
			t.Errorf("accepted %q", w)
		}
	}
	for _, s := range []string{
		"Keep it somewhere that is not hot or damp.",
		"Keep it away from heat and light.",
		"You need a prescription from a doctor.",
		"Shake the bottle well first.",
	} {
		if !ExplanationAllowed(s) {
			t.Errorf("rejected %q", s)
		}
	}
	for _, s := range []string{"It may be fake.", "Store it, counterfeits aside.", "See www.example.com", "Keep it 2 days."} {
		if ExplanationAllowed(s) {
			t.Errorf("accepted %q", s)
		}
	}
}

func labelOf(kind contracts.ImageKind, fields ...contracts.LabelField) contracts.ExtractedLabel {
	return contracts.ExtractedLabel{ImageKind: kind, Fields: fields}
}

// A scan that is not a readable pack answers with a fixed sentence, never a
// field value (final review I2); an image kind outside the schema is treated
// as unreadable, never as a label.
func TestNotALabelNeverReadsFields(t *testing.T) {
	strength := clearField(contracts.FieldStrength, "500 mg")
	for _, tc := range []struct {
		kind contracts.ImageKind
		want string
	}{
		{contracts.ImageKindLoosePill, LoosePillSentence},
		{contracts.ImageKindNotMedicine, NotALabelSentence},
		{contracts.ImageKindUnreadable, NoLabelText},
		{"selfie", NoLabelText},
	} {
		in := AnswerInput{
			Label:    labelOf(tc.kind, strength),
			Match:    contracts.MatchAssessment{Status: contracts.MatchNotAttempted},
			Question: "What strength is printed here?",
			Intent:   IntentStrength,
		}
		for _, a := range []contracts.Answer{
			AnswerFromLabel(in),
			ComposeExplainAnswer(in, "500 mg", nil),
		} {
			if a.Status != contracts.AnswerUnclear || a.Text != tc.want || len(a.CitedFields) != 0 {
				t.Errorf("%s: %+v", tc.kind, a)
			}
		}
	}
	if NotALabelAnswer(labelOf(contracts.ImageKindLabel)) != nil {
		t.Error("a label is not a non-label")
	}
}

func TestAnswerArraysNeverNull(t *testing.T) {
	a := UnclearAnswer(AnswerFallbackText)
	b, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"status":"unclear","text":"I can only answer from what is printed on the label.",` +
		`"spokenChunks":["I can only answer from what is printed on the label.","Confirm with your pharmacist or doctor."],` +
		`"citedFields":[],"safetyNotice":null}`
	if string(b) != want {
		t.Errorf("\n got %s\nwant %s", b, want)
	}
	hits := FindPhraseInFields("nowhere", labelOf(contracts.ImageKindLabel, clearField(contracts.FieldStrength, "500 mg")))
	if hits == nil || len(hits) != 0 {
		t.Errorf("no hit: got %#v, want an empty non-nil slice", hits)
	}
	if b, _ := json.Marshal(hits); string(b) != "[]" {
		t.Errorf("no hit encodes as %s", b)
	}
}

// TestComposeExplainAnswerMarksPartlyUnclear: the quote of a partly
// legible field carries the marker inline (ea97cd6).
func TestComposeExplainAnswerMarksPartlyUnclear(t *testing.T) {
	v := "Store in a cool dry place"
	in := AnswerInput{
		Label:    labelOf(contracts.ImageKindLabel, contracts.LabelField{Key: contracts.FieldStorage, Value: &v, Legibility: contracts.LegibilityPartial}),
		Match:    contracts.MatchAssessment{Status: contracts.MatchNotAttempted},
		Question: `What does "cool dry place" mean?`,
		Intent:   IntentExplainText,
	}
	a := ComposeExplainAnswer(in, "cool dry place", contracts.Ptr("Keep it somewhere cool and dry."))
	want := `The storage on the label, partly unclear, says "Store in a cool dry place". In plain words: Keep it somewhere cool and dry. Some of this was not clear on the pack, so it may be wrong.`
	if a.Text != want {
		t.Errorf("\n got %q\nwant %q", a.Text, want)
	}
}

// TestAnswerRegexpSourcesAreTheTSOnes checks that every pattern answers.go
// compiles from a TS source is exactly a source V8 ran with the flags the
// TS file gives it (recorded by scripts/parity/go-probes-answers.ts), so a
// hand copy cannot drift from answers.ts.
func TestAnswerRegexpSourcesAreTheTSOnes(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "answers_regexps.json"))
	if err != nil {
		t.Fatal(err)
	}
	var recorded struct {
		Note    string `json:"note"`
		Regexps []struct {
			Source string `json:"source"`
			Flags  string `json:"flags"`
		} `json:"regexps"`
	}
	if err := json.Unmarshal(raw, &recorded); err != nil {
		t.Fatal(err)
	}
	ran := map[string]bool{}
	for _, r := range recorded.Regexps {
		ran[r.Flags+"/"+r.Source] = true
	}
	want := map[string]string{ // source -> flags
		notExplained.Source(): "",
		fake.Source():         "",
		urlOrAt.Source():      "",
		outsideA.Source():     "",
	}
	for _, tp := range vocabTopics {
		want[tp.cue.Source()] = ""
		for _, p := range tp.phrases {
			want[p.Source()] = "g"
		}
	}
	if len(want) != 10 {
		t.Errorf("checked %d patterns, want 10", len(want))
	}
	for source, flags := range want {
		if !ran[flags+"/"+source] {
			t.Errorf("V8 never ran /%s/%s: the Go source differs from answers.ts", source, flags)
		}
	}
}
