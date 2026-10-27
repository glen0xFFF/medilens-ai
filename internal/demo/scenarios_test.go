package demo

import (
	"bytes"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/parity"
)

var ids = []string{
	"s1-clear",
	"s2-blurry",
	"s3-similar",
	"s4-conflict",
	"s5-nomatch",
	"s6-loose-pill",
	"s7-unsupported-question",
	"s8-registry-down",
}

var (
	fictional    = regexp.MustCompile(`Paracelin 500|Paracelin 250|Paracelin-Forte 500|Amoxivan 500|Paracelin|Amoxivan`)
	syntheticReg = regexp.MustCompile(`^DR-XY9\d{5}$`)
)

func scenario(t *testing.T, id string) Scenario {
	t.Helper()
	s, ok := Get(id)
	if !ok {
		t.Fatalf("missing scenario %s", id)
	}
	return s
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestScenariosHaveExactlyTheEightIDsInOrder(t *testing.T) {
	var got []string
	for _, s := range Scenarios() {
		got = append(got, s.ID)
	}
	if !slices.Equal(got, ids) {
		t.Fatalf("ids = %v", got)
	}
}

func TestEveryFixtureIsValidDemoData(t *testing.T) {
	for _, id := range ids {
		s := scenario(t, id)
		if !strings.HasPrefix(s.Title, "DEMO DATA:") {
			t.Errorf("%s: title %q is not labelled DEMO DATA", id, s.Title)
		}
		for _, r := range s.Quality.Reasons {
			if !r.Valid() {
				t.Errorf("%s: quality reason %q", id, r)
			}
		}
		if !s.Label.ImageKind.Valid() {
			t.Errorf("%s: image kind %q", id, s.Label.ImageKind)
		}
		for _, f := range s.Label.Fields {
			if !f.Key.Valid() || !f.Legibility.Valid() {
				t.Errorf("%s: field %+v", id, f)
			}
			if f.Key == contracts.FieldRegistrationNumber && f.Value != nil && !syntheticReg.MatchString(*f.Value) {
				t.Errorf("%s: label registration number %q is not in the synthetic range", id, *f.Value)
			}
		}
		if s.Reference.Kind == contracts.SearchOK {
			for _, r := range s.Reference.Records {
				// final review Minor 18: a demo record never links to the real FDA site
				if r.SourceURL != "https://example.org/medilens-demo/"+r.RegistrationNumber {
					t.Errorf("%s: sourceUrl %q", id, r.SourceURL)
				}
				if u, ok := contracts.ParseHTTPURL(r.SourceURL); !ok || u != r.SourceURL {
					t.Errorf("%s: sourceUrl %q fails the contract", id, r.SourceURL)
				}
				if !syntheticReg.MatchString(r.RegistrationNumber) {
					t.Errorf("%s: record registration number %q", id, r.RegistrationNumber)
				}
				if r.BrandName == nil || !fictional.MatchString(*r.BrandName) {
					t.Errorf("%s: brand %v is not a fictional product", id, r.BrandName)
				}
				if r.CheckedAt != "2026-10-27T00:00:00.000Z" {
					t.Errorf("%s: checkedAt %q", id, r.CheckedAt)
				}
			}
		}
		if s.CannedAnswer != nil && !s.CannedAnswer.Status.Valid() {
			t.Errorf("%s: canned answer status %q", id, s.CannedAnswer.Status)
		}
	}
}

func TestTheRealMatcherYieldsTheScenarioStatus(t *testing.T) {
	for id, want := range map[string]contracts.MatchStatus{
		"s1-clear":                contracts.MatchVerified,
		"s3-similar":              contracts.MatchAmbiguous,
		"s4-conflict":             contracts.MatchConflicting,
		"s5-nomatch":              contracts.MatchNoMatch,
		"s7-unsupported-question": contracts.MatchVerified,
		"s8-registry-down":        contracts.MatchUnavailable,
	} {
		s := scenario(t, id)
		if got := domain.AssessMatch(&s.Label, s.Reference).Status; got != want {
			t.Errorf("%s: %s, want %s", id, got, want)
		}
	}
}

func TestScenarioDetails(t *testing.T) {
	s3 := scenario(t, "s3-similar")
	m3 := domain.AssessMatch(&s3.Label, s3.Reference)
	var brands []string
	for _, c := range m3.Candidates {
		brands = append(brands, *c.BrandName)
	}
	if !slices.Equal(brands, []string{"Paracelin 500", "Paracelin-Forte 500"}) {
		t.Errorf("s3 candidates %v", brands)
	}

	s4 := scenario(t, "s4-conflict")
	m4 := domain.AssessMatch(&s4.Label, s4.Reference)
	if len(m4.Conflicting) != 1 || m4.Conflicting[0].Key != contracts.FieldStrength ||
		m4.Conflicting[0].LabelValue != "500 mg" || !strings.Contains(m4.Conflicting[0].ReferenceValue, "250 mg") {
		t.Errorf("s4 conflict %+v", m4.Conflicting)
	}

	s1 := scenario(t, "s1-clear")
	if s1.Reference.Kind != contracts.SearchOK || len(s1.Reference.Records) != 1 {
		t.Errorf("s1 reference %+v", s1.Reference)
	}

	s2 := scenario(t, "s2-blurry")
	if s2.Quality.OK || !slices.Equal(s2.Quality.Reasons, []contracts.QualityReason{"BLURRY", "GLARE"}) ||
		s2.Label.ImageKind != contracts.ImageKindUnreadable {
		t.Errorf("s2 %+v %+v", s2.Quality, s2.Label.ImageKind)
	}
	for _, s := range Scenarios() {
		if s.ID != "s2-blurry" && (!s.Quality.OK || len(s.Quality.Reasons) != 0) {
			t.Errorf("%s: quality %+v", s.ID, s.Quality)
		}
	}

	s6 := scenario(t, "s6-loose-pill")
	if s6.Label.ImageKind != contracts.ImageKindLoosePill {
		t.Errorf("s6 kind %s", s6.Label.ImageKind)
	}
	for _, f := range s6.Label.Fields {
		if f.Value != nil {
			t.Errorf("s6 field %s has a value", f.Key)
		}
	}

	s8 := scenario(t, "s8-registry-down")
	if s8.Label.ImageKind != contracts.ImageKindLabel || !slices.ContainsFunc(s8.Label.Fields, func(f contracts.LabelField) bool { return f.Value != nil }) {
		t.Errorf("s8 label not read")
	}

	if _, ok := Get("nope"); ok {
		t.Error("Get(nope) found a scenario")
	}
}

// s7: the preset question is refused by the safety gate, and the canned
// answer is that refusal (scenarios.ts cannedRefusal).
func TestS7CannedRefusal(t *testing.T) {
	s7 := scenario(t, "s7-unsupported-question")
	if s7.PresetQuestion == nil || *s7.PresetQuestion != "How many should I take for my headache?" {
		t.Fatalf("preset question %v", s7.PresetQuestion)
	}
	verdict := domain.ClassifyQuestion(*s7.PresetQuestion)
	if verdict.Allowed {
		t.Fatal("the s7 preset question is allowed")
	}
	text := domain.RefusalText[verdict.Reason]
	want := contracts.Answer{
		Status:       contracts.AnswerRefused,
		Text:         text,
		SpokenChunks: []string{text},
		CitedFields:  []contracts.FieldKey{},
		SafetyNotice: contracts.Ptr("Please ask a pharmacist or your doctor."),
	}
	if s7.CannedAnswer == nil || !bytes.Equal(mustJSON(t, *s7.CannedAnswer), mustJSON(t, want)) {
		t.Errorf("canned answer %+v", s7.CannedAnswer)
	}
	for _, s := range Scenarios() {
		if s.ID != "s7-unsupported-question" && (s.PresetQuestion != nil || s.CannedAnswer != nil) {
			t.Errorf("%s has a preset question or canned answer", s.ID)
		}
	}
}

// The scenario data is the Node data: the quality report, and the label
// where the pipeline keeps it as read, equal the recorded Node results
// (fixtures/parity/scenarios.jsonl, ruling R3).
func TestScenarioDataEqualsTheRecordedNodeResults(t *testing.T) {
	seen := 0
	for _, c := range parity.Load(t, "scenarios.jsonl") {
		var req contracts.DemoScenarioRequest
		if err := json.Unmarshal(c.Args[0], &req); err != nil {
			t.Fatal(err)
		}
		var res struct {
			PipelineState contracts.PipelineState `json:"pipelineState"`
			Quality       json.RawMessage         `json:"quality"`
			Label         json.RawMessage         `json:"label"`
			Match         struct {
				Candidates json.RawMessage `json:"candidates"`
			} `json:"match"`
		}
		if err := json.Unmarshal(c.Result, &res); err != nil {
			t.Fatal(err)
		}
		s := scenario(t, req.ScenarioID)
		seen++
		equalJSON(t, req.ScenarioID+" quality", mustJSON(t, s.Quality), res.Quality)
		if res.PipelineState == contracts.PipelineExplanationReady {
			equalJSON(t, req.ScenarioID+" label", mustJSON(t, s.Label), res.Label)
			m := domain.AssessMatch(&s.Label, s.Reference)
			equalJSON(t, req.ScenarioID+" candidates", mustJSON(t, m.Candidates), res.Match.Candidates)
		}
	}
	if seen != len(ids) {
		t.Errorf("compared %d scenarios, want %d", seen, len(ids))
	}
}

func equalJSON(t *testing.T, where string, got, want []byte) {
	t.Helper()
	g, err := parity.Normalize(got)
	if err != nil {
		t.Fatal(err)
	}
	w, err := parity.Normalize(want)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(g, w) {
		t.Errorf("%s:\n got %s\nwant %s", where, g, w)
	}
}

// Callers get copies: changing one never changes the shared scenarios.
func TestScenariosAreCopies(t *testing.T) {
	a := scenario(t, "s1-clear")
	*a.Label.Fields[0].Value = "changed"
	a.Label.Fields[1].Legibility = contracts.LegibilityPartial
	*a.Reference.Records[0].BrandName = "changed"
	a.Quality.Reasons = append(a.Quality.Reasons, contracts.QualityBlurry)
	b := scenario(t, "s1-clear")
	if *b.Label.Fields[0].Value != "Paracelin 500" || b.Label.Fields[1].Legibility != contracts.LegibilityClear ||
		*b.Reference.Records[0].BrandName != "Paracelin 500" || len(b.Quality.Reasons) != 0 {
		t.Error("a change to a returned scenario reached the next Get")
	}
	all := Scenarios()
	*all[6].PresetQuestion = "changed"
	all[6].CannedAnswer.SpokenChunks[0] = "changed"
	s7 := scenario(t, "s7-unsupported-question")
	if *s7.PresetQuestion == "changed" || s7.CannedAnswer.SpokenChunks[0] == "changed" {
		t.Error("a change to Scenarios() reached Get")
	}
}

func TestSummaries(t *testing.T) {
	got := mustJSON(t, Summaries())
	var want []map[string]string
	for _, s := range Scenarios() {
		m := map[string]string{"id": s.ID, "title": s.Title}
		if s.PresetQuestion != nil {
			m["presetQuestion"] = *s.PresetQuestion
		}
		want = append(want, m)
	}
	equalJSON(t, "summaries", got, mustJSON(t, want))
	if !bytes.Contains(got, []byte(`"presetQuestion":"How many should I take for my headache?"`)) ||
		bytes.Count(got, []byte("presetQuestion")) != 1 {
		t.Errorf("summaries %s", got)
	}
}

func TestUploadScenarioIsS1(t *testing.T) {
	if UploadScenario != "s1-clear" {
		t.Errorf("UploadScenario = %q", UploadScenario)
	}
}
