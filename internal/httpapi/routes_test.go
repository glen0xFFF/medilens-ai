package httpapi

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/parity"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

var scenarioIDs = []string{
	"s1-clear", "s2-blurry", "s3-similar", "s4-conflict", "s5-nomatch", "s6-loose-pill",
	"s7-unsupported-question", "s8-registry-down",
}

func TestNew(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Error("New accepted no service")
	}
}

/* ------------------------------------------------------------ health */

func TestHealthzIsLivenessOnly(t *testing.T) {
	e := newEnv(t, envOptions{})
	for range 300 { // never rate limited
		if w := e.get("/healthz"); w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"status":"ok"}` {
			t.Fatalf("%d %s", w.Code, w.Body.String())
		}
	}
	e.api.SetNotReady()
	if w := e.get("/healthz"); w.Code != 200 {
		t.Errorf("healthz while shutting down: %d", w.Code)
	}
}

func TestReadyzReportsTheProvidersAndShutdown(t *testing.T) {
	e := newEnv(t, envOptions{})
	w := e.get("/readyz")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"status":"ready","checks":{"model":"mock","references":"fixture"}}` {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}
	e.api.SetNotReady()
	w = e.get("/readyz")
	if w.Code != 503 || strings.TrimSpace(w.Body.String()) != `{"status":"shutting_down","checks":{"model":"mock","references":"fixture"}}` {
		t.Errorf("%d %s", w.Code, w.Body.String())
	}

	live := liveProviders(&countingReader{}, contracts.SearchResult{Kind: contracts.SearchNotAttempted})
	l := newEnv(t, envOptions{providers: &live})
	if w := l.get("/readyz"); strings.TrimSpace(w.Body.String()) != `{"status":"ready","checks":{"model":"configured","references":"ph_fda"}}` {
		t.Errorf("live %s", w.Body.String())
	}
	for range 300 {
		if w := l.get("/readyz"); w.Code != 200 {
			t.Fatalf("readyz is rate limited: %d", w.Code)
		}
	}
}

/* ------------------------------------------------------------ capabilities */

// Capabilities name the providers and limits, never a secret: built from a
// muse_spark configuration with a key, the body never contains the key.
func TestCapabilitiesExposeNoSecrets(t *testing.T) {
	const key = "SECRET-model-api-key-123"
	cfg, err := config.Load(func(k string) string {
		return map[string]string{"MODEL_PROVIDER": "muse_spark", "MODEL_API_KEY": key, "REFERENCE_PROVIDER": "ph_fda"}[k]
	})
	if err != nil {
		t.Fatal(err)
	}
	p, err := ai.NewFromConfig(cfg, ai.WithMetaOptions(metaapi.WithBaseURL("http://127.0.0.1:1")))
	if err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, envOptions{providers: &p})
	w := e.get("/api/v1/config/capabilities")
	if w.Code != 200 || strings.Contains(w.Body.String(), key) || strings.Contains(w.Body.String(), "SECRET") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var got map[string]json.RawMessage
	decode(t, w, &got)
	keys := []string{}
	for k := range got {
		keys = append(keys, k)
	}
	want := []string{"demoScenarios", "maxImageBytes", "maxImages", "modelId", "modelProvider", "presets", "referenceProvider", "streaming", "ttlSeconds"}
	if !sameSet(keys, want) {
		t.Errorf("keys %v", keys)
	}
	for k, v := range map[string]string{
		"modelProvider": `"muse_spark"`, "modelId": `"muse-spark-1.3"`, "referenceProvider": `"ph_fda"`,
		"maxImages": `3`, "maxImageBytes": `8388608`, "ttlSeconds": `900`, "streaming": `{"analysisEvents":true}`,
	} {
		if string(got[k]) != v {
			t.Errorf("%s = %s, want %s", k, got[k], v)
		}
	}
	var presets []string
	_ = json.Unmarshal(got["presets"], &presets)
	if !reflect.DeepEqual(presets, domain.AllowedQuestionExamples) {
		t.Errorf("presets %v", presets)
	}
	var scenarios []contracts.DemoScenarioSummary
	_ = json.Unmarshal(got["demoScenarios"], &scenarios)
	if !reflect.DeepEqual(scenarios, demo.Summaries()) {
		t.Errorf("scenarios %v", scenarios)
	}

	m := newEnv(t, envOptions{})
	var mock map[string]json.RawMessage
	decode(t, m.get("/api/v1/config/capabilities"), &mock)
	if string(mock["modelProvider"]) != `"mock"` || string(mock["modelId"]) != `null` || string(mock["referenceProvider"]) != `"fixture"` {
		t.Errorf("mock %v", mock)
	}
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	seen := map[string]int{}
	for _, s := range a {
		seen[s]++
	}
	for _, s := range b {
		seen[s]--
	}
	for _, n := range seen {
		if n != 0 {
			return false
		}
	}
	return true
}

