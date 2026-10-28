package domain

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/medilens-ai/medilens/internal/parity"
)

// runParserCase calls the Go port of c.Fn with the decoded arguments and
// returns its result encoded as JSON.
func runParserCase(t *testing.T, c parity.Case) []byte {
	t.Helper()
	for _, a := range c.Args {
		if parity.IsUndefined(a) {
			t.Fatalf("%s: undefined argument is not supported: %s", c.Fn, a)
		}
	}
	var result any
	switch c.Fn {
	case "parseStrength":
		var s string
		mustDecode(t, c.Args[0], &s)
		result = ParseStrength(s)
	case "strengthsEqual":
		var a, b []Strength
		mustDecode(t, c.Args[0], &a)
		mustDecode(t, c.Args[1], &b)
		result = StrengthsEqual(a, b)
	case "normalizeRegistrationNumber":
		var s string
		mustDecode(t, c.Args[0], &s)
		result = NormalizeRegistrationNumber(s)
	case "normalizeName":
		var s string
		mustDecode(t, c.Args[0], &s)
		result = NormalizeName(s)
	default:
		t.Fatalf("unknown fn %q", c.Fn)
	}
	out, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("%s: marshal: %v", c.Fn, err)
	}
	return out
}

func mustDecode(t *testing.T, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
}

func checkParserCases(t *testing.T, cases []parity.Case) {
	t.Helper()
	failed := 0
	for i, c := range cases {
		got, err := parity.Normalize(runParserCase(t, c))
		if err != nil {
			t.Fatalf("case %d: normalize got: %v", i, err)
		}
		want, err := parity.Normalize(c.Result)
		if err != nil {
			t.Fatalf("case %d: normalize want: %v", i, err)
		}
		if !bytes.Equal(got, want) {
			failed++
			args, _ := json.Marshal(c.Args)
			t.Errorf("case %d %s(%s):\n got  %s\n want %s", i, c.Fn, args, got, want)
		}
	}
	if failed > 0 {
		t.Logf("%d of %d cases differ", failed, len(cases))
	}
}

// TestParsersParity replays every recorded TS call in fixtures/parity/parsers.jsonl.
func TestParsersParity(t *testing.T) {
	cases := parity.Load(t, "parsers.jsonl")
	seen := map[string]int{}
	for _, c := range cases {
		seen[c.Fn]++
	}
	for _, fn := range []string{"parseStrength", "strengthsEqual", "normalizeRegistrationNumber", "normalizeName"} {
		if seen[fn] == 0 {
			t.Errorf("corpus has no %s cases", fn)
		}
	}
	checkParserCases(t, cases)
}

// TestParsersNonASCII replays extra cases recorded from the TS parsers
// (apps/server/src/domain/parsers.ts, Node v24.21.0, via tsx) that the corpus
// does not cover: JS \s versus Go unicode.IsSpace (NEL, BOM, U+180E),
// \p{Cf}, NFKC (mathematical digits, ㎎, Roman numerals), the non-unicode
// case-insensitive [µμ] class (capital Μ), full-case toLowerCase/toUpperCase
// (İ, final sigma, ǅ, ß, ı) and non-ASCII digits that \d does not match.
func TestParsersNonASCII(t *testing.T) {
	f, err := os.Open(filepath.Join("testdata", "parsers_nonascii.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cases, err := parity.Parse(f)
	if err != nil {
		t.Fatal(err)
	}
	checkParserCases(t, cases)
}

// A parse that consumed nothing returns nil, which must encode as JSON null
// (never []), matching the TS `Strength[] | null`.
func TestParseStrengthNullEncoding(t *testing.T) {
	got, err := json.Marshal(ParseStrength("no strength here"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "null" {
		t.Fatalf("got %s, want null", got)
	}
}

// `per` is omitted (not null) when absent, as in TS.
func TestStrengthPerOmitted(t *testing.T) {
	got, err := json.Marshal(ParseStrength("500 mg"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != `[{"amount":500,"unit":"mg"}]` {
		t.Fatalf("got %s", got)
	}
}

func TestWordLists(t *testing.T) {
	if DosageFormWords["softgels"] != "capsule" || DosageFormWords["drop"] != "drops" || len(DosageFormWords) != 32 {
		t.Fatalf("DosageFormWords drifted: %v", DosageFormWords)
	}
	if !DosageFormModifiers["film-coated"] || len(DosageFormModifiers) != 1 {
		t.Fatalf("DosageFormModifiers drifted: %v", DosageFormModifiers)
	}
	for _, w := range []string{"eye", "ear", "nasal"} {
		if !DropsQualifiers[w] {
			t.Fatalf("DropsQualifiers missing %q", w)
		}
	}
	if len(DropsQualifiers) != 3 {
		t.Fatalf("DropsQualifiers drifted: %v", DropsQualifiers)
	}
}
