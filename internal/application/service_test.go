package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/domain"
	"github.com/medilens-ai/medilens/internal/parity"
	"github.com/medilens-ai/medilens/internal/pipeline"
	"github.com/medilens-ai/medilens/internal/references"
)

// All label and registry data here is synthetic DEMO DATA with fictional
// names. No test touches the network.

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

var t0 = time.Date(2026, 10, 27, 8, 0, 0, 0, time.UTC)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

var (
	imagesOnce sync.Once
	sharpJPEG  []byte
	blurryJPEG []byte
	imagesErr  error
)

func images(t testing.TB) (sharp, blurred []byte) {
	t.Helper()
	imagesOnce.Do(func() {
		dir, err := parity.Dir()
		if err != nil {
			imagesErr = err
			return
		}
		if sharpJPEG, err = os.ReadFile(filepath.Join(dir, "images", "sharp.jpg")); err != nil {
			imagesErr = err
			return
		}
		blurryJPEG, imagesErr = os.ReadFile(filepath.Join(dir, "images", "blurred.jpg"))
	})
	if imagesErr != nil {
		t.Fatal(imagesErr)
	}
	return sharpJPEG, blurryJPEG
}

func scenario(t testing.TB, id string) demo.Scenario {
	t.Helper()
	s, ok := demo.Get(id)
	if !ok {
		t.Fatalf("missing scenario %s", id)
	}
	return s
}

func jsonOf(t testing.TB, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func mockProviders(t testing.TB) ai.Providers {
	t.Helper()
	p, err := ai.NewFromConfig(config.Config{ModelProvider: config.ModelMock, ReferenceProvider: config.ReferenceFixture})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// gateReader blocks every Read until released or until ctx ends.
type gateReader struct {
	mu        sync.Mutex
	calls     int
	cancelled int
	started   chan struct{}
	release   chan struct{}
	result    ai.ReadResult
	panics    bool
}

func newGate(result ai.ReadResult) *gateReader {
	return &gateReader{started: make(chan struct{}, 64), release: make(chan struct{}), result: result}
}

func (g *gateReader) Read(ctx context.Context, _ [][]byte) (ai.ReadResult, error) {
	g.mu.Lock()
	g.calls++
	g.mu.Unlock()
	if g.panics {
		panic("reader bug")
	}
	g.started <- struct{}{}
	select {
	case <-ctx.Done():
		g.mu.Lock()
		g.cancelled++
		g.mu.Unlock()
		return ai.ReadResult{Usage: ai.UsageEstimate}, ctx.Err()
	case <-g.release:
		return g.result, nil
	}
}

func (g *gateReader) counts() (calls, cancelled int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls, g.cancelled
}

// waitStarted waits for n more reads to start.
func (g *gateReader) waitStarted(t testing.TB, n int) {
	t.Helper()
	for range n {
		select {
		case <-g.started:
		case <-time.After(10 * time.Second):
			t.Fatal("read did not start")
		}
	}
}

// instantReader returns its result at once.
type instantReader struct {
	mu     sync.Mutex
	calls  int
	result ai.ReadResult
}

func (r *instantReader) Read(context.Context, [][]byte) (ai.ReadResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	return r.result, nil
}

type stubRefs struct {
	result contracts.SearchResult
}

func (s stubRefs) Search(context.Context, references.Query) contracts.SearchResult { return s.result }

type stubExplainer struct {
	mu      sync.Mutex
	phrases []string
	reply   string
	usage   ai.Usage
}

func (e *stubExplainer) Explain(_ context.Context, phrase string) (string, ai.Usage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.phrases = append(e.phrases, phrase)
	return e.reply, e.usage, nil
}

func (e *stubExplainer) calls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.phrases)
}

// liveProviders are Muse Spark + PH FDA stand-ins: results are not demo.
func liveProviders(reader ai.LabelReader, search contracts.SearchResult, ex ai.PhraseExplainer) ai.Providers {
	return ai.Providers{
		ModelProvider:     config.ModelMuseSpark,
		ModelID:           ai.MuseModel,
		ReferenceProvider: config.ReferencePHFDA,
		Reader:            reader,
		Explainer:         ex,
		References:        stubRefs{result: search},
	}
}

func s1Read(t testing.TB) ai.ReadResult {
	return ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel, Usage: ai.Usage{PromptTokens: 2000, CompletionTokens: 500}}
}

