package domain

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/jsregex"
	"github.com/medilens-ai/medilens/internal/parity"
)

// runSafetyCase calls the Go port of c.Fn and returns its result as JSON.
func runSafetyCase(t *testing.T, c parity.Case) []byte {
	t.Helper()
	if len(c.Args) != 1 || parity.IsUndefined(c.Args[0]) {
		t.Fatalf("%s: want one string argument, got %s", c.Fn, c.Args)
	}
	var q string
	mustDecode(t, c.Args[0], &q)
	var result any
	switch c.Fn {
	case "classifyQuestion":
		result = ClassifyQuestion(q)
	case "extractExplainPhrase":
		result = ExtractExplainPhrase(q)
	case "askedFields":
		result = AskedFields(q)
	default:
		t.Fatalf("unknown fn %q", c.Fn)
	}
	out, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("%s: marshal: %v", c.Fn, err)
	}
	return out
}

func checkCases(t *testing.T, cases []parity.Case, run func(*testing.T, parity.Case) []byte) {
	t.Helper()
	failed := 0
	for i, c := range cases {
		got, err := parity.Normalize(run(t, c))
		if err != nil {
			t.Fatalf("case %d: normalize got: %v", i, err)
		}
		want, err := parity.Normalize(c.Result)
		if err != nil {
			t.Fatalf("case %d: normalize want: %v", i, err)
		}
		if !bytes.Equal(got, want) {
			failed++
			if failed <= 50 {
				args, _ := json.Marshal(c.Args)
				t.Errorf("case %d %s(%s):\n got  %s\n want %s", i, c.Fn, args, got, want)
			}
		}
	}
	if failed > 0 {
		t.Errorf("%d of %d cases differ", failed, len(cases))
	}
}

func loadTestdata(t *testing.T, name string) []parity.Case {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cases, err := parity.Parse(f)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return cases
}

// TestSafetyParity replays every recorded TS call in fixtures/parity/safety.jsonl.
func TestSafetyParity(t *testing.T) {
	cases := parity.Load(t, "safety.jsonl")
	seen := map[string]int{}
	for _, c := range cases {
		seen[c.Fn]++
	}
	for _, fn := range []string{"classifyQuestion", "extractExplainPhrase", "askedFields"} {
		if seen[fn] == 0 {
			t.Errorf("corpus has no %s cases", fn)
		}
	}
	checkCases(t, cases, runSafetyCase)
}

// TestSafetyAdversarial is the differential probe beyond the corpus: seeded
// variants of every corpus question (casing, Unicode confusables, zero-width
// and format characters, whitespace, punctuation, digits, long inputs
// around the 300 code-unit limit), with V8's answers recorded by
// scripts/parity/go-probes.ts.
func TestSafetyAdversarial(t *testing.T) {
	cases := loadTestdata(t, "safety_adversarial.jsonl")
	if len(cases) < 15000 {
		t.Fatalf("only %d adversarial cases", len(cases))
	}
	checkCases(t, cases, runSafetyCase)
}

type recordedRegexps struct {
	Note     string   `json:"note"`
	Texts    []string `json:"texts"`
	Patterns []struct {
		Source      string `json:"source"`
		Constructed bool   `json:"constructed"`
		Test        string `json:"test"`
	} `json:"patterns"`
	Exec []struct {
		Source  string `json:"source"`
		Results []*struct {
			Index  int       `json:"index"`
			Groups []*string `json:"groups"`
		} `json:"results"`
	} `json:"exec"`
}

func loadRecordedRegexps(t *testing.T) recordedRegexps {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "safety_regexps.json"))
	if err != nil {
		t.Fatal(err)
	}
	var r recordedRegexps
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		t.Fatal(err)
	}
	return r
}

func bit(hex string, i int) bool {
	c := hex[i/4]
	var nibble byte
	switch {
	case c >= '0' && c <= '9':
		nibble = c - '0'
	default:
		nibble = c - 'a' + 10
	}
	return nibble&(8>>(i%4)) != 0
}

