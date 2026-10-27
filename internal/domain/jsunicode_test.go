package domain

import (
	"encoding/json"
	"math/rand/v2"
	"strconv"
	"strings"
	"testing"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/medilens-ai/medilens/internal/parity"
)

// TestUnicodeRuns replays internal/domain/testdata/unicode_runs.jsonl, which
// scripts/parity/go-probes.ts records from V8: NFKC and toLowerCase on
// strings with runs of more than 30 combining marks or case-ignorables (the
// bounds golang.org/x/text has and ICU has not), and the safety, parser and
// matcher functions on inputs built from such runs, including questions
// that normalise to exactly 299, 300 and 301 code units (review round 1).
func TestUnicodeRuns(t *testing.T) {
	cases := loadTestdata(t, "unicode_runs.jsonl")
	seen := map[string]int{}
	for _, c := range cases {
		seen[c.Fn]++
	}
	for _, fn := range []string{
		"nfkc", "lower", "classifyQuestion", "extractExplainPhrase", "askedFields",
		"normalizeName", "parseStrength", "assessMatch",
	} {
		if seen[fn] == 0 {
			t.Errorf("unicode_runs.jsonl has no %s cases", fn)
		}
	}
	checkCases(t, cases, func(t *testing.T, c parity.Case) []byte {
		switch c.Fn {
		case "nfkc", "lower":
			var s string
			mustDecode(t, c.Args[0], &s)
			f := jsNFKC
			if c.Fn == "lower" {
				f = jsLower
			}
			out, err := json.Marshal(f(s))
			if err != nil {
				t.Fatal(err)
			}
			return out
		case "classifyQuestion", "extractExplainPhrase", "askedFields":
			return runSafetyCase(t, c)
		case "normalizeName", "parseStrength":
			return runParserCase(t, c)
		case "assessMatch":
			return runMatcherCase(t, c)
		}
		t.Fatalf("unknown fn %q", c.Fn)
		return nil
	})
}

// TestStreamSafeBoundary is the review round 1 reproduction. x/text's NFKC
// inserts U+034F after 30 non-starters (UAX #15 Stream-Safe Text Format),
// which blocks the composition of a + U+0301 that ICU performs; the gate
// then strips the U+034F, so the question normalised to 301 code units in
// Go and 300 in V8, and the emergency text was lost. The expectations were
// recorded with npx tsx from apps/server/src/domain/safety.ts.
func TestStreamSafeBoundary(t *testing.T) {
	run := "a" + strings.Repeat("̖", 30) + "́"
	if got, want := jsNFKC(run), "á"+strings.Repeat("̖", 30); got != want {
		t.Errorf("jsNFKC(a + 30 x U+0316 + U+0301) = %+q, V8 %+q", got, want)
	}
	for _, c := range []struct {
		pad  int
		want QuestionClass
	}{
		{251, refused(RefusalPossibleOverdose)}, // 299 units in V8
		{252, refused(RefusalPossibleOverdose)}, // 300 units in V8
		{253, refused(RefusalOutsideLabel)},     // 301 units in V8
	} {
		q := "i took too much " + strings.Repeat("x", c.pad) + " " + run
		if got := ClassifyQuestion(q); got != c.want {
			t.Errorf("pad %d: ClassifyQuestion = %+v, TS %+v", c.pad, got, c.want)
		}
	}
	// canonical ordering is unbounded: U+0316 (ccc 220) moves in front of
	// thirty U+0301 (ccc 230), and the first U+0301 composes with the a
	q := `What does "a` + strings.Repeat("́", 30) + "̖\" mean?"
	want := "á̖" + strings.Repeat("́", 29)
	if got := ExtractExplainPhrase(q); got == nil || *got != want {
		t.Errorf("ExtractExplainPhrase(%+q) = %s, TS %+q", q, quotedOrNil(got), want)
	}
}

// TestFinalSigmaContext pins toLowerCase's Final_Sigma context as V8 (ICU)
// evaluates it: unbounded in both directions, and a character that is both
// cased and case-ignorable (U+02B0, U+0345) is skipped as case-ignorable.
// x/text stops looking ahead after 30 case-ignorables and treats a cased
// case-ignorable before the sigma as cased. Expectations recorded with npx
// tsx (toLowerCase, extractExplainPhrase, normalizeName).
func TestFinalSigmaContext(t *testing.T) {
	ticks := strings.Repeat("'", 31)
	for _, c := range []struct{ in, want string }{
		{"ʰΣ", "ʰσ"},
		{"xʰΣ", "xʰς"},
		{"ͅΣ", "ͅσ"},
		{"ΑΣ" + ticks + "Α", "ασ" + ticks + "α"},
	} {
		if got := jsLower(c.in); got != c.want {
			t.Errorf("jsLower(%+q) = %+q, V8 %+q", c.in, got, c.want)
		}
	}
	q := `What does "` + "ΑΣ" + ticks + "Α" + `" mean?`
	want := "ασ" + ticks + "α"
	if got := ExtractExplainPhrase(q); got == nil || *got != want {
		t.Errorf("ExtractExplainPhrase(%+q) = %s, TS %+q", q, quotedOrNil(got), want)
	}
	if got := NormalizeName("ΑΣ" + ticks + "Α"); got != want {
		t.Errorf("NormalizeName = %+q, TS %+q", got, want)
	}
}

// TestJSNFKCMatchesXTextOnShortRuns: where no run of non-starters is longer
// than 30, x/text's NFKC is the standard algorithm, so the hand-written one
// must agree with it. Seeded random strings over characters that decompose,
// compose, reorder or are Hangul.
func TestJSNFKCMatchesXTextOnShortRuns(t *testing.T) {
	var pool []rune
	for r := rune(0); r <= unicode.MaxRune; r++ {
		if r >= 0xD800 && r <= 0xDFFF || r == 0x034F {
			continue
		}
		p := norm.NFKD.PropertiesString(string(r))
		hangul := r >= 0x1100 && r <= 0x11FF || r >= 0xAC00 && r <= 0xD7A3 && r%7 == 0
		if p.Decomposition() != nil || p.CCC() != 0 || !p.BoundaryBefore() || hangul {
			pool = append(pool, r)
		}
	}
	pool = append(pool, 'a', 'e', 'o', 's', ' ', 'A', 'x')
	rnd := rand.New(rand.NewPCG(20261031, 1))
	failed, compared := 0, 0
	for i := 0; i < 100000; i++ {
		rs := make([]rune, 1+rnd.IntN(12))
		for j := range rs {
			rs[j] = pool[rnd.IntN(len(pool))]
		}
		s := string(rs)
		want := norm.NFKC.String(s)
		if strings.ContainsRune(want, 0x034F) {
			continue // a run longer than 30: x/text is not the reference there
		}
		compared++
		if got := jsNFKC(s); got != want {
			failed++
			if failed <= 10 {
				t.Errorf("jsNFKC(%+q) = %+q, x/text %+q", s, got, want)
			}
		}
	}
	if failed > 0 || compared < 90000 {
		t.Errorf("%d of %d differ (pool %d runes)", failed, compared, len(pool))
	}
}

func quotedOrNil(p *string) string {
	if p == nil {
		return "nil"
	}
	return strconv.QuoteToASCII(*p)
}
