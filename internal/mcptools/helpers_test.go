package mcptools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/parity"
	"github.com/medilens-ai/medilens/internal/pipeline"
	"github.com/medilens-ai/medilens/internal/references"
)

// All label and registry data in these tests is synthetic DEMO DATA with
// fictional names. Nothing touches the network: the live providers are
// stubs. SECRET-* strings are sentinels that must never reach an output
// or a log line they do not belong in.

/* ------------------------------------------------------------ images */

var (
	imagesOnce sync.Once
	sharpJPEG  []byte
	blurryJPEG []byte
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
		if sharpJPEG, err = os.ReadFile(filepath.Join(dir, "images", "sharp.jpg")); err != nil {
			imagesErr = err
			return
		}
		blurryJPEG, imagesErr = os.ReadFile(filepath.Join(dir, "images", "blurred.jpg"))
	})
	if imagesErr != nil {
		t.Fatal(imagesErr)
	}
}

func sharp(t testing.TB) []byte  { loadImages(t); return sharpJPEG }
func blurry(t testing.TB) []byte { loadImages(t); return blurryJPEG }

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

/* ------------------------------------------------------------ providers */

func mockProviders(t testing.TB) ai.Providers {
	t.Helper()
	p, err := ai.NewFromConfig(config.Config{ModelProvider: config.ModelMock, ReferenceProvider: config.ReferenceFixture})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// gateReader blocks every read until released or until ctx ends.
type gateReader struct {
	started   chan struct{}
	release   chan struct{}
	cancelled chan struct{}
	result    ai.ReadResult
}

func newGate(result ai.ReadResult) *gateReader {
	return &gateReader{
		started: make(chan struct{}, 64), release: make(chan struct{}),
		cancelled: make(chan struct{}, 64), result: result,
	}
}

func (g *gateReader) Read(ctx context.Context, _ [][]byte) (ai.ReadResult, error) {
	g.started <- struct{}{}
	select {
	case <-ctx.Done():
		g.cancelled <- struct{}{}
		return ai.ReadResult{Usage: ai.UsageEstimate}, ctx.Err()
	case <-g.release:
		return g.result, nil
	}
}

func waitFor(t testing.TB, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

// fixedReader returns its result at once.
type fixedReader struct{ result ai.ReadResult }

func (r fixedReader) Read(context.Context, [][]byte) (ai.ReadResult, error) { return r.result, nil }

type stubRefs struct{ result contracts.SearchResult }

func (s stubRefs) Search(context.Context, references.Query) contracts.SearchResult { return s.result }

// countingExplainer counts the explainer calls; it never explains.
type countingExplainer struct {
	mu    sync.Mutex
	calls int
}

func (e *countingExplainer) Explain(context.Context, string) (string, ai.Usage, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.calls++
	return "", ai.Usage{}, ai.ErrNoModel
}

func (e *countingExplainer) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.calls
}

func scenario(t testing.TB, id string) demo.Scenario {
	t.Helper()
	s, ok := demo.Get(id)
	if !ok {
		t.Fatalf("no scenario %s", id)
	}
	return s
}

// liveProviders are Muse Spark + PH FDA stand-ins: their results are not
// demo data.
func liveProviders(reader ai.LabelReader, search contracts.SearchResult, explainer ai.PhraseExplainer) ai.Providers {
	return ai.Providers{
		ModelProvider: config.ModelMuseSpark, ModelID: ai.MuseModel, ReferenceProvider: config.ReferencePHFDA,
		Reader: reader, Explainer: explainer, References: stubRefs{result: search},
	}
}

/* ------------------------------------------------------------ the service */

type svcOptions struct {
	providers *ai.Providers
	newID     func() string
	workers   int
	queue     int
}

func newService(t testing.TB, o svcOptions) *application.Service {
	t.Helper()
	p := mockProviders(t)
	if o.providers != nil {
		p = *o.providers
	}
	var meter *pipeline.SpendMeter
	if p.ModelProvider == config.ModelMuseSpark {
		meter = pipeline.NewSpendMeter(5, time.Now)
	}
	svc, err := application.New(application.Options{
		Providers: p, Meter: meter, NewID: o.newID, Workers: o.workers, QueueSize: o.queue,
	})
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
	return svc
}

/* ------------------------------------------------------------ MCP client */

// connect serves svc's tools over the in-memory transport and returns a
// connected client.
func connect(t testing.TB, svc Service) *mcp.ClientSession {
	t.Helper()
	return connectServer(t, NewServer(svc, Options{}))
}

func connectServer(t testing.TB, s *mcp.Server) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	st, ct := mcp.NewInMemoryTransports()
	ss, err := s.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ss.Close() })
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func call(t testing.TB, cs *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error %v", name, err)
	}
	return res
}

// ok decodes a successful call's structured content into T, and checks
// that the text content carries the same JSON.
func ok[T any](t testing.TB, res *mcp.CallToolResult) T {
	t.Helper()
	if res.IsError {
		t.Fatalf("tool error: %s", textOf(res))
	}
	b, err := json.Marshal(res.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	var out T
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		t.Fatalf("structured content %s: %v", b, err)
	}
	if len(b) > MaxOutputBytes {
		t.Errorf("structured content is %d bytes, over %d", len(b), MaxOutputBytes)
	}
	return out
}

func textOf(res *mcp.CallToolResult) string {
	var parts []string
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			parts = append(parts, tc.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// toolErr checks that the call failed as a tool error (IsError, no
// structured content) whose text starts with the code, and returns it.
func toolErr(t testing.TB, res *mcp.CallToolResult, code contracts.ErrorCode) string {
	t.Helper()
	text := textOf(res)
	if !res.IsError {
		t.Fatalf("want a %s tool error, got a result: %s", code, text)
	}
	if res.StructuredContent != nil {
		t.Errorf("an error carries structured content: %v", res.StructuredContent)
	}
	if !strings.HasPrefix(text, string(code)+": ") {
		t.Errorf("want code %s, got %q", code, text)
	}
	return text
}

func jsonOf(t testing.TB, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