func newService(t testing.TB, opts Options) *Service {
	t.Helper()
	s, err := New(opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.Close(ctx); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return s
}

// wait drains the analysis's events until the stream ends and returns its
// status.
func wait(t testing.TB, s *Service, id string) Status {
	t.Helper()
	ch, cancel, err := s.Subscribe(id, 0)
	if err != nil {
		t.Fatalf("subscribe %s: %v", id, err)
	}
	defer cancel()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				st, err := s.Status(id)
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

func stages(events []pipeline.Event) []pipeline.Stage {
	out := []pipeline.Stage{}
	for _, e := range events {
		out = append(out, e.Stage)
	}
	return out
}

func wantCode(t testing.TB, err error, code contracts.ErrorCode) *pipeline.Error {
	t.Helper()
	var pe *pipeline.Error
	if !errors.As(err, &pe) {
		t.Fatalf("error %v, want %s", err, code)
	}
	if pe.Code != code {
		t.Fatalf("code %s (%s), want %s", pe.Code, pe.Message, code)
	}
	return pe
}

func createDemo(t testing.TB, s *Service, id string) string {
	t.Helper()
	aid, err := s.CreateDemo(context.Background(), id)
	if err != nil {
		t.Fatalf("create demo %s: %v", id, err)
	}
	return aid
}

func result(t testing.TB, s *Service, id string) contracts.AnalysisResult {
	t.Helper()
	r, err := s.Result(id)
	if err != nil {
		t.Fatalf("result %s: %v", id, err)
	}
	return r
}

/* ------------------------------------------------- ruling R3: scenario parity */

// All 8 demo scenarios through CreateDemo give the Result the Node app
// gave through POST /api/v1/demo/scenario, id and timestamps excluded
// (fixtures/parity/scenarios.jsonl, ruling R3).
func TestDemoScenariosEqualTheRecordedNodeResults(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	cases := parity.Load(t, "scenarios.jsonl")
	seen := []string{}
	for _, c := range cases {
		if c.Fn != "POST /api/v1/demo/scenario" {
			t.Fatalf("fn %q", c.Fn)
		}
		var req contracts.DemoScenarioRequest
		if err := json.Unmarshal(c.Args[0], &req); err != nil {
			t.Fatal(err)
		}
		seen = append(seen, req.ScenarioID)
		t.Run(req.ScenarioID, func(t *testing.T) {
			id := createDemo(t, s, req.ScenarioID)
			if !uuidV4.MatchString(id) {
				t.Errorf("id %q is not a UUIDv4", id)
			}
			if st := wait(t, s, id); st.Status != StateCompleted {
				t.Fatalf("status %+v", st)
			}
			r := result(t, s, id)
			if r.ID != id {
				t.Errorf("result id %q", r.ID)
			}
			created, err1 := time.Parse(time.RFC3339Nano, r.CreatedAt)
			expires, err2 := time.Parse(time.RFC3339Nano, r.ExpiresAt)
			if err1 != nil || err2 != nil || expires.Sub(created) != 15*time.Minute {
				t.Errorf("times %s %s", r.CreatedAt, r.ExpiresAt)
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal([]byte(jsonOf(t, r)), &got); err != nil {
				t.Fatal(err)
			}
			for _, k := range []string{"id", "createdAt", "expiresAt"} {
				delete(got, k)
			}
			g, err := parity.Normalize([]byte(jsonOf(t, got)))
			if err != nil {
				t.Fatal(err)
			}
			w, err := parity.Normalize(c.Result)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(g, w) {
				t.Errorf("result differs from Node:\n got %s\nwant %s", g, w)
			}
		})
	}
	var all []string
	for _, sc := range demo.Scenarios() {
		all = append(all, sc.ID)
	}
	slices.Sort(seen)
	slices.Sort(all)
	if !slices.Equal(seen, all) {
		t.Errorf("compared %v, want every scenario %v", seen, all)
	}
}

/* --------------------------------------------- genuine, ordered events */

var (
	fullDemo = []pipeline.Stage{"received", "reading", "reviewing_fields", "checking_references", "comparing", "explaining", "completed"}
	fullScan = []pipeline.Stage{"received", "quality", "reading", "reviewing_fields", "checking_references", "comparing", "explaining", "completed"}
)

// Each scenario's events are the stages that actually ran: the demo
// skips the quality check (its report is a fixture), a quality failure
// skips the read, and a loose pill skips the registry.
func TestDemoEventsAreTheStagesThatRanInOrder(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	want := map[string][]pipeline.Stage{
		"s1-clear":                fullDemo,
		"s2-blurry":               {"received", "explaining", "needs_attention"},
		"s3-similar":              fullDemo,
		"s4-conflict":             fullDemo,
		"s5-nomatch":              fullDemo,
		"s6-loose-pill":           {"received", "reading", "reviewing_fields", "explaining", "needs_attention"},
		"s7-unsupported-question": fullDemo,
		"s8-registry-down":        fullDemo,
	}
	for id, stagesWant := range want {
		st := wait(t, s, createDemo(t, s, id))
		if got := stages(st.Events); !slices.Equal(got, stagesWant) {
			t.Errorf("%s stages %v", id, got)
		}
		last := st.Events[len(st.Events)-1]
		if st.Status != StateCompleted || st.Stage != last.Stage || st.Error != nil || !st.IsDemo {
			t.Errorf("%s status %+v", id, st)
		}
		for i, e := range st.Events {
			if e.Seq != i+1 || e.Label == "" || e.At == "" {
				t.Errorf("%s event %d %+v", id, i, e)
			}
		}
	}
}

func TestUploadEventsAreTheStagesThatRanInOrder(t *testing.T) {
	sharp, blurred := images(t)
	s := newService(t, Options{Providers: mockProviders(t)})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	if st := wait(t, s, id); !slices.Equal(stages(st.Events), fullScan) || st.Status != StateCompleted {
		t.Errorf("sharp: %+v", st)
	}
	id, err = s.Create(context.Background(), [][]byte{blurred})
	if err != nil {
		t.Fatal(err)
	}
	st := wait(t, s, id)
	if want := []pipeline.Stage{"received", "quality", "explaining", "needs_attention"}; !slices.Equal(stages(st.Events), want) {
		t.Errorf("blurred stages %v", stages(st.Events))
	}
	if r := result(t, s, id); r.PipelineState != contracts.PipelineLabelUnreadable || r.Label != nil {
		t.Errorf("blurred result %s", jsonOf(t, r))
	}
}

// A stage's event is there as soon as the stage starts, and no later
// stage is reported before it runs.
func TestAnEventIsEmittedWhenItsStageStarts(t *testing.T) {
	sharp, _ := images(t)
	gate := newGate(s1Read(t))
	s := newService(t, Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now)})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	gate.waitStarted(t, 1)
	st, err := s.Status(id)
	if err != nil {
		t.Fatal(err)
	}
	if want := []pipeline.Stage{"received", "quality", "reading"}; !slices.Equal(stages(st.Events), want) ||
		st.Status != StateProcessing || st.Stage != "reading" || st.IsDemo {
		t.Errorf("while reading: %+v", st)
	}
	_, err = s.Result(id)
	wantCode(t, err, pipeline.CodeAnalysisNotReady)
	_, err = s.Explain(context.Background(), id, "What strength is printed here?")
	wantCode(t, err, pipeline.CodeAnalysisNotReady)
	_, err = s.References(id)
	wantCode(t, err, pipeline.CodeAnalysisNotReady)
	_, err = s.Speak(id, SpeakSummary, "")
	wantCode(t, err, pipeline.CodeAnalysisNotReady)

	close(gate.release)
	st = wait(t, s, id)
	if !slices.Equal(stages(st.Events), fullScan) {
		t.Errorf("stages %v", stages(st.Events))
	}
	if r := result(t, s, id); r.IsDemo || r.Match.Status != contracts.MatchVerified {
		t.Errorf("result %s", jsonOf(t, r))
	}
}

func TestSubscribeReplaysThenStreamsAndHonoursAfterSeq(t *testing.T) {
	sharp, _ := images(t)
	gate := newGate(s1Read(t))
	s := newService(t, Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now)})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	gate.waitStarted(t, 1)
	ch, cancel, err := s.Subscribe(id, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	close(gate.release)
	var got []pipeline.Event
	for e := range ch {
		got = append(got, e)
	}
	if !slices.Equal(stages(got), fullScan[1:]) || got[0].Seq != 2 {
		t.Errorf("streamed %v", stages(got))
	}
	ch2, cancel2, err := s.Subscribe(id, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel2()
	var replay []pipeline.Event
	for e := range ch2 {
		replay = append(replay, e)
	}
	if !slices.Equal(stages(replay), fullScan[6:]) {
		t.Errorf("replayed %v", stages(replay))
	}
	if _, _, err := s.Subscribe("no-such-id", 0); err == nil {
		t.Error("subscribed to an unknown id")
	} else {
		wantCode(t, err, contracts.ErrNotFound)
	}
}

/* --------------------------------------------------------------- failures */

func TestAFailedAnalysisStoresItsErrorAndEndsWithAFailedEvent(t *testing.T) {
	sharp, _ := images(t)
	reader := &instantReader{result: ai.ReadResult{Detail: "request_failed", Usage: ai.UsageEstimate}}
	meter := pipeline.NewSpendMeter(5, time.Now)
	s := newService(t, Options{Providers: liveProviders(reader, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: meter})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	st := wait(t, s, id)
	msg := pipeline.NewError(contracts.ErrOCRFailed).Message
	if st.Status != StateFailed || st.Stage != pipeline.StageFailed || st.Error == nil ||
		st.Error.Code != contracts.ErrOCRFailed || st.Error.Message != msg {
		t.Fatalf("status %+v", st)
	}
	if want := []pipeline.Stage{"received", "quality", "reading", "failed"}; !slices.Equal(stages(st.Events), want) {
		t.Errorf("stages %v", stages(st.Events))
	}
	if last := st.Events[len(st.Events)-1]; last.Label != msg || last.Name() != "failed" {
		t.Errorf("failed event %+v", last)
	}
	_, err = s.Result(id)
	wantCode(t, err, contracts.ErrOCRFailed)
	_, err = s.Explain(context.Background(), id, "What strength is printed here?")
	wantCode(t, err, contracts.ErrOCRFailed)
	// the failed read is still charged (4000 + 4000 tokens)
	if want := 4000*1.25/1e6 + 4000*4.25/1e6; meterNot(meter.SpentUSD(), want) {
		t.Errorf("spent %v", meter.SpentUSD())
	}
}

func meterNot(a, b float64) bool { return a-b > 1e-12 || b-a > 1e-12 }

// Validation is header-only and synchronous; a body that fails to decode
// fails the job with INVALID_IMAGE.
func TestATruncatedJPEGFailsTheJobWithInvalidImage(t *testing.T) {
	sharp, _ := images(t)
	s := newService(t, Options{Providers: mockProviders(t)})
	truncated := sharp[:len(sharp)/2] // its header still parses
	id, err := s.Create(context.Background(), [][]byte{truncated})
	if err != nil {
		t.Fatal(err)
	}
	st := wait(t, s, id)
	if st.Status != StateFailed || st.Error == nil || st.Error.Code != contracts.ErrInvalidImage {
		t.Errorf("status %+v", st)
	}
	if want := []pipeline.Stage{"received", "quality", "failed"}; !slices.Equal(stages(st.Events), want) {
		t.Errorf("stages %v", stages(st.Events))
	}
}

func TestAWorkerSurvivesAPanickingReader(t *testing.T) {
	sharp, _ := images(t)
	gate := newGate(s1Read(t))
	gate.panics = true
	s := newService(t, Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now), Workers: 1})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	st := wait(t, s, id)
	if st.Status != StateFailed || st.Error == nil || st.Error.Code != contracts.ErrInternal {
		t.Errorf("status %+v", st)
	}
	// the only worker still runs jobs
	if st := wait(t, s, createDemo(t, s, "s1-clear")); st.Status != StateCompleted {
		t.Errorf("next job %+v", st)
	}
}

