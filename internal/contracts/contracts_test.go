package contracts

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/parity"
)

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %T: %v", v, err)
	}
	return string(b)
}

// Zod expects arrays, never null: a nil Go slice must marshal as [].
func TestZeroValuesMarshalArraysNotNull(t *testing.T) {
	for _, tc := range []struct {
		v    any
		want string
	}{
		{ExtractedLabel{}, `{"imageKind":"","fields":[],"rawText":"","warnings":[]}`},
		{&ExtractedLabel{}, `{"imageKind":"","fields":[],"rawText":"","warnings":[]}`},
		{MatchAssessment{}, `{"status":"","matched":[],"conflicting":[],"missing":[],"candidates":[],"advisories":[],"limitations":[]}`},
		{QualityReport{}, `{"ok":false,"sharpness":0,"luminance":0,"glareFraction":0,"reasons":[]}`},
		{Explanation{}, `{"displayText":"","spokenChunks":[],"safetyNotices":[],"supportingFields":[]}`},
		{Answer{}, `{"status":"","text":"","spokenChunks":[],"citedFields":[],"safetyNotice":null}`},
		{LabelField{}, `{"key":"","value":null,"legibility":"","evidenceText":null,"imageIndex":null,"notes":null}`},
		{ReferenceRecord{}, `{"provider":"","sourceUrl":"","registrationNumber":"","brandName":null,"genericName":null,"strengthForm":null,"manufacturer":null,"classification":null,"registrationExpiry":null,"checkedAt":""}`},
		{ErrorBody{Error: ErrorDetail{Code: ErrNotFound, Message: "Not found.", RequestID: "r1"}}, `{"error":{"code":"NOT_FOUND","message":"Not found.","requestId":"r1"}}`},
		{DemoScenarioSummary{ID: "s1", Title: "t"}, `{"id":"s1","title":"t"}`},
		{DemoScenarioSummary{ID: "s7", Title: "t", PresetQuestion: Ptr("q?")}, `{"id":"s7","title":"t","presetQuestion":"q?"}`},
	} {
		if got := mustJSON(t, tc.v); got != tc.want {
			t.Errorf("%T:\n got %s\nwant %s", tc.v, got, tc.want)
		}
	}
}

func TestAnalysisResultZeroValue(t *testing.T) {
	got := mustJSON(t, AnalysisResult{})
	want := `{"id":"","isDemo":false,"createdAt":"","expiresAt":"","pipelineState":"",` +
		`"quality":{"ok":false,"sharpness":0,"luminance":0,"glareFraction":0,"reasons":[]},"label":null,` +
		`"match":{"status":"","matched":[],"conflicting":[],"missing":[],"candidates":[],"advisories":[],"limitations":[]},` +
		`"explanation":{"displayText":"","spokenChunks":[],"safetyNotices":[],"supportingFields":[]},"imageRetention":"none"}`
	if got != want {
		t.Errorf("\n got %s\nwant %s", got, want)
	}
}

// imageRetention is the literal "none" in the contract: images are never kept.
func TestAnalysisResultRefusesAnyOtherImageRetention(t *testing.T) {
	if _, err := json.Marshal(AnalysisResult{ImageRetention: "1h"}); err == nil {
		t.Error(`marshalled imageRetention "1h"`)
	}
	var r AnalysisResult
	if err := json.Unmarshal([]byte(`{"imageRetention":"forever"}`), &r); err == nil {
		t.Error(`unmarshalled imageRetention "forever"`)
	}
}