/* ------------------------------------------------------------ demo */

func TestDemoScenarioList(t *testing.T) {
	e := newEnv(t, envOptions{})
	var list []map[string]any
	decode(t, e.get("/api/v1/demo/scenarios"), &list)
	ids := []string{}
	for _, s := range list {
		ids = append(ids, s["id"].(string))
		if !strings.HasPrefix(s["title"].(string), "DEMO DATA") {
			t.Errorf("title %v", s["title"])
		}
		if _, has := s["presetQuestion"]; has != (s["id"] == "s7-unsupported-question") {
			t.Errorf("presetQuestion on %v", s)
		}
	}
	if !reflect.DeepEqual(ids, scenarioIDs) {
		t.Errorf("ids %v", ids)
	}
	var presets []string
	decode(t, e.get("/api/v1/questions/presets"), &presets)
	if !reflect.DeepEqual(presets, domain.AllowedQuestionExamples) {
		t.Errorf("presets %v", presets)
	}
}

// Go port spec §6.6 (ruling R3): the 8 scenarios through POST
// /demo/scenarios then GET /result equal the Node POST /demo/scenario
// output, id and timestamps excluded. The status and references routes
// agree with the result.
func TestDemoScenariosOverHTTPEqualTheRecordedNodeResults(t *testing.T) {
	cases := parity.Load(t, "scenarios.jsonl")
	if len(cases) != len(scenarioIDs) {
		t.Fatalf("%d cases", len(cases))
	}
	for _, c := range cases {
		var req contracts.DemoScenarioRequest
		if err := json.Unmarshal(c.Args[0], &req); err != nil {
			t.Fatal(err)
		}
		t.Run(req.ScenarioID, func(t *testing.T) {
			e := newEnv(t, envOptions{})
			id := e.demoResult(t, req.ScenarioID)

			w := e.get("/api/v1/analyses/" + id + "/result")
			if w.Code != 200 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			var got map[string]json.RawMessage
			decode(t, w, &got)
			if string(got["id"]) != `"`+id+`"` {
				t.Errorf("id %s", got["id"])
			}
			for _, k := range []string{"id", "createdAt", "expiresAt"} {
				delete(got, k)
			}
			b, _ := json.Marshal(got)
			g, err := parity.Normalize(b)
			if err != nil {
				t.Fatal(err)
			}
			want, err := parity.Normalize(c.Result)
			if err != nil {
				t.Fatal(err)
			}
			if string(g) != string(want) {
				t.Errorf("result differs from Node:\n got %s\nwant %s", g, want)
			}

			var st application.Status
			decode(t, e.get("/api/v1/analyses/"+id), &st)
			if st.ID != id || st.Status != application.StateCompleted || !st.IsDemo || st.Error != nil || len(st.Events) < 2 {
				t.Errorf("status %+v", st)
			}
			for i, ev := range st.Events {
				if ev.Seq != i+1 || ev.Label == "" {
					t.Errorf("event %d %+v", i, ev)
				}
			}
			if last := st.Events[len(st.Events)-1].Stage; last != st.Stage || !last.Terminal() {
				t.Errorf("stage %s, last %s", st.Stage, last)
			}

			var refs map[string]json.RawMessage
			decode(t, e.get("/api/v1/analyses/"+id+"/references"), &refs)
			var match map[string]json.RawMessage
			_ = json.Unmarshal(got["match"], &match)
			if string(refs["checkedAt"]) != "null" || len(refs) != 4 {
				t.Errorf("references %v", refs)
			}
			for _, k := range []string{"candidates", "advisories", "limitations"} {
				if string(refs[k]) != string(match[k]) {
					t.Errorf("references %s = %s, result %s", k, refs[k], match[k])
				}
			}
		})
	}
}