/* --------------------------------------------- cancellation and leaks */

// Close cancels the context of every in-flight job: running jobs stop
// (their reader sees the cancel), queued ones never run, each ends failed
// with ANALYSIS_FAILED, and no goroutine is left (synctest fails the test
// if any goroutine of the bubble is still blocked when it ends).
func TestCloseCancelsInFlightAndQueuedJobsAndLeavesNoGoroutine(t *testing.T) {
	sharp, _ := images(t)
	synctest.Test(t, func(t *testing.T) {
		gate := newGate(s1Read(t))
		s, err := New(Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now)})
		if err != nil {
			t.Fatal(err)
		}
		var ids []string
		for range 3 {
			id, err := s.Create(context.Background(), [][]byte{sharp})
			if err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
		synctest.Wait()
		if calls, _ := gate.counts(); calls != 2 {
			t.Fatalf("%d reads running, want 2 (2 workers)", calls)
		}
		subs := make([]<-chan pipeline.Event, len(ids))
		for i, id := range ids {
			ch, cancel, err := s.Subscribe(id, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer cancel()
			subs[i] = ch
		}
		if err := s.Close(context.Background()); err != nil {
			t.Fatal(err)
		}
		if calls, cancelled := gate.counts(); calls != 2 || cancelled != 2 {
			t.Errorf("reads %d cancelled %d", calls, cancelled)
		}
		for i, id := range ids {
			st, err := s.Status(id)
			if err != nil {
				t.Fatal(err)
			}
			if st.Status != StateFailed || st.Error == nil || st.Error.Code != pipeline.CodeAnalysisFailed {
				t.Errorf("%d: status %+v", i, st)
			}
			var last pipeline.Event
			for e := range subs[i] { // closed after the failed event
				last = e
			}
			if last.Stage != pipeline.StageFailed {
				t.Errorf("%d: last streamed event %+v", i, last)
			}
		}
		if _, err := s.Create(context.Background(), [][]byte{sharp}); !errors.Is(err, ErrClosed) {
			t.Errorf("create after close: %v", err)
		}
		if _, err := s.CreateDemo(context.Background(), "s1-clear"); !errors.Is(err, ErrClosed) {
			t.Errorf("demo after close: %v", err)
		}
		if err := s.Close(context.Background()); err != nil {
			t.Errorf("second close: %v", err)
		}
	})
}

