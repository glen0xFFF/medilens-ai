package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"unicode"

	"github.com/medilens-ai/medilens/internal/parity"
)

type jsUnicode struct {
	Node            string            `json:"node"`
	Unicode         string            `json:"unicode"`
	JSSpace         [][2]int          `json:"jsSpace"`
	Cf              [][2]int          `json:"cf"`
	Letter          [][2]int          `json:"letter"`
	Number          [][2]int          `json:"number"`
	DashPunctuation [][2]int          `json:"dashPunctuation"`
	Invisible       [][2]int          `json:"invisible"`
	Lower           map[string]string `json:"lower"`
	NFKC            map[string]string `json:"nfkc"`
	Cased           [][2]int          `json:"cased"`
	CaseIgnorable   [][2]int          `json:"caseIgnorable"`
	// SigmaFinal maps a template (c stands for the code point) to the code
	// points for which V8 lowercases its Σ to the final form ς.
	SigmaFinal map[string][][2]int `json:"sigmaFinal"`
}

func inRanges(rs [][2]int, cp int) bool {
	for _, r := range rs {
		if cp >= r[0] && cp <= r[1] {
			return true
		}
	}
	return false
}

// TestJSUnicodeTables checks, for every code point, the JS Unicode
// behaviour the port re-implements against V8's (Node v24.21.0, Unicode
// 17.0, recorded by scripts/parity/go-probes.ts): JS \s (isJSSpace),
// \p{Cf}, \p{L}, \p{N}, \p{Pd}, the safety gate's
// [\p{Cf}\p{Default_Ignorable_Code_Point}] (isInvisible), \p{Cased}
// (isCased), \p{Case_Ignorable} (isCaseIgnorable), toLowerCase (jsLower),
// NFKC (jsNFKC), and toLowerCase's Final_Sigma context: the Σ of AΣc,
// AΣcA, cΣ and AcΣ for every code point c.
func TestJSUnicodeTables(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "js_unicode.json"))
	if err != nil {
		t.Fatal(err)
	}
	var u jsUnicode
	if err := json.Unmarshal(raw, &u); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(unicode.Version, u.Unicode) {
		t.Errorf("Node (%s) has Unicode %s, Go has %s", u.Node, u.Unicode, unicode.Version)
	}
	if len(u.SigmaFinal) != 4 {
		t.Fatalf("js_unicode.json has %d Final_Sigma templates, want 4", len(u.SigmaFinal))
	}
	checks := []struct {
		name string
		rs   [][2]int
		f    func(rune) bool
	}{
		{"jsSpace", u.JSSpace, isJSSpace},
		{"cf", u.Cf, func(r rune) bool { return unicode.Is(unicode.Cf, r) }},
		{"letter", u.Letter, unicode.IsLetter},
		{"number", u.Number, unicode.IsNumber},
		{"dashPunctuation", u.DashPunctuation, func(r rune) bool { return unicode.Is(unicode.Pd, r) }},
		{"invisible", u.Invisible, isInvisible},
		{"cased", u.Cased, isCased},
		{"caseIgnorable", u.CaseIgnorable, isCaseIgnorable},
	}
	bad := map[string]int{}
	for cp := 0; cp <= 0x10FFFF; cp++ {
		if cp >= 0xD800 && cp <= 0xDFFF {
			continue
		}
		r := rune(cp)
		for _, c := range checks {
			if c.f(r) != inRanges(c.rs, cp) {
				bad[c.name]++
				if bad[c.name] <= 3 {
					t.Errorf("%s(U+%04X): Go %v, JS %v", c.name, cp, c.f(r), !c.f(r))
				}
			}
		}
		key := strconv.FormatInt(int64(cp), 16)
		s := string(r)
		wantLower, ok := u.Lower[key]
		if !ok {
			wantLower = s
		}
		if got := jsLower(s); got != wantLower {
			bad["lower"]++
			if bad["lower"] <= 3 {
				t.Errorf("toLowerCase(U+%04X) = %q, JS %q", cp, got, wantLower)
			}
		}
		wantNFKC, ok := u.NFKC[key]
		if !ok {
			wantNFKC = s
		}
		if got := jsNFKC(s); got != wantNFKC {
			bad["nfkc"]++
			if bad["nfkc"] <= 3 {
				t.Errorf("NFKC(U+%04X) = %q, JS %q", cp, got, wantNFKC)
			}
		}
		for template, rs := range u.SigmaFinal {
			in := strings.Replace(template, "c", s, 1)
			out := []rune(jsLower(in))
			sigma := out[len(out)-1]
			if strings.HasPrefix(template, "AΣ") {
				sigma = out[1]
			}
			if want := inRanges(rs, cp); (sigma == 'ς') != want {
				bad["sigma "+template]++
				if bad["sigma "+template] <= 3 {
					t.Errorf("jsLower(%+q) = %+q, JS final sigma %v", in, string(out), want)
				}
			}
		}
	}
	for name, n := range bad {
		t.Errorf("%s: %d code points differ", name, n)
	}
}

// TestMatcherRegexpScanners compares the hand-written scanners that replace
// the matcher's i- and u-flag RegExps with V8 on every string in
// fixtures/parity/matcher.jsonl plus Unicode edge cases:
//
//	nameSplit      s.split(/\+|,|\band\b/i)
//	gluedStrength  /^\p{N}+(\p{L}+)$/u.exec(s)?.[1]
//	filmCoated     s.replace(/film[\s\p{Pd}]*coated/gu, 'film-coated')
//	formSplit      s.split(/[^\p{L}\p{N}-]+/u)
//	letter         /\p{L}/u.test(s)
//	format         /\p{Cf}/u.test(s)
func TestMatcherRegexpScanners(t *testing.T) {
	cases := loadTestdata(t, "matcher_regexps.jsonl")
	checkCases(t, cases, func(t *testing.T, c parity.Case) []byte {
		var s string
		mustDecode(t, c.Args[0], &s)
		var result any
		switch c.Fn {
		case "nameSplit":
			result = splitNameList(s)
		case "gluedStrength":
			result = gluedStrengthUnit(s)
		case "filmCoated":
			result = replaceFilmCoated(s)
		case "formSplit":
			result = splitFormTokens(s)
		case "letter":
			result = hasLetter(s)
		case "format":
			result = hasFormatChar(s)
		default:
			t.Fatalf("unknown fn %q", c.Fn)
		}
		out, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		return out
	})
}