func TestDemoScenarioErrors(t *testing.T) {
	e := newEnv(t, envOptions{})
	if msg := wantError(t, e.postJSON("/api/v1/demo/scenarios", `{"scenarioId":"s9-nope"}`), 404, contracts.ErrNotFound); msg != "Unknown demo scenario." {
		t.Errorf("message %q", msg)
	}
	for _, body := range []string{`{}`, `{"scenarioId":""}`, `{"scenarioId":7}`, `[]`, `{"scenarioId":null}`, ``} {
		if msg := wantError(t, e.postJSON("/api/v1/demo/scenarios", body), 400, contracts.ErrValidationFailed); msg != `Send {"scenarioId": "<id>"}.` {
			t.Errorf("%s: message %q", body, msg)
		}
	}
	for _, body := range []string{`{"scenarioId": `, `null`, `"s1-clear"`, `  `, `{"scenarioId":"s1-clear"} x`} {
		if msg := wantError(t, e.postJSON("/api/v1/demo/scenarios", body), 400, contracts.ErrValidationFailed); msg != "The request body is not valid JSON of up to 16 kB." {
			t.Errorf("%q: message %q", body, msg)
		}
	}
	big := `{"scenarioId":"s1-clear","pad":"` + strings.Repeat("x", 17*1024) + `"}`
	wantError(t, e.postJSON("/api/v1/demo/scenarios", big), 400, contracts.ErrValidationFailed)
	// express.json parses application/json only: any other body is no body
	if msg := wantError(t, e.postRaw("/api/v1/demo/scenarios", "text/plain", []byte(`{"scenarioId":"s1-clear"}`)), 400, contracts.ErrValidationFailed); msg != `Send {"scenarioId": "<id>"}.` {
		t.Errorf("text/plain: %q", msg)
	}
}

// Demo scenarios run whatever the providers are, and never spend.
func TestDemoScenariosRunWithAnExhaustedLiveBudget(t *testing.T) {
	reader := &countingReader{result: s1Read(t)}
	live := liveProviders(reader, scenario(t, "s1-clear").Reference)
	meter := pipeline.NewSpendMeter(0, time.Now)
	e := newEnv(t, envOptions{providers: &live, meter: meter})
	id := e.demoResult(t, "s1-clear")
	var r contracts.AnalysisResult
	decode(t, e.get("/api/v1/analyses/"+id+"/result"), &r)
	if !r.IsDemo || r.Match.Status != contracts.MatchVerified || reader.count() != 0 {
		t.Errorf("isDemo %v status %s reads %d", r.IsDemo, r.Match.Status, reader.count())
	}
}

/* ------------------------------------------------------------ result, references, delete */

func TestResultWhileProcessingIsNotReady(t *testing.T) {
	gate := newGate(s1Read(t))
	live := liveProviders(gate, scenario(t, "s1-clear").Reference)
	e := newEnv(t, envOptions{providers: &live})
	id := accepted(t, e.upload(sharp(t)))
	gate.waitStarted(t)
	for _, path := range []string{"/result", "/references"} {
		if msg := wantError(t, e.get("/api/v1/analyses/"+id+path), 409, pipeline.CodeAnalysisNotReady); msg == "" {
			t.Error("no message")
		}
	}
	wantError(t, e.postJSON("/api/v1/analyses/"+id+"/explanation", `{"question":"What strength is printed here?"}`), 409, pipeline.CodeAnalysisNotReady)
	wantError(t, e.postJSON("/api/v1/analyses/"+id+"/speak", `{"target":"summary"}`), 409, pipeline.CodeAnalysisNotReady)
	var st application.Status
	decode(t, e.get("/api/v1/analyses/"+id), &st)
	if st.Status != application.StateProcessing || st.Stage != pipeline.StageReading || st.IsDemo {
		t.Errorf("status %+v", st)
	}
	close(gate.release)
	e.wait(t, id)
	var r contracts.AnalysisResult
	decode(t, e.get("/api/v1/analyses/"+id+"/result"), &r)
	if r.IsDemo || r.Provenance == nil || r.Provenance.Model != ai.MuseModel || r.Provenance.References != "ph_fda" {
		t.Errorf("result %+v", r)
	}
}