// The same, measured with the goroutine count outside a bubble.
func TestCloseLeavesNoGoroutineRunning(t *testing.T) {
	sharp, _ := images(t)
	before := runtime.NumGoroutine()
	gate := newGate(s1Read(t))
	s, err := New(Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now)})
	if err != nil {
		t.Fatal(err)
	}
	for range 4 {
		if _, err := s.Create(context.Background(), [][]byte{sharp}); err != nil {
			t.Fatal(err)
		}
	}
	gate.waitStarted(t, 2)
	if runtime.NumGoroutine() <= before {
		t.Fatal("no workers started")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Close(ctx); err != nil {
		t.Errorf("close: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > before {
		t.Errorf("%d goroutines after close, %d before", n, before)
	}
}

// The context passed to Create is only checked on the call: the HTTP
// request that accepted a job ends when 202 is sent, and the job must go
// on.
func TestTheCreateContextDoesNotCancelTheAcceptedJob(t *testing.T) {
	sharp, _ := images(t)
	s := newService(t, Options{Providers: mockProviders(t)})
	ctx, cancel := context.WithCancel(context.Background())
	id, err := s.Create(ctx, [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if st := wait(t, s, id); st.Status != StateCompleted {
		t.Errorf("status %+v", st)
	}
	// a context that ended before the call accepts nothing
	if _, err := s.Create(ctx, [][]byte{sharp}); !errors.Is(err, context.Canceled) {
		t.Errorf("create with an ended context: %v", err)
	}
	if _, err := s.CreateDemo(ctx, "s1-clear"); !errors.Is(err, context.Canceled) {
		t.Errorf("demo with an ended context: %v", err)
	}
}

func TestDeleteCancelsARunningJobAndDropsTheAnalysis(t *testing.T) {
	sharp, _ := images(t)
	synctest.Test(t, func(t *testing.T) {
		gate := newGate(s1Read(t))
		s, err := New(Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now), Workers: 1})
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close(context.Background())
		id, err := s.Create(context.Background(), [][]byte{sharp})
		if err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		ch, cancel, err := s.Subscribe(id, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer cancel()
		if err := s.Delete(id); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		if _, cancelled := gate.counts(); cancelled != 1 {
			t.Errorf("the running read was not cancelled")
		}
		var got []pipeline.Stage
		for e := range ch {
			got = append(got, e.Stage)
		}
		if slices.ContainsFunc(got, func(s pipeline.Stage) bool { return s.Terminal() }) {
			t.Errorf("a dropped analysis streamed a terminal event: %v", got)
		}
		_, err = s.Status(id)
		wantCode(t, err, contracts.ErrNotFound)
		wantCode(t, s.Delete(id), contracts.ErrNotFound)
		// the worker is free again
		if st := wait(t, s, createDemo(t, s, "s1-clear")); st.Status != StateCompleted {
			t.Errorf("next job %+v", st)
		}
	})
}

func TestDeleteDropsACompletedResult(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	id := createDemo(t, s, "s1-clear")
	wait(t, s, id)
	if err := s.Delete(id); err != nil {
		t.Fatal(err)
	}
	for _, err := range []error{
		func() error { _, err := s.Result(id); return err }(),
		func() error { _, err := s.Status(id); return err }(),
		func() error { _, err := s.References(id); return err }(),
		func() error {
			_, err := s.Explain(context.Background(), id, "What strength is printed here?")
			return err
		}(),
		func() error { _, err := s.Speak(id, SpeakSummary, ""); return err }(),
		func() error { _, _, err := s.Subscribe(id, 0); return err }(),
	} {
		wantCode(t, err, contracts.ErrNotFound)
	}
}

/* ------------------------------------------------------------ queue full */

func TestAFullQueueReturnsTheErrorAndAcceptsNothing(t *testing.T) {
	sharp, _ := images(t)
	gate := newGate(s1Read(t))
	s := newService(t, Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now)})
	if DefaultWorkers != 2 || DefaultQueueSize != 8 {
		t.Fatalf("workers %d queue %d", DefaultWorkers, DefaultQueueSize)
	}
	var ids []string
	for range 2 {
		id, err := s.Create(context.Background(), [][]byte{sharp})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	gate.waitStarted(t, 2) // both workers busy
	for range 8 {
		id, err := s.Create(context.Background(), [][]byte{sharp})
		if err != nil {
			t.Fatalf("queued job %d: %v", len(ids), err)
		}
		ids = append(ids, id)
	}
	before := s.store.Len()
	_, err := s.Create(context.Background(), [][]byte{sharp})
	if !errors.Is(err, ErrQueueFull) {
		t.Fatalf("11th create: %v", err)
	}
	wantCode(t, err, contracts.ErrRateLimited)
	_, err = s.CreateDemo(context.Background(), "s1-clear")
	if !errors.Is(err, ErrQueueFull) {
		t.Fatalf("demo on a full queue: %v", err)
	}
	if s.store.Len() != before || before != 10 {
		t.Errorf("store %d entries, %d before", s.store.Len(), before)
	}
	// a finished job frees a place
	if err := s.Delete(ids[0]); err != nil {
		t.Fatal(err)
	}
	gate.waitStarted(t, 1) // a queued job reached the free worker
	if _, err := s.CreateDemo(context.Background(), "s1-clear"); err != nil {
		t.Errorf("create after a place freed: %v", err)
	}
	close(gate.release)
}

/* ------------------------------------------------------------------ budget */

func TestAnExhaustedBudgetRejectsAnUploadBeforeTheJobIsAccepted(t *testing.T) {
	sharp, _ := images(t)
	reader := &instantReader{result: s1Read(t)}
	s := newService(t, Options{Providers: liveProviders(reader, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(0, time.Now)})
	_, err := s.Create(context.Background(), [][]byte{sharp})
	wantCode(t, err, contracts.ErrLiveBudgetExhausted)
	if s.store.Len() != 0 || reader.calls != 0 {
		t.Errorf("store %d reads %d", s.store.Len(), reader.calls)
	}
	// Node's order: the image count and size first, then the budget, then
	// the format
	_, err = s.Create(context.Background(), [][]byte{})
	wantCode(t, err, contracts.ErrValidationFailed)
	_, err = s.Create(context.Background(), [][]byte{make([]byte, 8*1024*1024+1)})
	wantCode(t, err, contracts.ErrImageTooLarge)
	_, err = s.Create(context.Background(), [][]byte{[]byte("not an image at all")})
	wantCode(t, err, contracts.ErrLiveBudgetExhausted)
	// demo scenarios never spend and stay available
	if st := wait(t, s, createDemo(t, s, "s1-clear")); st.Status != StateCompleted {
		t.Errorf("demo %+v", st)
	}
}

func TestTheMockProviderIgnoresTheSpendMeter(t *testing.T) {
	sharp, _ := images(t)
	s := newService(t, Options{Providers: mockProviders(t), Meter: pipeline.NewSpendMeter(0, time.Now)})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	if st := wait(t, s, id); st.Status != StateCompleted {
		t.Errorf("status %+v", st)
	}
}

// Usage is recorded after the call, so a job accepted before the cap was
// reached still makes its one call (the in-flight race the Node README
// documents); the next upload is then refused.
func TestUsageIsRecordedAfterTheCallAndTheNextUploadIsRefused(t *testing.T) {
	sharp, _ := images(t)
	gate := newGate(ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel, Usage: ai.Usage{CompletionTokens: 1_000_000}})
	meter := pipeline.NewSpendMeter(4, time.Now) // one read costs $4.25
	s := newService(t, Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: meter})
	a, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	gate.waitStarted(t, 2)
	if meter.SpentUSD() != 0 {
		t.Fatalf("charged before the call ended: %v", meter.SpentUSD())
	}
	close(gate.release)
	for _, id := range []string{a, b} {
		if st := wait(t, s, id); st.Status != StateCompleted {
			t.Errorf("status %+v", st)
		}
	}
	if meterNot(meter.SpentUSD(), 8.5) || !meter.Exhausted() {
		t.Errorf("spent %v", meter.SpentUSD())
	}
	_, err = s.Create(context.Background(), [][]byte{sharp})
	wantCode(t, err, contracts.ErrLiveBudgetExhausted)
}

