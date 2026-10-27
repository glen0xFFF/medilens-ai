package domain

import (
	"encoding/json"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/parity"
)

func runMatcherCase(t *testing.T, c parity.Case) []byte {
	t.Helper()
	for _, a := range c.Args {
		if parity.IsUndefined(a) {
			t.Fatalf("%s: undefined argument is not supported: %s", c.Fn, a)
		}
	}
	var label contracts.ExtractedLabel
	mustDecode(t, c.Args[0], &label)
	var result any
	switch c.Fn {
	case "assessMatch":
		var search contracts.SearchResult
		mustDecode(t, c.Args[1], &search)
		result = AssessMatch(&label, search)
	case "clearValue":
		var key contracts.FieldKey
		mustDecode(t, c.Args[1], &key)
		result = ClearValue(&label, key)
	default:
		t.Fatalf("unknown fn %q", c.Fn)
	}
	out, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("%s: marshal: %v", c.Fn, err)
	}
	return out
}

// TestMatcherParity replays every recorded TS call in
// fixtures/parity/matcher.jsonl (the suite plus the seeded matcher fuzz).
func TestMatcherParity(t *testing.T) {
	cases := parity.Load(t, "matcher.jsonl")
	seen := map[string]int{}
	for _, c := range cases {
		seen[c.Fn]++
	}
	for _, fn := range []string{"assessMatch", "clearValue"} {
		if seen[fn] == 0 {
			t.Errorf("corpus has no %s cases", fn)
		}
	}
	checkCases(t, cases, runMatcherCase)
}

func clearField(key contracts.FieldKey, value string) contracts.LabelField {
	return contracts.LabelField{Key: key, Value: contracts.Ptr(value), Legibility: contracts.LegibilityClear}
}

func record(reg, brand, generic, strengthForm string) contracts.ReferenceRecord {
	return contracts.ReferenceRecord{
		Provider: "test", SourceURL: "https://example.invalid/" + reg, RegistrationNumber: reg,
		BrandName: contracts.Ptr(brand), GenericName: contracts.Ptr(generic), StrengthForm: contracts.Ptr(strengthForm),
		CheckedAt: "2026-10-27T00:00:00.000Z",
	}
}

// The matcher's JSON always carries arrays, never null (Zod expects []).
func TestAssessMatchArraysNeverNull(t *testing.T) {
	for _, search := range []contracts.SearchResult{
		{Kind: contracts.SearchUnavailable, Reason: "timeout"},
		{Kind: contracts.SearchNotAttempted},
		{Kind: contracts.SearchOK},
	} {
		got, err := json.Marshal(AssessMatch(&contracts.ExtractedLabel{ImageKind: contracts.ImageKindLabel}, search))
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(got, &m); err != nil {
			t.Fatal(err)
		}
		for _, k := range []string{"matched", "conflicting", "missing", "candidates", "advisories", "limitations"} {
			if string(m[k]) == "null" || m[k] == nil {
				t.Errorf("%s: %s is %s", search.Kind, k, m[k])
			}
		}
	}
}

// A nil label is the weakest evidence: nothing is clear, so nothing is
// verified (the TS type never allows null; the Go port does not crash).
func TestAssessMatchNilLabel(t *testing.T) {
	search := contracts.SearchResult{Kind: contracts.SearchOK, Records: []contracts.ReferenceRecord{record("DR-XY12345", "Paracelin", "Paracetamol", "500 mg Tablet")}}
	got := AssessMatch(nil, search)
	if got.Status != contracts.MatchNoMatch {
		t.Fatalf("nil label: status %s, want no_match", got.Status)
	}
	if ClearValue(nil, contracts.FieldBrandName) != nil {
		t.Fatal("ClearValue(nil) is not nil")
	}
}

// A SearchResult with no kind (a Go zero value; the TS union has none) is
// treated as an unavailable lookup: nothing was checked, so nothing is
// verified, even if records are present.
func TestAssessMatchUnknownKindIsUnavailable(t *testing.T) {
	label := &contracts.ExtractedLabel{ImageKind: contracts.ImageKindLabel, Fields: []contracts.LabelField{
		clearField(contracts.FieldRegistrationNumber, "DR-XY12345"),
		clearField(contracts.FieldBrandName, "Paracelin"),
		clearField(contracts.FieldStrength, "500 mg"),
	}}
	got := AssessMatch(label, contracts.SearchResult{Records: []contracts.ReferenceRecord{record("DR-XY12345", "Paracelin", "Paracetamol", "500 mg Tablet")}})
	if got.Status != contracts.MatchUnavailable || len(got.Candidates) != 0 {
		t.Fatalf("zero-kind search: %+v, want unavailable with no candidates", got)
	}
}

// The strict rule 3: a verified status needs a clear, matching
// registration number, brand and strength, and no conflict.
func TestAssessMatchVerifiedIsStrict(t *testing.T) {
	label := &contracts.ExtractedLabel{ImageKind: contracts.ImageKindLabel, Fields: []contracts.LabelField{
		clearField(contracts.FieldRegistrationNumber, "DR-XY12345"),
		clearField(contracts.FieldBrandName, "Paracelin"),
		clearField(contracts.FieldStrength, "500 mg"),
		clearField(contracts.FieldDosageForm, "Tablet"),
	}}
	search := contracts.SearchResult{Kind: contracts.SearchOK, Records: []contracts.ReferenceRecord{record("DR-XY12345", "Paracelin", "Paracetamol", "500 mg Tablet")}}
	if got := AssessMatch(label, search); got.Status != contracts.MatchVerified {
		t.Fatalf("clean label: %s, want verified", got.Status)
	}
	label.Fields[2].Legibility = contracts.LegibilityPartial
	if got := AssessMatch(label, search); got.Status != contracts.MatchPartial {
		t.Fatalf("partial strength: %s, want partial", got.Status)
	}
	label.Fields[2] = clearField(contracts.FieldStrength, "250 mg")
	got := AssessMatch(label, search)
	if got.Status != contracts.MatchConflicting || len(got.Conflicting) != 1 || got.Conflicting[0].Key != contracts.FieldStrength {
		t.Fatalf("strength conflict: %+v", got)
	}
}