func TestReferencesOfALiveResult(t *testing.T) {
	ref := scenario(t, "s1-clear").Reference
	live := liveProviders(&countingReader{result: s1Read(t)}, ref)
	e := newEnv(t, envOptions{providers: &live})
	id := accepted(t, e.upload(sharp(t)))
	e.wait(t, id)
	var r contracts.AnalysisResult
	decode(t, e.get("/api/v1/analyses/"+id+"/result"), &r)
	var refs struct {
		Candidates []contracts.ReferenceRecord `json:"candidates"`
		CheckedAt  *string                     `json:"checkedAt"`
	}
	decode(t, e.get("/api/v1/analyses/"+id+"/references"), &refs)
	if refs.CheckedAt == nil || *refs.CheckedAt != r.Match.Candidates[0].CheckedAt || !reflect.DeepEqual(refs.Candidates, r.Match.Candidates) {
		t.Errorf("references %+v", refs)
	}
}

func TestDeleteDropsTheAnalysis(t *testing.T) {
	e := newEnv(t, envOptions{})
	id := e.demoResult(t, "s1-clear")
	w := e.do(newRequest("DELETE", "/api/v1/analyses/"+id))
	if w.Code != 204 || w.Body.Len() != 0 {
		t.Fatalf("%d %q", w.Code, w.Body.String())
	}
	for _, path := range []string{"", "/result", "/references", "/events"} {
		wantError(t, e.get("/api/v1/analyses/"+id+path), 404, contracts.ErrNotFound)
	}
	if msg := wantError(t, e.do(newRequest("DELETE", "/api/v1/analyses/"+id)), 404, contracts.ErrNotFound); msg != "This scan result has expired or does not exist. Please scan again." {
		t.Errorf("message %q", msg)
	}
}

func TestUnknownIDsAreNotFound(t *testing.T) {
	e := newEnv(t, envOptions{})
	for _, path := range []string{"", "/result", "/references", "/events"} {
		wantError(t, e.get("/api/v1/analyses/no-such-id"+path), 404, contracts.ErrNotFound)
	}
	wantError(t, e.postJSON("/api/v1/analyses/no-such-id/explanation", `{"question":"What strength is printed here?"}`), 404, contracts.ErrNotFound)
	wantError(t, e.postJSON("/api/v1/analyses/no-such-id/speak", `{"target":"summary"}`), 404, contracts.ErrNotFound)
}

// Node final review Minor 13: an id that does not decode to UTF-8 is the
// client's error (400), never a 500.
func TestAnIDThatIsNotUTF8IsABadRequest(t *testing.T) {
	e := newEnv(t, envOptions{})
	if msg := wantError(t, e.get("/api/v1/analyses/%E0%A4/result"), 400, contracts.ErrValidationFailed); msg != "The request is not valid." {
		t.Errorf("message %q", msg)
	}
	wantError(t, e.get("/api/v1/analyses/%E0%A4"), 400, contracts.ErrValidationFailed)
	wantError(t, e.get("/api/v1/analyses/%FF/references"), 400, contracts.ErrValidationFailed)
	wantError(t, e.get("/api/v1/analyses/%E0%A4/events"), 400, contracts.ErrValidationFailed)
	wantError(t, e.postJSON("/api/v1/analyses/%E0%A4/explanation", `{"question":"Hi?"}`), 400, contracts.ErrValidationFailed)
	wantError(t, e.postJSON("/api/v1/analyses/%E0%A4/speak", `{"target":"summary"}`), 400, contracts.ErrValidationFailed)
	wantError(t, e.do(newRequest("DELETE", "/api/v1/analyses/%E0%A4")), 400, contracts.ErrValidationFailed)
}

func TestUnknownRoutesAndMethodsAreJSON404s(t *testing.T) {
	e := newEnv(t, envOptions{})
	for _, r := range []struct{ method, path string }{
		{"GET", "/api/v1/nope"}, {"GET", "/nope"}, {"GET", "/"}, {"GET", "/health"},
		{"DELETE", "/api/v1/analyses/x/result"}, {"POST", "/healthz"}, {"PUT", "/api/v1/analyses"},
		{"GET", "/api/v1/labels/x"}, {"POST", "/api/v1/demo/scenario"},
	} {
		if msg := wantError(t, e.do(newRequest(r.method, r.path)), 404, contracts.ErrNotFound); msg != "Not found." {
			t.Errorf("%s %s: message %q", r.method, r.path, msg)
		}
	}
}