/* ------------------------------------------------------ TTL and cap eviction */

func TestAResultIsKeptFor15MinutesThenNotFound(t *testing.T) {
	c := &clock{t: t0}
	s := newService(t, Options{Providers: mockProviders(t), Now: c.now})
	id := createDemo(t, s, "s1-clear")
	wait(t, s, id)
	if r := result(t, s, id); r.CreatedAt != "2026-10-27T08:00:00.000Z" || r.ExpiresAt != "2026-10-27T08:15:00.000Z" {
		t.Errorf("times %s %s", r.CreatedAt, r.ExpiresAt)
	}
	c.advance(15*time.Minute - time.Millisecond)
	result(t, s, id)
	c.advance(time.Millisecond)
	_, err := s.Result(id)
	wantCode(t, err, contracts.ErrNotFound)
	_, err = s.Status(id)
	wantCode(t, err, contracts.ErrNotFound)
}

// An analysis that expires while it is still processing is dropped: its
// job is cancelled and its subscribers are closed.
func TestAnAnalysisExpiringWhileProcessingCancelsItsJob(t *testing.T) {
	sharp, _ := images(t)
	c := &clock{t: t0}
	gate := newGate(s1Read(t))
	s := newService(t, Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now), Now: c.now})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	gate.waitStarted(t, 1)
	ch, cancel, err := s.Subscribe(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	c.advance(15 * time.Minute)
	_, err = s.Status(id)
	wantCode(t, err, contracts.ErrNotFound)
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range ch {
		}
	}()
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("the subscriber was not closed")
	}
	deadline := time.Now().Add(5 * time.Second)
	for _, cancelled := gate.counts(); cancelled == 0 && time.Now().Before(deadline); _, cancelled = gate.counts() {
		time.Sleep(time.Millisecond)
	}
	if _, cancelled := gate.counts(); cancelled != 1 {
		t.Error("the job of the expired analysis was not cancelled")
	}
}

