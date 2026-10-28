package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/observability"
	"github.com/medilens-ai/medilens/internal/parity"
	"github.com/medilens-ai/medilens/internal/pipeline"
	"github.com/medilens-ai/medilens/internal/references"
)

// All label and registry data in these tests is synthetic DEMO DATA with
// fictional names. Nothing touches the network: the live providers are
// stubs. SECRET-* strings are sentinels that must never reach a response
// they do not belong in, or any log line.

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// sink is a log writer safe for concurrent handlers.
type sink struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *sink) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *sink) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

/* ------------------------------------------------------------ images */

var (
	imagesOnce sync.Once
	sharpJPEG  []byte
	blurryJPEG []byte
	pngImage   []byte
	imagesErr  error
)

func loadImages(t testing.TB) {
	t.Helper()
	imagesOnce.Do(func() {
		dir, err := parity.Dir()
		if err != nil {
			imagesErr = err
			return
		}
		read := func(name string) []byte {
			b, err := os.ReadFile(filepath.Join(dir, "images", name))
			if err != nil && imagesErr == nil {
				imagesErr = err
			}
			return b
		}
		sharpJPEG, blurryJPEG, pngImage = read("sharp.jpg"), read("blurred.jpg"), read("sharp.png")
	})
	if imagesErr != nil {
		t.Fatal(imagesErr)
	}
}

func sharp(t testing.TB) []byte  { loadImages(t); return sharpJPEG }
func blurry(t testing.TB) []byte { loadImages(t); return blurryJPEG }
func png(t testing.TB) []byte    { loadImages(t); return pngImage }

/* ------------------------------------------------------------ providers */

// gateReader blocks every read until released or until ctx ends.
type gateReader struct {
	started chan struct{}
	release chan struct{}
	result  ai.ReadResult
}

func newGate(result ai.ReadResult) *gateReader {
	return &gateReader{started: make(chan struct{}, 64), release: make(chan struct{}), result: result}
}

func (g *gateReader) Read(ctx context.Context, _ [][]byte) (ai.ReadResult, error) {
	g.started <- struct{}{}
	select {
	case <-ctx.Done():
		return ai.ReadResult{Usage: ai.UsageEstimate}, ctx.Err()
	case <-g.release:
		return g.result, nil
	}
}

func (g *gateReader) waitStarted(t testing.TB) {
	t.Helper()
	select {
	case <-g.started:
	case <-time.After(10 * time.Second):
		t.Fatal("the read did not start")
	}
}

// countingReader returns its result at once and counts the reads.
type countingReader struct {
	mu     sync.Mutex
	calls  int
	result ai.ReadResult
}

func (r *countingReader) Read(context.Context, [][]byte) (ai.ReadResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	return r.result, nil
}

func (r *countingReader) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

type stubRefs struct{ result contracts.SearchResult }

func (s stubRefs) Search(context.Context, references.Query) contracts.SearchResult { return s.result }

type stubExplainer struct{}

func (stubExplainer) Explain(context.Context, string) (string, ai.Usage, error) {
	return "", ai.Usage{}, ai.ErrNoModel
}

func scenario(t testing.TB, id string) demo.Scenario {
	t.Helper()
	s, ok := demo.Get(id)
	if !ok {
		t.Fatalf("no scenario %s", id)
	}
	return s
}

func s1Read(t testing.TB) ai.ReadResult {
	return ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel}
}

// liveProviders are Muse Spark + PH FDA stand-ins: their results are not
// demo data.
func liveProviders(reader ai.LabelReader, search contracts.SearchResult) ai.Providers {
	return ai.Providers{
		ModelProvider: config.ModelMuseSpark, ModelID: ai.MuseModel, ReferenceProvider: config.ReferencePHFDA,
		Reader: reader, Explainer: stubExplainer{}, References: stubRefs{result: search},
	}
}