// TestSafetyRegexpSources: the Go safety gate runs exactly the RegExps the
// TS module runs (every literal and every `new RegExp(...)`, captured from
// V8 while the corpus and adversarial questions were classified), so no
// pattern was dropped, added or mistyped in the port.
func TestSafetyRegexpSources(t *testing.T) {
	rec := loadRecordedRegexps(t)
	want := map[string]bool{}
	for _, p := range rec.Patterns {
		want[p.Source] = true
	}
	got := map[string]bool{}
	for _, p := range safetyPatterns {
		got[p.re.Source()] = true
	}
	var missing, extra []string
	for s := range want {
		if !got[s] {
			missing = append(missing, s)
		}
	}
	for s := range got {
		if !want[s] {
			extra = append(extra, s)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	for _, s := range missing {
		t.Errorf("TS pattern not in the Go port: /%s/", s)
	}
	for _, s := range extra {
		t.Errorf("Go pattern the TS module never ran: /%s/", s)
	}
	if len(want) < 300 {
		t.Errorf("only %d recorded patterns", len(want))
	}
}

// TestSafetyRegexpMatrix is one dedicated test per safety RegExp (each
// lookaround pattern included): the Go matcher's test() must equal V8's on
// every text any safety pattern saw (normalised questions and extracted
// phrases), and exec() must agree on index and every capture.
func TestSafetyRegexpMatrix(t *testing.T) {
	rec := loadRecordedRegexps(t)
	inputs := make([]jsregex.Input, len(rec.Texts))
	for i, s := range rec.Texts {
		inputs[i] = jsregex.NewInput(s)
	}
	byName := map[string]string{}
	for _, p := range safetyPatterns {
		byName[p.re.Source()] = p.name
	}
	for _, p := range rec.Patterns {
		name := byName[p.Source]
		if name == "" {
			name = "unported"
		}
		t.Run(name, func(t *testing.T) {
			re, err := jsregex.Compile(p.Source)
			if err != nil {
				t.Fatal(err)
			}
			bad := 0
			for i, in := range inputs {
				if re.TestInput(in) != bit(p.Test, i) {
					bad++
					if bad <= 5 {
						t.Errorf("/%s/.test(%q): Go %v, V8 %v", p.Source, rec.Texts[i], !bit(p.Test, i), bit(p.Test, i))
					}
				}
			}
			if bad > 0 {
				t.Errorf("%d of %d texts differ", bad, len(inputs))
			}
		})
	}
	for _, e := range rec.Exec {
		re := jsregex.MustCompile(e.Source)
		for i, in := range inputs {
			m := re.ExecInput(in)
			w := e.Results[i]
			if (m == nil) != (w == nil) {
				t.Fatalf("/%s/.exec(%q): Go match %v, V8 %v", e.Source, rec.Texts[i], m != nil, w != nil)
			}
			if m == nil {
				continue
			}
			if m.Index != w.Index || m.NumGroups() != len(w.Groups) {
				t.Fatalf("/%s/.exec(%q): index/groups differ", e.Source, rec.Texts[i])
			}
			for g, want := range w.Groups {
				got, ok := m.Group(g)
				if ok != (want != nil) || (ok && got != *want) {
					t.Fatalf("/%s/.exec(%q) group %d differs", e.Source, rec.Texts[i], g)
				}
			}
		}
	}
}

// Every pattern with a lookaround is listed in the task report; this keeps
// the list honest (MEDILENS_LIST_LOOKAROUND=1 go test -run TestListLookaround -v).
func TestListLookaround(t *testing.T) {
	n := 0
	for _, p := range safetyPatterns {
		src := p.re.Source()
		var kinds []string
		for _, k := range []string{"(?<!", "(?<=", "(?!", "(?="} {
			if strings.Contains(src, k) {
				kinds = append(kinds, k)
			}
		}
		if len(kinds) == 0 {
			continue
		}
		n++
		if os.Getenv("MEDILENS_LIST_LOOKAROUND") == "1" {
			t.Logf("| %s | %s |", p.name, strings.Join(kinds, " "))
		}
	}
	if n == 0 {
		t.Fatal("no lookaround patterns found")
	}
	t.Logf("%d of %d safety patterns use lookaround", n, len(safetyPatterns))
}

func TestRefusalText(t *testing.T) {
	want := map[RefusalReason]string{
		"personal_dose":       "I can't tell you how much to take. I can only read what is printed on the label. If someone has already taken too much, call 911. Please ask a pharmacist or your doctor.",
		"start_stop":          "I can't advise you to start, stop or change a medicine. Please ask a pharmacist or your doctor.",
		"diagnosis":           "I can't diagnose symptoms or say whether this medicine treats them. Please ask a pharmacist or your doctor.",
		"special_population":  "I can't say whether this medicine is suitable for children, older people, or during pregnancy or breastfeeding. If someone has already taken too much, call 911. Please ask a pharmacist or your doctor.",
		"interaction":         "I can't check whether this medicine is safe to take with other medicines, food or alcohol. If someone has already taken too much, call 911. Please ask a pharmacist or your doctor.",
		"personal_safety":     "I can't say whether this medicine is safe for you. If someone has already taken too much, call 911. Please ask a pharmacist or your doctor.",
		"pill_identification": "I can't identify a medicine from how a pill looks. Please ask a pharmacist or your doctor.",
		"possible_overdose":   "If someone may have taken too much of this medicine, call 911 or go to the nearest emergency room now.",
		"outside_label":       "I can only read and explain what is printed on this label. For questions about whether or how to take it, please ask a pharmacist or your doctor.",
	}
	if len(RefusalText) != len(want) {
		t.Fatalf("RefusalText has %d reasons, want %d", len(RefusalText), len(want))
	}
	for reason, text := range want {
		if RefusalText[reason] != text {
			t.Errorf("RefusalText[%s] = %q, want %q", reason, RefusalText[reason], text)
		}
	}
	for _, text := range RefusalText {
		lower := strings.ToLower(text)
		if strings.Contains(lower, "fake") || strings.Contains(lower, "counterfeit") {
			t.Errorf("refusal text says fake or counterfeit: %q", text)
		}
	}
}

func TestAllowedQuestionExamples(t *testing.T) {
	want := []string{
		"Can you read this label?",
		"What does this warning mean?",
		"What strength is printed here?",
		"Explain the directions in simpler words.",
		"Which parts were unclear?",
		"What did the FDA registry say?",
		"Who makes this medicine?",
		"What is the expiry date on the pack?",
		"How should it be stored?",
		"Can you repeat that?",
	}
	if !slices.Equal(AllowedQuestionExamples, want) {
		t.Fatalf("AllowedQuestionExamples = %q", AllowedQuestionExamples)
	}
	for _, q := range AllowedQuestionExamples {
		if c := ClassifyQuestion(q); !c.Allowed {
			t.Errorf("preset %q refused: %s", q, c.Reason)
		}
	}
}

// QuestionClass encodes as the TS union: {allowed:true,intent} or
// {allowed:false,reason}, never both keys.
func TestQuestionClassJSON(t *testing.T) {
	for _, tc := range []struct {
		c    QuestionClass
		want string
	}{
		{QuestionClass{Allowed: true, Intent: "read_label"}, `{"allowed":true,"intent":"read_label"}`},
		{QuestionClass{Allowed: false, Reason: "outside_label"}, `{"allowed":false,"reason":"outside_label"}`},
	} {
		got, err := json.Marshal(tc.c)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tc.want {
			t.Errorf("got %s, want %s", got, tc.want)
		}
	}
}

// Default-deny holds at the edges: nothing that is not a whole-question
// template match is allowed, and the length limit is in UTF-16 code units.
func TestClassifyEdges(t *testing.T) {
	refuse := func(q string, reason RefusalReason) {
		t.Helper()
		if c := ClassifyQuestion(q); c.Allowed || c.Reason != reason {
			t.Errorf("ClassifyQuestion(%q) = %+v, want refused %s", q, c, reason)
		}
	}
	refuse("", "outside_label")
	refuse("​­", "outside_label")
	refuse(" ?!. ", "outside_label")
	at300 := "How many should I take" + strings.Repeat(" x", 139)
	if jsregex.Len(at300) != 300 {
		t.Fatalf("len %d", jsregex.Len(at300))
	}
	refuse(at300, "personal_dose")
	refuse(at300+"x", "outside_label")
	// 299 code units plus one astral character is 301 code units
	refuse(strings.Repeat("x", 299)+"😀", "outside_label")
	refuse("Can you read this label? 🙂", "outside_label")
	refuse("Cаn you read this label?", "outside_label") // Cyrillic а
	refuse("my baby swallowed some 🙂", "possible_overdose")
	refuse("Is this fake?", "outside_label")
	if c := ClassifyQuestion("ＣＡＮ ＹＯＵ ＲＥＡＤ ＴＨＩＳ ＬＡＢＥＬ？"); !c.Allowed || c.Intent != "read_label" {
		t.Errorf("fullwidth preset: %+v", c)
	}
	if c := ClassifyQuestion("can you read​ this label?"); !c.Allowed {
		t.Errorf("zero-width space not stripped: %+v", c)
	}
	if c := ClassifyQuestion("is it s​afe?"); c.Allowed {
		t.Errorf("a zero-width space hid a refusal word: %+v", c)
	}
}

func TestExtractExplainPhrase(t *testing.T) {
	for q, want := range map[string]string{
		"What does fake mean?":                                   "fake",
		`What does "you can take as many as you need" mean?`:     "you can take as many as you need",
		"What does the word 'non-drowsy' mean in simpler words?": "non-drowsy",
		"What does keep out of reach of children mean?":          "keep out of reach of children",
		"what does the phrase “store below 30°C” mean":           "store below 30°c",
		`What does "" mean?`:                                     "",
	} {
		got := ExtractExplainPhrase(q)
		if got == nil || *got != want {
			t.Errorf("ExtractExplainPhrase(%q) = %v, want %q", q, got, want)
		}
	}
	for _, q := range []string{
		"What does this warning mean?",
		"What do these directions mean?",
		"What does it mean?",
		"Explain the directions in simpler words.",
		"Can you read this label?",
	} {
		if got := ExtractExplainPhrase(q); got != nil {
			t.Errorf("ExtractExplainPhrase(%q) = %q, want nil", q, *got)
		}
	}
}

func TestAskedFields(t *testing.T) {
	for q, want := range map[string][]contracts.FieldKey{
		"How should it be stored?":                 {"storage"},
		"When was it manufactured?":                {"manufacturer"},
		"What are the active ingredients?":         {"genericNames", "strength"},
		"What is the manufacturing date?":          {},
		"What is the brand name?":                  {"brandName"},
		"Explain the directions in simpler words.": {"directions"},
	} {
		got := AskedFields(q)
		if got == nil || !slices.Equal(got, want) {
			t.Errorf("AskedFields(%q) = %v, want %v", q, got, want)
		}
		if b, _ := json.Marshal(got); len(want) == 0 && string(b) != "[]" {
			t.Errorf("AskedFields(%q) encodes as %s, want []", q, b)
		}
	}
	if got := AskedFields("Can you read this label?"); got != nil {
		t.Errorf("AskedFields(read label) = %v, want nil", got)
	}
}

func median(ds []time.Duration) time.Duration {
	s := slices.Clone(ds)
	slices.Sort(s)
	return s[len(s)/2]
}

func timeClassify(q string) (QuestionClass, time.Duration) {
	ds := make([]time.Duration, 5)
	var c QuestionClass
	for i := range ds {
		start := time.Now()
		c = ClassifyQuestion(q)
		ds[i] = time.Since(start)
	}
	return c, median(ds)
}

// A 10k-character question classifies in under 50 ms (median of 5) and is
// refused; the TS suite's adversarial inputs.
func TestClassifyPerformanceLong(t *testing.T) {
	ClassifyQuestion("warm up")
	for name, q := range map[string]string{
		"repeated letter":           strings.Repeat("a", 10_000),
		"repeated allowed question": strings.Repeat("Can you read this label? ", 400),
		"repeated refusal words":    strings.Repeat("white round pill take dose ", 371),
	} {
		if len(q) < 10_000 {
			t.Fatalf("%s: only %d characters", name, len(q))
		}
		c, d := timeClassify(q)
		t.Logf("%s (%d characters): ClassifyQuestion median of 5 = %v", name, len(q), d)
		if c.Allowed || c.Reason != "outside_label" {
			t.Errorf("%s: %+v, want outside_label", name, c)
		}
		if d >= 50*time.Millisecond {
			t.Errorf("%s: median %v, want under 50 ms", name, d)
		}
		// extractExplainPhrase and askedFields have no length cap in TS either
		ds := make([]time.Duration, 5)
		for i := range ds {
			start := time.Now()
			ExtractExplainPhrase(q)
			AskedFields(q)
			ds[i] = time.Since(start)
		}
		if d := median(ds); d >= 50*time.Millisecond {
			t.Errorf("%s: ExtractExplainPhrase+AskedFields median %v, want under 50 ms", name, d)
		}
	}
}

// The TS suite's 300-character worst cases, which reach every pattern.
func TestClassifyPerformanceAtLimit(t *testing.T) {
	ClassifyQuestion("warm up")
	cut := func(s string) string { return s[:min(len(s), 300)] } // TS q.slice(0, 300); ASCII only
	for name, q := range map[string]string{
		"nested quotes":           cut("what does " + strings.Repeat(`"a" `, 70) + "mean"),
		"many words before mean":  cut("what does " + strings.Repeat("word ", 55) + "mean"),
		"label words then a pill": cut(strings.Repeat("white label read ", 17) + "pill"),
		"spaces and again":        cut(strings.Repeat("read ", 50) + strings.Repeat("again ", 8)),
	} {
		_, d := timeClassify(q)
		t.Logf("%s (%d characters): ClassifyQuestion median of 5 = %v", name, len(q), d)
		if d >= 50*time.Millisecond {
			t.Errorf("%s: median %v, want under 50 ms", name, d)
		}
	}
}