func TestTheOldestAnalysisIsEvictedAtTheCapAndItsJobCancelled(t *testing.T) {
	sharp, _ := images(t)
	gate := newGate(s1Read(t))
	s := newService(t, Options{Providers: liveProviders(gate, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now), MaxEntries: 2})
	if DefaultMaxEntries != 500 {
		t.Fatalf("cap %d", DefaultMaxEntries)
	}
	oldest, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	gate.waitStarted(t, 1)
	b := createDemo(t, s, "s1-clear")
	wait(t, s, b)
	c := createDemo(t, s, "s2-blurry")
	wait(t, s, c)
	_, err = s.Status(oldest)
	wantCode(t, err, contracts.ErrNotFound)
	deadline := time.Now().Add(5 * time.Second)
	for _, cancelled := gate.counts(); cancelled == 0 && time.Now().Before(deadline); _, cancelled = gate.counts() {
		time.Sleep(time.Millisecond)
	}
	if _, cancelled := gate.counts(); cancelled != 1 {
		t.Error("the evicted analysis's job was not cancelled")
	}
	for _, id := range []string{b, c} {
		if _, err := s.Status(id); err != nil {
			t.Errorf("%s: %v", id, err)
		}
	}
}

/* ---------------------------------------------------------- validation */

func TestCreateRejectsBadUploadsSynchronously(t *testing.T) {
	sharp, _ := images(t)
	s := newService(t, Options{Providers: mockProviders(t)})
	for name, tc := range map[string]struct {
		images [][]byte
		code   contracts.ErrorCode
	}{
		"none":         {nil, contracts.ErrValidationFailed},
		"four":         {[][]byte{sharp, sharp, sharp, sharp}, contracts.ErrValidationFailed},
		"too large":    {[][]byte{make([]byte, 8*1024*1024+1)}, contracts.ErrImageTooLarge},
		"not an image": {[][]byte{sharp, []byte("not an image at all")}, contracts.ErrInvalidImage},
	} {
		_, err := s.Create(context.Background(), tc.images)
		if err == nil {
			t.Errorf("%s accepted", name)
			continue
		}
		wantCode(t, err, tc.code)
	}
	if s.store.Len() != 0 {
		t.Errorf("store %d", s.store.Len())
	}
}

func TestCreateDemoValidatesTheScenarioID(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	_, err := s.CreateDemo(context.Background(), "")
	pe := wantCode(t, err, contracts.ErrValidationFailed)
	if pe.Message != `Send {"scenarioId": "<id>"}.` {
		t.Errorf("message %q", pe.Message)
	}
	_, err = s.CreateDemo(context.Background(), "s9-nope")
	if pe := wantCode(t, err, contracts.ErrNotFound); pe.Message != "Unknown demo scenario." {
		t.Errorf("message %q", pe.Message)
	}
	if s.store.Len() != 0 {
		t.Errorf("store %d", s.store.Len())
	}
}

func TestUnknownIDsAreNotFound(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	for _, id := range []string{"no-such-id", ""} {
		_, err := s.Status(id)
		wantCode(t, err, contracts.ErrNotFound)
		_, err = s.Result(id)
		wantCode(t, err, contracts.ErrNotFound)
		_, err = s.References(id)
		wantCode(t, err, contracts.ErrNotFound)
		_, err = s.Speak(id, SpeakSummary, "")
		wantCode(t, err, contracts.ErrNotFound)
		wantCode(t, s.Delete(id), contracts.ErrNotFound)
		// the id is looked up before the question is checked (Node order)
		_, err = s.Explain(context.Background(), id, "")
		wantCode(t, err, contracts.ErrNotFound)
	}
}

/* ------------------------------------------------------------- results */

func TestAMockUploadIsDemoDataWithMockProvenance(t *testing.T) {
	sharp, _ := images(t)
	s := newService(t, Options{Providers: mockProviders(t)})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	st := wait(t, s, id)
	r := result(t, s, id)
	if !st.IsDemo || !r.IsDemo || r.Provenance == nil || *r.Provenance != (contracts.Provenance{Model: "mock", References: "fixture"}) {
		t.Fatalf("status %+v result %s", st, jsonOf(t, r))
	}
	if !strings.Contains(r.Explanation.SpokenChunks[0], "Demo data") {
		t.Errorf("first chunk %q", r.Explanation.SpokenChunks[0])
	}
	// any upload reads as the s1 label
	if jsonOf(t, r.Label) != jsonOf(t, scenario(t, "s1-clear").Label) {
		t.Errorf("label %s", jsonOf(t, r.Label))
	}
}

func TestALiveUploadCarriesTheModelAndReferenceProvenance(t *testing.T) {
	sharp, _ := images(t)
	s := newService(t, Options{Providers: liveProviders(&instantReader{result: s1Read(t)}, scenario(t, "s1-clear").Reference, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now)})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	wait(t, s, id)
	r := result(t, s, id)
	if r.IsDemo || r.Provenance == nil || *r.Provenance != (contracts.Provenance{Model: "muse-spark-1.3", References: "ph_fda"}) {
		t.Errorf("result %s", jsonOf(t, r))
	}
}

func TestResultsAreCopies(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	id := createDemo(t, s, "s1-clear")
	wait(t, s, id)
	r := result(t, s, id)
	r.Explanation.SpokenChunks[0] = "tampered"
	*r.Label.Fields[0].Value = "tampered"
	r.Match.Candidates[0].RegistrationNumber = "tampered"
	again := result(t, s, id)
	if strings.Contains(jsonOf(t, again), "tampered") {
		t.Error("a caller changed the stored result")
	}
	st, _ := s.Status(id)
	st.Events[0].Label = "tampered"
	if st2, _ := s.Status(id); st2.Events[0].Label == "tampered" {
		t.Error("a caller changed the stored events")
	}
}

/* ------------------------------------------------------------- explain */

