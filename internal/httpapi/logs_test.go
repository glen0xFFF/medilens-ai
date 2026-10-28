package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// Go port spec §4 (Logging): the access log carries method, route pattern,
// status, duration and request id only. No label value, question, answer,
// speech text, query string, scenario id or analysis id reaches a log line.
func TestLogsCarryNoLabelValuesQuestionsOrIDs(t *testing.T) {
	e := newEnv(t, envOptions{})
	var ids []string
	for _, s := range scenarioIDs {
		ids = append(ids, e.demoResult(t, s))
	}
	up := accepted(t, e.upload(sharp(t)))
	e.wait(t, up)
	ids = append(ids, up)
	requests := len(scenarioIDs) + 1
	for _, id := range ids {
		e.get("/api/v1/analyses/" + id)
		e.get("/api/v1/analyses/" + id + "/result")
		e.ask(id, "What does SECRET dry place mean for my grandmother Rosalinda?")
		e.postJSON("/api/v1/analyses/"+id+"/speak", `{"target":"answer","text":"SECRET speak text"}`)
		requests += 4
	}
	r := httptest.NewRequest("POST", "/api/v1/analyses/"+ids[0]+"/explanation?token=SECRET-query", strings.NewReader(`{"question":"What strength is printed here?"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer SECRET-token")
	e.do(r)
	requests++

	out := e.logs.String()
	forbidden := []string{"SECRET", "Rosalinda", "dry place"}
	forbidden = append(forbidden, ids...)
	forbidden = append(forbidden, scenarioIDs...)
	for _, s := range scenarioIDs {
		for _, f := range scenario(t, s).Label.Fields {
			if f.Value != nil && len(*f.Value) > 3 {
				forbidden = append(forbidden, *f.Value)
			}
		}
	}
	for _, s := range forbidden {
		if strings.Contains(out, s) {
			t.Errorf("the logs contain %q", s)
		}
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != requests {
		t.Errorf("%d log lines for %d requests:\n%s", len(lines), requests, out)
	}
	allowed := map[string]bool{"time": true, "level": true, "msg": true, "requestId": true, "method": true, "route": true, "status": true, "durationMs": true}
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("log line %q: %v", l, err)
		}
		if m["msg"] != "request" {
			t.Errorf("line %v", m)
		}
		for k := range m {
			if !allowed[k] {
				t.Errorf("key %q in %v", k, m)
			}
		}
		if route, _ := m["route"].(string); !strings.HasPrefix(route, "GET /api/v1/") && !strings.HasPrefix(route, "POST /api/v1/") {
			t.Errorf("route %q", route)
		}
	}
}

// brokenService fails every call, with an error whose text looks like a
// stack frame, or with a panic.
type brokenService struct{ panics bool }

func (b brokenService) fail() error {
	if b.panics {
		panic("SECRET panic at service.go:12\ngoroutine 7 [running]:")
	}
	return errors.New("SECRET failure at service.go:9")
}

func (b brokenService) Create(context.Context, [][]byte) (string, error) { return "", b.fail() }
func (b brokenService) CreateDemo(context.Context, string) (string, error) {
	return "", b.fail()
}
func (b brokenService) Status(string) (application.Status, error) {
	return application.Status{}, b.fail()
}
func (b brokenService) Result(string) (contracts.AnalysisResult, error) {
	return contracts.AnalysisResult{}, b.fail()
}
func (b brokenService) Subscribe(string, int) (<-chan pipeline.Event, func(), error) {
	return nil, func() {}, b.fail()
}
func (b brokenService) Explain(context.Context, string, string) (contracts.Answer, error) {
	return contracts.Answer{}, b.fail()
}
func (b brokenService) Speak(string, application.SpeakTarget, string) (application.Speech, error) {
	return application.Speech{}, b.fail()
}
func (b brokenService) References(string) (application.References, error) {
	return application.References{}, b.fail()
}
func (b brokenService) Delete(string) error { return b.fail() }
func (b brokenService) Capabilities() application.Capabilities {
	return application.Capabilities{ModelProvider: "mock", ReferenceProvider: "fixture"}
}

// No error body ever carries a stack or an error's own text: an
// unexpected error and a panic in every route are a generic 500.
func TestNoStackInAnyErrorBody(t *testing.T) {
	body, ct := multipartBody(part{field: "images", file: "a.jpg", body: []byte("x")})
	for _, panics := range []bool{false, true} {
		e := newEnv(t, envOptions{service: brokenService{panics: panics}})
		requests := []*httptest.ResponseRecorder{
			e.postRaw("/api/v1/analyses", ct, body),
			e.postJSON("/api/v1/demo/scenarios", `{"scenarioId":"s1-clear"}`),
			e.get("/api/v1/analyses/x"),
			e.get("/api/v1/analyses/x/result"),
			e.get("/api/v1/analyses/x/references"),
			e.get("/api/v1/analyses/x/events"),
			e.postJSON("/api/v1/analyses/x/explanation", `{"question":"What strength is printed here?"}`),
			e.postJSON("/api/v1/analyses/x/speak", `{"target":"summary"}`),
			e.do(newRequest("DELETE", "/api/v1/analyses/x")),
		}
		for i, w := range requests {
			if msg := wantError(t, w, 500, contracts.ErrInternal); msg != "Something went wrong. Please try again." {
				t.Errorf("panics %v, request %d: message %q", panics, i, msg)
			}
			if bytes.Contains(w.Body.Bytes(), []byte("SECRET")) {
				t.Errorf("panics %v, request %d: %s", panics, i, w.Body.String())
			}
		}
		out := e.logs.String()
		if strings.Contains(out, "SECRET") || strings.Contains(out, "goroutine") {
			t.Errorf("the logs carry the failure text:\n%s", out)
		}
		want := `"msg":"unhandled error"`
		if panics {
			want = `"msg":"panic recovered"`
		}
		if n := strings.Count(out, want); n != len(requests) {
			t.Errorf("panics %v: %d %s lines for %d requests:\n%s", panics, n, want, len(requests), out)
		}
		if !panics && !strings.Contains(out, `"errorName":"*errors.errorString"`) {
			t.Errorf("no error name:\n%s", out)
		}
	}
}

// A request cancelled by its own client (the explain call, waiting on the
// model) is not logged as an unhandled error.
func TestACancelledRequestIsNotAnUnhandledError(t *testing.T) {
	e := newEnv(t, envOptions{service: cancelledService{brokenService{}}})
	w := e.postJSON("/api/v1/analyses/x/explanation", `{"question":"What strength is printed here?"}`)
	wantError(t, w, 500, contracts.ErrInternal)
	if strings.Contains(e.logs.String(), "unhandled error") {
		t.Errorf("logged as unhandled:\n%s", e.logs.String())
	}
}

type cancelledService struct{ brokenService }

func (cancelledService) Explain(context.Context, string, string) (contracts.Answer, error) {
	return contracts.Answer{}, context.Canceled
}
