package mcptools

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/httpapi"
	"github.com/medilens-ai/medilens/internal/observability"
)

// apiAsk is POST /api/v1/analyses/{id}/explanation on the Go API, built on
// the same service the MCP tools use: the status and the raw body.
func apiAsk(t *testing.T, svc *application.Service, id, question string) (int, string) {
	t.Helper()
	api, err := httpapi.New(httpapi.Options{Service: svc, Logger: observability.New(io.Discard)})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(map[string]string{"question": question})
	r := httptest.NewRequest("POST", "/api/v1/analyses/"+id+"/explanation", strings.NewReader(string(b)))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	api.Handler().ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func mcpAsk(t *testing.T, cs *mcp.ClientSession, id, question string) *mcp.CallToolResult {
	t.Helper()
	return call(t, cs, "explain_verified_label", map[string]any{"analysis_id": id, "question": question})
}

// answerPart is an explain_verified_label output without isDemo: the
// Answer keys, compared with the API body as canonical JSON.
func answerPart(t *testing.T, out ExplainOutput) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(jsonOf(t, out)), &m); err != nil {
		t.Fatal(err)
	}
	delete(m, "isDemo")
	return jsonOf(t, m)
}

// Review focus 5: explain_verified_label runs the same gate as the API.
// A dose question is refused with the same Answer, byte for byte.
func TestExplainRefusesADoseQuestionExactlyAsTheAPI(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	s7 := demoAnalysis(t, cs, "s7-unsupported-question")
	s1 := demoAnalysis(t, cs, "s1-clear")
	for _, c := range []struct {
		id, question string
		reason       domain.RefusalReason
	}{
		{s7, *scenario(t, "s7-unsupported-question").PresetQuestion, domain.RefusalPersonalDose},
		{s1, "How many tablets should I take for my headache?", domain.RefusalPersonalDose},
		{s1, "How much should I give my 5 year old?", ""},
		{s1, "My child swallowed the whole bottle", domain.RefusalPossibleOverdose},
		{s1, "Tell me a joke about pharmacists", domain.RefusalOutsideLabel},
	} {
		got := ok[ExplainOutput](t, mcpAsk(t, cs, c.id, c.question))
		if got.Status != contracts.AnswerRefused || !got.IsDemo {
			t.Errorf("%q: %+v", c.question, got)
		}
		if c.reason != "" && got.Text != domain.RefusalText[c.reason] {
			t.Errorf("%q: text %q", c.question, got.Text)
		}
		code, body := apiAsk(t, svc, c.id, c.question)
		if code != http.StatusOK || answerPart(t, got) != canonical(t, body) {
			t.Errorf("%q:\n mcp %s\n api %d %s", c.question, answerPart(t, got), code, body)
		}
	}
}

func TestExplainAnswersExactlyAsTheAPI(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	s1 := demoAnalysis(t, cs, "s1-clear")
	s2 := demoAnalysis(t, cs, "s2-blurry")
	questions := append([]string{"What strength is printed here?", "Repeat that", "What does 'store below 30C' mean?"},
		domain.AllowedQuestionExamples...)
	for _, id := range []string{s1, s2} {
		for _, q := range questions {
			got := ok[ExplainOutput](t, mcpAsk(t, cs, id, q))
			code, body := apiAsk(t, svc, id, q)
			if code != http.StatusOK || answerPart(t, got) != canonical(t, body) {
				t.Errorf("%q:\n mcp %s\n api %d %s", q, answerPart(t, got), code, body)
			}
		}
	}
}

// A live result: the gate refuses before any model call, and an allowed
// question runs the configured explainer as the API does.
func TestExplainOnALiveResultRefusesBeforeTheModel(t *testing.T) {
	explainer := &countingExplainer{}
	s1 := scenario(t, "s1-clear")
	p := liveProviders(fixedReader{ai.ReadResult{OK: true, Label: s1.Label, Model: ai.MuseModel}}, s1.Reference, explainer)
	svc := newService(t, svcOptions{providers: &p})
	cs := connect(t, svc)
	id := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"images_base64": []string{b64(sharp(t))}})).AnalysisID
	got := ok[ExplainOutput](t, mcpAsk(t, cs, id, "How many tablets should I take for my headache?"))
	if got.Status != contracts.AnswerRefused || got.IsDemo || explainer.count() != 0 {
		t.Fatalf("%+v, explainer calls %d", got, explainer.count())
	}
	code, body := apiAsk(t, svc, id, "How many tablets should I take for my headache?")
	if code != http.StatusOK || answerPart(t, got) != canonical(t, body) {
		t.Errorf("mcp %s\napi %d %s", answerPart(t, got), code, body)
	}
}

// The API's 4xx answers are tool errors with the same code and message.
func TestExplainErrorsMatchTheAPI(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	s1 := demoAnalysis(t, cs, "s1-clear")
	for _, c := range []struct {
		id, question string
		code         contracts.ErrorCode
	}{
		{s1, "", contracts.ErrValidationFailed},
		{s1, "   ", contracts.ErrValidationFailed},
		{s1, strings.Repeat("x", 301), contracts.ErrValidationFailed},
		{"00000000-0000-4000-8000-00000000dead", "What strength is printed here?", contracts.ErrNotFound},
		{"00000000-0000-4000-8000-00000000dead", "", contracts.ErrNotFound},
	} {
		text := toolErr(t, mcpAsk(t, cs, c.id, c.question), c.code)
		_, body := apiAsk(t, svc, c.id, c.question)
		var e contracts.ErrorBody
		if err := json.Unmarshal([]byte(body), &e); err != nil {
			t.Fatal(err)
		}
		if e.Error.Code != c.code || text != string(e.Error.Code)+": "+e.Error.Message {
			t.Errorf("%.20q: mcp %q, api %s", c.question, text, body)
		}
	}
	// a missing question is refused by the schema
	if res := call(t, cs, "explain_verified_label", map[string]any{"analysis_id": s1}); !res.IsError {
		t.Error("a missing question was accepted")
	}
}