func TestExplainAnswersDemoResultsWithTheFixtures(t *testing.T) {
	ex := &stubExplainer{reply: "Keep it in a dry place."}
	s := newService(t, Options{Providers: liveProviders(&instantReader{result: s1Read(t)}, scenario(t, "s1-clear").Reference, ex), Meter: pipeline.NewSpendMeter(0, time.Now)})
	id := createDemo(t, s, "s1-clear")
	wait(t, s, id)
	a, err := s.Explain(context.Background(), id, `What does "dry place" mean?`)
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != contracts.AnswerAnswered || ex.calls() != 0 {
		t.Errorf("answer %s explainer calls %d", jsonOf(t, a), ex.calls())
	}
	s7 := createDemo(t, s, "s7-unsupported-question")
	wait(t, s, s7)
	a, err = s.Explain(context.Background(), s7, *scenario(t, "s7-unsupported-question").PresetQuestion)
	if err != nil || a.Status != contracts.AnswerRefused || a.Text != domain.RefusalText[domain.RefusalPersonalDose] {
		t.Errorf("s7 answer %s %v", jsonOf(t, a), err)
	}
}

func TestExplainAnswersLiveResultsWithTheModelAndChargesIt(t *testing.T) {
	sharp, _ := images(t)
	ex := &stubExplainer{reply: "Keep it in a dry place.", usage: ai.Usage{PromptTokens: 1_000_000}}
	meter := pipeline.NewSpendMeter(5, time.Now)
	s := newService(t, Options{Providers: liveProviders(&instantReader{result: ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel}}, scenario(t, "s1-clear").Reference, ex), Meter: meter})
	id, err := s.Create(context.Background(), [][]byte{sharp})
	if err != nil {
		t.Fatal(err)
	}
	wait(t, s, id)
	a, err := s.Explain(context.Background(), id, `What does "dry place" mean?`)
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != contracts.AnswerAnswered || ex.calls() != 1 || !strings.Contains(a.Text, "Keep it in a dry place.") {
		t.Errorf("answer %s calls %d", jsonOf(t, a), ex.calls())
	}
	if meterNot(meter.SpentUSD(), 1.25) {
		t.Errorf("spent %v", meter.SpentUSD())
	}
	// with the budget exhausted, a live result is not answered
	meter.Record(ai.Usage{CompletionTokens: 1_000_000})
	_, err = s.Explain(context.Background(), id, "What strength is printed here?")
	wantCode(t, err, contracts.ErrLiveBudgetExhausted)
	// refusals and repeats need no model
	if a, err := s.Explain(context.Background(), id, "How many should I take for my headache?"); err != nil || a.Status != contracts.AnswerRefused {
		t.Errorf("refusal %s %v", jsonOf(t, a), err)
	}
	_, err = s.Explain(context.Background(), id, "   ")
	wantCode(t, err, contracts.ErrValidationFailed)
}

/* --------------------------------------------------------------- speak */

func TestSpeakSummaryReturnsTheSpokenChunks(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	id := createDemo(t, s, "s1-clear")
	wait(t, s, id)
	sp, err := s.Speak(id, SpeakSummary, "")
	if err != nil {
		t.Fatal(err)
	}
	r := result(t, s, id)
	if sp.Language != "en-US" || !slices.Equal(sp.Chunks, r.Explanation.SpokenChunks) {
		t.Errorf("speech %+v", sp)
	}
	if got := jsonOf(t, sp); !strings.HasPrefix(got, `{"language":"en-US","chunks":["Demo data.`) {
		t.Errorf("json %s", got)
	}
}

func TestSpeakAnswerChunksTheTextWithTheSummarySplitter(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	id := createDemo(t, s, "s1-clear")
	wait(t, s, id)
	text := strings.Repeat("Keep out of reach of children. ", 30) + "Confirm with your pharmacist or doctor."
	sp, err := s.Speak(id, SpeakAnswer, text)
	if err != nil {
		t.Fatal(err)
	}
	if want := domain.ChunkSpeech(text); len(want) < 2 || !slices.Equal(sp.Chunks, want) || sp.Language != "en-US" {
		t.Errorf("chunks %q", sp.Chunks)
	}
	for _, bad := range []struct {
		target SpeakTarget
		text   string
	}{{SpeakAnswer, ""}, {SpeakAnswer, " \n\t"}, {"poem", "x"}, {"", ""}} {
		_, err := s.Speak(id, bad.target, bad.text)
		wantCode(t, err, contracts.ErrValidationFailed)
	}
}

/* ---------------------------------------------------------- references */

func TestReferencesOfADemoResultHaveNoCheckTime(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	for _, sc := range demo.Scenarios() {
		id := createDemo(t, s, sc.ID)
		wait(t, s, id)
		refs, err := s.References(id)
		if err != nil {
			t.Fatal(err)
		}
		r := result(t, s, id)
		if refs.CheckedAt != nil || jsonOf(t, refs.Candidates) != jsonOf(t, r.Match.Candidates) ||
			jsonOf(t, refs.Advisories) != jsonOf(t, r.Match.Advisories) || jsonOf(t, refs.Limitations) != jsonOf(t, r.Match.Limitations) {
			t.Errorf("%s: %s", sc.ID, jsonOf(t, refs))
		}
		for _, c := range refs.Candidates {
			if !strings.HasPrefix(c.SourceURL, demo.SourceURLPrefix) {
				t.Errorf("%s source %s", sc.ID, c.SourceURL)
			}
		}
	}
	// the JSON shape: exactly the four keys, null check time, [] lists
	id := createDemo(t, s, "s5-nomatch")
	wait(t, s, id)
	refs, _ := s.References(id)
	if got := jsonOf(t, refs); !strings.HasPrefix(got, `{"candidates":[],"advisories":[],"limitations":[`) || !strings.HasSuffix(got, `"checkedAt":null}`) {
		t.Errorf("json %s", got)
	}
}

