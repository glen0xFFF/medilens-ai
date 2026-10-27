package contracts

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode"

	"github.com/medilens-ai/medilens/internal/parity"
)

// ParseHTTPURL reproduces zod's z.httpUrl() on every recorded probe
// (fixtures/parity/providers/httpurl.jsonl), the IDNA hosts included: the
// accept or reject decision and the output value.
func TestParseHTTPURLMatchesZod(t *testing.T) {
	checkHTTPURLCorpus(t, "providers/httpurl.jsonl", 200)
}

// The same on the seeded random IDNA hosts (task G6 review round 1).
func TestParseHTTPURLMatchesZodOnRandomIDNAHosts(t *testing.T) {
	checkHTTPURLCorpus(t, "providers/httpurl-idna.jsonl", 2000)
}

// The same on every Unicode scalar value in each recorded host pattern
// (fixtures/parity/providers/httpurl-codepoints.*): the mapping, the
// normalization, the Bidi classes and the combining marks of Node's parser.
func TestParseHTTPURLMatchesZodOnEveryCodePoint(t *testing.T) {
	dir, err := parity.Dir()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "providers", "httpurl-codepoints.json"))
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Patterns   []string `json:"patterns"`
		ACESHA256  string   `json:"aceSha256"`
		CodePoints int      `json:"codePoints"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		t.Fatal(err)
	}
	gz, err := os.Open(filepath.Join(dir, "providers", "httpurl-codepoints.bin.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	zr, err := gzip.NewReader(gz)
	if err != nil {
		t.Fatal(err)
	}
	bits, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if len(meta.Patterns) < 11 || len(meta.Patterns) > 16 || len(bits) != 2*(unicode.MaxRune+1) {
		t.Fatalf("%d patterns, %d bytes", len(meta.Patterns), len(bits))
	}
	aces := sha256.New()
	n, mismatches := 0, 0
	for cp := rune(0); cp <= unicode.MaxRune; cp++ {
		if cp >= 0xD800 && cp <= 0xDFFF {
			continue
		}
		n++
		c := string(cp)
		enc, ok := punycodeEncode([]rune("a" + c))
		if !ok {
			t.Fatalf("U+%04X: no Punycode", cp)
		}
		ace := "xn--" + enc
		aces.Write([]byte(ace + "\n"))
		want := binary.LittleEndian.Uint16(bits[2*cp:])
		for k, p := range meta.Patterns {
			url := strings.ReplaceAll(strings.ReplaceAll(p, "{c}", c), "{ace}", ace)
			if _, got := ParseHTTPURL(url); got != (want&(1<<k) != 0) {
				mismatches++
				if mismatches <= 20 {
					t.Errorf("U+%04X pattern %d %+q: Go %v, zod %v", cp, k, url, got, !got)
				}
			}
		}
	}
	if n != meta.CodePoints {
		t.Errorf("%d code points, %d recorded", n, meta.CodePoints)
	}
	// the A-labels Go builds are the ones Node built (node:punycode)
	if got := hex.EncodeToString(aces.Sum(nil)); got != meta.ACESHA256 {
		t.Errorf("A-label list sha256 %s, recorded %s", got, meta.ACESHA256)
	}
	if mismatches > 0 {
		t.Errorf("%d of %d URLs differ from zod", mismatches, n*len(meta.Patterns))
	}
}

// ada's tables inflate to the recorded size and CRC32, or not at all: a
// changed or cut blob gives no tables, and then every non-ASCII host fails,
// as it does in ada when its tables do not load.
func TestAdaTablesLoadOnlyIntact(t *testing.T) {
	if adaTables() == nil {
		t.Fatal("the embedded ada tables do not load")
	}
	flipped := bytes.Clone(adaTablesDeflate)
	flipped[len(flipped)/2] ^= 0x01
	if loadAdaTables(flipped) != nil {
		t.Error("a changed blob loaded")
	}
	if loadAdaTables(adaTablesDeflate[:len(adaTablesDeflate)-1]) != nil {
		t.Error("a cut blob loaded")
	}
	if _, ok := domainToASCII("exämple.com"); !ok {
		t.Error("a non-ASCII host fails with the tables loaded")
	}
}

func checkHTTPURLCorpus(t *testing.T, file string, min int) {
	t.Helper()
	cases := parity.Load(t, file)
	if len(cases) < min {
		t.Fatalf("only %d probes recorded in %s", len(cases), file)
	}
	for i, c := range cases {
		var input string
		if err := json.Unmarshal(c.Args[0], &input); err != nil {
			t.Fatalf("#%d: %v", i, err)
		}
		var want struct {
			Success bool   `json:"success"`
			URL     string `json:"url"`
		}
		if err := json.Unmarshal(c.Result, &want); err != nil {
			t.Fatalf("#%d: %v", i, err)
		}
		got, ok := ParseHTTPURL(input)
		if ok != want.Success || got != want.URL {
			t.Errorf("%+q: got (%+q, %v), zod gave (%+q, %v)", input, got, ok, want.URL, want.Success)
		}
	}
}

func TestParseHTTPURLNodeTestCases(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want string
		ok   bool
	}{
		{"https://www.fda.gov.ph/fda-advisory-no-2099-0001-demo/", "https://www.fda.gov.ph/fda-advisory-no-2099-0001-demo/", true},
		{"https:/www.fda.gov.ph/x", "", false},
		{"https://localhost/x", "", false},
		{"http://10.0.0.1/a", "", false},
		{"javascript:alert(1)", "", false},
		{"not a url", "", false},
		{"https://exa\nmple.com/a", "https://example.com/a", true},
	} {
		got, ok := ParseHTTPURL(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("%q: got (%q, %v), want (%q, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}