func mockProviders(t testing.TB) ai.Providers {
	t.Helper()
	p, err := ai.NewFromConfig(config.Config{ModelProvider: config.ModelMock, ReferenceProvider: config.ReferenceFixture})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

/* ------------------------------------------------------------ the API */

type testEnv struct {
	api  *API
	h    http.Handler
	svc  *application.Service
	logs *sink
}

type envOptions struct {
	providers  *ai.Providers
	meter      *pipeline.SpendMeter
	cors       string
	heartbeat  time.Duration
	service    Service // replaces the real service in the API
	workers    int
	queue      int
	newRequest func() string
}

func newEnv(t *testing.T, o envOptions) *testEnv {
	t.Helper()
	p := mockProviders(t)
	if o.providers != nil {
		p = *o.providers
	}
	meter := o.meter
	if meter == nil && p.ModelProvider == config.ModelMuseSpark {
		meter = pipeline.NewSpendMeter(5, time.Now)
	}
	svc, err := application.New(application.Options{Providers: p, Meter: meter, Workers: o.workers, QueueSize: o.queue})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := svc.Close(ctx); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	var s Service = svc
	if o.service != nil {
		s = o.service
	}
	logs := &sink{}
	api, err := New(Options{
		Service: s, Logger: observability.New(logs), CORSOrigin: o.cors, Heartbeat: o.heartbeat, NewRequestID: o.newRequest,
	})
	if err != nil {
		t.Fatal(err)
	}
	return &testEnv{api: api, h: api.Handler(), svc: svc, logs: logs}
}

func (e *testEnv) do(r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	return w
}

func newRequest(method, path string) *http.Request { return httptest.NewRequest(method, path, nil) }

func (e *testEnv) get(path string) *httptest.ResponseRecorder {
	return e.do(httptest.NewRequest("GET", path, nil))
}

func (e *testEnv) postJSON(path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	return e.do(r)
}

func (e *testEnv) postRaw(path, contentType string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", path, bytes.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	return e.do(r)
}

// upload posts the images under the "images" field.
func (e *testEnv) upload(images ...[]byte) *httptest.ResponseRecorder {
	parts := make([]part, len(images))
	for i, b := range images {
		parts[i] = part{field: "images", file: fmt.Sprintf("%d.jpg", i), body: b}
	}
	body, ct := multipartBody(parts...)
	return e.postRaw("/api/v1/analyses", ct, body)
}

type part struct {
	field, file string // file "" is a text field
	body        []byte
}

func multipartBody(parts ...part) ([]byte, string) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	for _, p := range parts {
		var w io.Writer
		var err error
		if p.file != "" {
			w, err = mw.CreateFormFile(p.field, p.file)
		} else {
			w, err = mw.CreateFormField(p.field)
		}
		if err != nil {
			panic(err)
		}
		_, _ = w.Write(p.body)
	}
	_ = mw.Close()
	return buf.Bytes(), mw.FormDataContentType()
}

// accepted checks a 202 {id, status: "processing"} and returns the id.
func accepted(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if w.Code != http.StatusAccepted {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	decode(t, w, &body)
	id, _ := body["id"].(string)
	if len(body) != 2 || body["status"] != "processing" || !uuidV4.MatchString(id) {
		t.Fatalf("body %v", body)
	}
	return id
}

func decode(t testing.TB, w *httptest.ResponseRecorder, v any) {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type %q", ct)
	}
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("body %q: %v", w.Body.String(), err)
	}
}

// stackText is what a stack trace or a Go error's text would show.
var stackText = []string{"stack", "at ", "goroutine", ".go:", "panic", "runtime."}

// wantError checks a contract error body: status, code, the request id of
// the response header, and no stack text. It returns the message.
func wantError(t testing.TB, w *httptest.ResponseRecorder, status int, code contracts.ErrorCode) string {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body.String())
	}
	var body map[string]map[string]any
	decode(t, w, &body)
	e := body["error"]
	if len(body) != 1 || len(e) != 3 {
		t.Errorf("body shape %v", body)
	}
	if e["code"] != string(code) {
		t.Errorf("code %v, want %s (%v)", e["code"], code, e["message"])
	}
	id := w.Header().Get("X-Request-Id")
	if e["requestId"] != id || !uuidV4.MatchString(id) {
		t.Errorf("requestId %v, header %q", e["requestId"], id)
	}
	for _, s := range stackText {
		if strings.Contains(w.Body.String(), s) {
			t.Errorf("error body contains %q: %s", s, w.Body.String())
		}
	}
	msg, _ := e["message"].(string)
	return msg
}

// wait drains the analysis's events until the stream ends and returns its
// status (through the service, so no read budget is spent).
func (e *testEnv) wait(t testing.TB, id string) application.Status {
	t.Helper()
	ch, cancel, err := e.svc.Subscribe(id, 0)
	if err != nil {
		t.Fatalf("subscribe %s: %v", id, err)
	}
	defer cancel()
	timeout := time.After(20 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				st, err := e.svc.Status(id)
				if err != nil {
					t.Fatalf("status %s: %v", id, err)
				}
				return st
			}
		case <-timeout:
			t.Fatalf("analysis %s did not finish", id)
		}
	}
}

// demoResult runs a demo scenario through the API and returns its id.
func (e *testEnv) demoResult(t *testing.T, scenarioID string) string {
	t.Helper()
	id := accepted(t, e.postJSON("/api/v1/demo/scenarios", `{"scenarioId":"`+scenarioID+`"}`))
	e.wait(t, id)
	return id
}