func TestSearchResultShapes(t *testing.T) {
	for _, tc := range []struct {
		v    SearchResult
		want string
	}{
		{SearchResult{Kind: SearchOK}, `{"kind":"ok","records":[],"advisories":[]}`},
		{SearchResult{Kind: SearchOK, AdvisoriesUnchecked: true}, `{"kind":"ok","records":[],"advisories":[],"advisoriesUnchecked":true}`},
		{SearchResult{Kind: SearchUnavailable, Reason: "timeout"}, `{"kind":"unavailable","reason":"timeout"}`},
		{SearchResult{Kind: SearchNotAttempted}, `{"kind":"not_attempted"}`},
	} {
		if got := mustJSON(t, tc.v); got != tc.want {
			t.Errorf("\n got %s\nwant %s", got, tc.want)
		}
	}
	if _, err := json.Marshal(SearchResult{Kind: "maybe"}); err == nil {
		t.Error("marshalled an unknown search kind")
	}
	var s SearchResult
	if err := json.Unmarshal([]byte(`{"kind":"ok","records":[],"advisories":[],"advisoriesUnchecked":false}`), &s); err == nil {
		t.Error("advisoriesUnchecked may only be present as true")
	}
}

func TestEnumsMatchTheZodSchemas(t *testing.T) {
	join := func(xs []string) string { return strings.Join(xs, ",") }
	for name, tc := range map[string]struct{ got, want string }{
		"FieldKey":      {join(strs(FieldKeys)), "brandName,genericNames,strength,dosageForm,manufacturer,registrationNumber,directions,warnings,storage,expiryDate,batchNumber,rxOrOtc"},
		"Legibility":    {join(strs(Legibilities)), "clear,partial,unreadable"},
		"ImageKind":     {join(strs(ImageKinds)), "label,loose_pill,not_medicine,unreadable"},
		"MatchStatus":   {join(strs(MatchStatuses)), "verified,partial,conflicting,ambiguous,no_match,unavailable,not_attempted"},
		"QualityReason": {join(strs(QualityReasons)), "BLURRY,TOO_DARK,GLARE"},
		"PipelineState": {join(strs(PipelineStates)), "label_unreadable,not_a_label,loose_pill,text_extracted,explanation_ready"},
		"AnswerStatus":  {join(strs(AnswerStatuses)), "answered,refused,unclear"},
		"ErrorCode": {join(strs(ErrorCodes)), "INVALID_IMAGE,IMAGE_TOO_LARGE,LIVE_BUDGET_EXHAUSTED,LABEL_UNREADABLE,OCR_FAILED," +
			"REFERENCE_UNAVAILABLE,NO_RELIABLE_MATCH,CONFLICTING_MATCH,UNSUPPORTED_REQUEST,RATE_LIMITED,NOT_FOUND,VALIDATION_FAILED,INTERNAL_ERROR"},
	} {
		if tc.got != tc.want {
			t.Errorf("%s:\n got %s\nwant %s", name, tc.got, tc.want)
		}
	}
	if !FieldStrength.Valid() || FieldKey("dose").Valid() {
		t.Error("FieldKey.Valid")
	}
	if !ErrNotFound.Valid() || ErrorCode("TEAPOT").Valid() {
		t.Error("ErrorCode.Valid")
	}
}

func strs[T ~string](xs []T) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = string(x)
	}
	return out
}

// FormatTime matches JS Date.prototype.toISOString, the Node timestamps.
func TestFormatTime(t *testing.T) {
	ts := time.Date(2026, 10, 27, 16, 0, 0, 123456789, time.FixedZone("PHT", 8*3600))
	if got := FormatTime(ts); got != "2026-10-27T08:00:00.123Z" {
		t.Errorf("got %s", got)
	}
	if got := FormatTime(time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)); got != "2026-01-02T03:04:05.000Z" {
		t.Errorf("got %s", got)
	}
}

/* ------------------------------------------------- corpus round trips */

