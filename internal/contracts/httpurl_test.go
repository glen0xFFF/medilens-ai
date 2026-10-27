package contracts

import (
	"encoding/json"
	"slices"
	"testing"

	"github.com/medilens-ai/medilens/internal/parity"
)

// The probes zod accepts and ParseHTTPURL rejects: hosts that need IDNA
// (UTS #46) processing, which the pinned dependencies have no table for.
// Rejecting is the fail-closed side: an advisory link dropped here makes the
// advisory unusable, so the advisories are flagged unchecked, never "none".
var idnaProbes = []string{
	"https://ex\u00E4mple.com/x",
	"https://EX\u00C4MPLE.com/x",
	"https://xn--exmple-cua.com/x",
	"https://xn--abc.com/x",
	"https://ex\u00ADmple.com/x",
	"https://\uFF45xample.com/x",
	"https://example\u3002com/x",
	"https://\u0645\u062B\u0627\u0644.com/x",
	"https://exa%C3%A4mple.com/x",
}

// ParseHTTPURL reproduces zod's z.httpUrl() on every recorded probe
// (fixtures/parity/providers/httpurl.jsonl), except the IDNA hosts above.
func TestParseHTTPURLMatchesZod(t *testing.T) {
	cases := parity.Load(t, "providers/httpurl.jsonl")
	if len(cases) < 100 {
		t.Fatalf("only %d probes recorded", len(cases))
	}
	seenIDNA := 0
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
		if slices.Contains(idnaProbes, input) {
			seenIDNA++
			if !want.Success || ok {
				t.Errorf("IDNA probe %q: zod %v, Go %v; want zod true, Go false", input, want.Success, ok)
			}
			continue
		}
		if ok != want.Success || got != want.URL {
			t.Errorf("%q: got (%q, %v), zod gave (%q, %v)", input, got, ok, want.URL, want.Success)
		}
	}
	if seenIDNA != len(idnaProbes) {
		t.Errorf("saw %d of the %d IDNA probes in the corpus", seenIDNA, len(idnaProbes))
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