func TestReferencesOfALiveResultCarryTheRegistryCheckTime(t *testing.T) {
	sharp, _ := images(t)
	newer := scenario(t, "s1-clear").Reference
	newer.Records[0].CheckedAt = "2026-10-27T07:59:00.000Z"
	for name, tc := range map[string]struct {
		search contracts.SearchResult
		want   func(r contracts.AnalysisResult) *string
	}{
		"candidates": {newer, func(contracts.AnalysisResult) *string { return contracts.Ptr("2026-10-27T07:59:00.000Z") }},
		"none found": {contracts.SearchResult{Kind: contracts.SearchOK, Records: []contracts.ReferenceRecord{}, Advisories: []contracts.Advisory{}},
			func(r contracts.AnalysisResult) *string { return &r.CreatedAt }},
		"unavailable": {contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: "PH FDA lookup failed: timeout"},
			func(contracts.AnalysisResult) *string { return nil }},
	} {
		t.Run(name, func(t *testing.T) {
			s := newService(t, Options{Providers: liveProviders(&instantReader{result: s1Read(t)}, tc.search, &stubExplainer{}), Meter: pipeline.NewSpendMeter(5, time.Now)})
			id, err := s.Create(context.Background(), [][]byte{sharp})
			if err != nil {
				t.Fatal(err)
			}
			wait(t, s, id)
			r := result(t, s, id)
			refs, err := s.References(id)
			if err != nil {
				t.Fatal(err)
			}
			if jsonOf(t, refs.CheckedAt) != jsonOf(t, tc.want(r)) {
				t.Errorf("checkedAt %v", jsonOf(t, refs.CheckedAt))
			}
		})
	}
}

// Node sorted the candidate times and took the last: the newest.
func TestCheckedAtIsTheNewestCandidateTime(t *testing.T) {
	r := contracts.AnalysisResult{CreatedAt: "2026-10-27T08:00:00.000Z", Match: contracts.MatchAssessment{
		Status: contracts.MatchAmbiguous,
		Candidates: []contracts.ReferenceRecord{
			{CheckedAt: "2026-10-27T07:00:00.000Z"}, {CheckedAt: "2026-10-27T07:30:00.000Z"}, {CheckedAt: "2026-10-27T06:00:00.000Z"},
		},
	}}
	if got := checkedAt(r); got == nil || *got != "2026-10-27T07:30:00.000Z" {
		t.Errorf("checkedAt %v", got)
	}
	r.Match.Status = contracts.MatchNotAttempted
	if checkedAt(r) != nil {
		t.Error("not attempted has a check time")
	}
	r.Match.Status = contracts.MatchVerified
	r.IsDemo = true
	if checkedAt(r) != nil {
		t.Error("demo has a check time")
	}
}

/* --------------------------------------------------------- capabilities */

func TestCapabilitiesOfTheMockProviders(t *testing.T) {
	s := newService(t, Options{Providers: mockProviders(t)})
	got := jsonOf(t, s.Capabilities())
	want := jsonOf(t, map[string]any{
		"modelProvider":     "mock",
		"modelId":           nil,
		"referenceProvider": "fixture",
		"maxImages":         3,
		"maxImageBytes":     8 * 1024 * 1024,
		"ttlSeconds":        900,
		"presets":           domain.AllowedQuestionExamples,
		"demoScenarios":     demo.Summaries(),
		"streaming":         map[string]bool{"analysisEvents": true},
	})
	g, _ := parity.Normalize([]byte(got))
	w, _ := parity.Normalize([]byte(want))
	if !bytes.Equal(g, w) {
		t.Errorf("capabilities\n got %s\nwant %s", g, w)
	}
}

func TestCapabilitiesOfMuseSparkNameTheModelAndNoSecret(t *testing.T) {
	p, err := ai.NewFromConfig(config.Config{
		ModelProvider: config.ModelMuseSpark, ReferenceProvider: config.ReferencePHFDA,
		ModelAPIKey: config.Secret("sk-test-not-a-real-key-0123456789"), DailySpendCapUSD: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	s := newService(t, Options{Providers: p, Meter: pipeline.NewSpendMeter(5, time.Now)})
	c := s.Capabilities()
	got := jsonOf(t, c)
	if c.ModelProvider != config.ModelMuseSpark || c.ModelID == nil || *c.ModelID != "muse-spark-1.3" || c.ReferenceProvider != config.ReferencePHFDA {
		t.Errorf("capabilities %s", got)
	}
	if strings.Contains(got, "sk-test") || strings.Contains(strings.ToLower(got), "key") {
		t.Errorf("capabilities expose a secret: %s", got)
	}
	// the slices are copies
	c.Presets[0] = "tampered"
	c.DemoScenarios[0].Title = "tampered"
	if strings.Contains(jsonOf(t, s.Capabilities()), "tampered") {
		t.Error("capabilities share state")
	}
}

/* ---------------------------------------------------------------- New */

func TestNewRejectsAnIncompleteConfiguration(t *testing.T) {
	ok := mockProviders(t)
	noReader := ok
	noReader.Reader = nil
	noRefs := ok
	noRefs.References = nil
	noExplainer := ok
	noExplainer.Explainer = nil
	museNoMeter := liveProviders(&instantReader{}, contracts.SearchResult{Kind: contracts.SearchNotAttempted}, &stubExplainer{})
	for name, opts := range map[string]Options{
		"no reader":                {Providers: noReader},
		"no references":            {Providers: noRefs},
		"no explainer":             {Providers: noExplainer},
		"muse spark without meter": {Providers: museNoMeter},
		"unknown model provider":   {Providers: ai.Providers{ModelProvider: "llama", ReferenceProvider: config.ReferenceFixture, Reader: ok.Reader, Explainer: ok.Explainer, References: ok.References}},
		"negative workers":         {Providers: ok, Workers: -1},
	} {
		if s, err := New(opts); err == nil {
			_ = s.Close(context.Background())
			t.Errorf("%s accepted", name)
		}
	}
}