// roundTrip decodes raw into a fresh T (unknown keys are an error, so a field
// missing from the Go struct is caught), encodes it again and compares the
// normalized JSON byte for byte. strip lists keys the Go encoding has but the
// recording dropped (scenario ids and timestamps).
func roundTrip[T any](t *testing.T, where string, raw json.RawMessage, strip ...string) {
	t.Helper()
	var v T
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("%s: decode %T: %v\n%s", where, v, err, raw)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("%s: encode %T: %v", where, v, err)
	}
	if len(strip) > 0 {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(out, &m); err != nil {
			t.Fatal(err)
		}
		for _, k := range strip {
			if _, ok := m[k]; !ok {
				t.Fatalf("%s: %T has no %q to strip", where, v, k)
			}
			delete(m, k)
		}
		if out, err = json.Marshal(m); err != nil {
			t.Fatal(err)
		}
	}
	want, err := parity.Normalize(raw)
	if err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	got, err := parity.Normalize(out)
	if err != nil {
		t.Fatalf("%s: %v", where, err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s: %T drifted from the recording\n got %s\nwant %s", where, v, got, want)
	}
}

// field returns one top-level key of a JSON object argument.
func field(t *testing.T, raw json.RawMessage, key string) json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("argument is not an object: %v", err)
	}
	v, ok := m[key]
	if !ok {
		t.Fatalf("argument has no %q", key)
	}
	return v
}

func TestRecordedResultsRoundTripThroughTheGoStructs(t *testing.T) {
	counts := map[string]int{}

	for i, c := range parity.Load(t, "matcher.jsonl") {
		if c.Fn != "assessMatch" {
			continue
		}
		where := "matcher.jsonl assessMatch #" + itoa(i)
		roundTrip[ExtractedLabel](t, where+" label", c.Args[0])
		roundTrip[SearchResult](t, where+" search", c.Args[1])
		roundTrip[MatchAssessment](t, where+" result", c.Result)
		counts["MatchAssessment"]++
		counts["ExtractedLabel"]++
		counts["SearchResult"]++
	}

	answerFns := map[string]bool{
		"answerFromLabel": true, "composeExplainAnswer": true, "unclearAnswer": true, "notALabelAnswer": true,
	}
	for i, c := range parity.Load(t, "answers.jsonl") {
		if !answerFns[c.Fn] || string(c.Result) == "null" {
			continue
		}
		where := "answers.jsonl " + c.Fn + " #" + itoa(i)
		roundTrip[Answer](t, where, c.Result)
		counts["Answer"]++
		if c.Fn == "answerFromLabel" || c.Fn == "composeExplainAnswer" {
			roundTrip[ExtractedLabel](t, where+" label", field(t, c.Args[0], "label"))
			roundTrip[MatchAssessment](t, where+" match", field(t, c.Args[0], "match"))
		}
	}

	for i, c := range parity.Load(t, "summary.jsonl") {
		if c.Fn != "buildSummary" {
			continue
		}
		where := "summary.jsonl buildSummary #" + itoa(i)
		roundTrip[Explanation](t, where, c.Result)
		roundTrip[QualityReport](t, where+" quality", field(t, c.Args[0], "quality"))
		counts["Explanation"]++
		counts["QualityReport"]++
	}

	for i, c := range parity.Load(t, "scenarios.jsonl") {
		roundTrip[AnalysisResult](t, "scenarios.jsonl #"+itoa(i), c.Result, "id", "createdAt", "expiresAt")
		roundTrip[DemoScenarioRequest](t, "scenarios.jsonl request #"+itoa(i), c.Args[0])
		counts["AnalysisResult"]++
	}

	for _, typ := range []string{"MatchAssessment", "ExtractedLabel", "SearchResult", "Answer", "Explanation", "QualityReport", "AnalysisResult"} {
		if counts[typ] == 0 {
			t.Errorf("no recorded %s was round-tripped", typ)
		}
	}
	if counts["AnalysisResult"] != 8 {
		t.Errorf("round-tripped %d scenario results, want 8", counts["AnalysisResult"])
	}
	t.Logf("round-tripped: %v", counts)
}

func itoa(i int) string {
	b, _ := json.Marshal(i)
	return string(b)
}
