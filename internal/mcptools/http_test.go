package mcptools

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
)

// statusRecorder adds a bearer token to every request and records every
// response status.
type statusRecorder struct {
	token    string
	mu       sync.Mutex
	statuses []int
}

func (s *statusRecorder) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	if s.token != "" {
		r.Header.Set("Authorization", "Bearer "+s.token)
	}
	res, err := http.DefaultTransport.RoundTrip(r)
	if err == nil {
		s.mu.Lock()
		s.statuses = append(s.statuses, res.StatusCode)
		s.mu.Unlock()
	}
	return res, err
}

func (s *statusRecorder) all() []int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]int(nil), s.statuses...)
}

func httpServer(t *testing.T, cfg Config) *httptest.Server {
	t.Helper()
	return httpServerFor(t, newService(t, svcOptions{}), cfg)
}

func httpServerFor(t *testing.T, svc Service, cfg Config) *httptest.Server {
	t.Helper()
	h, err := NewHTTPHandler(NewServer(svc, Options{}), cfg)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle(Path, h)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

// A raw JSON-RPC POST, as a client would send it.
func rawPost(t *testing.T, url, authorization string, body string, header map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest("POST", url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	for k, v := range header {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	return res
}

const pingBody = `{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}`

// The plan's HTTP test: stateless Streamable HTTP behind bearer auth. A
// valid token is served (200) through the real SDK client; an invalid,
// missing or malformed one is 401 before the MCP handler runs.
func TestStreamableHTTPWithBearerTokens(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{"MCP_API_TOKENS": tokenA + "," + tokenB}))
	if err != nil {
		t.Fatal(err)
	}
	ts := httpServer(t, cfg)

	rec := &statusRecorder{token: tokenB}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).
		Connect(ctx, &mcp.StreamableClientTransport{Endpoint: ts.URL + Path, HTTPClient: &http.Client{Transport: rec}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cs.Close() }()
	if v := cs.InitializeResult().ProtocolVersion; v != "2026-07-28" {
		t.Errorf("protocol %s: the stateless revision was not negotiated", v)
	}
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "extract_medication_label", Arguments: map[string]any{"scenario_id": "s1-clear"}})
	if err != nil {
		t.Fatal(err)
	}
	out := ok[ExtractOutput](t, res)
	if !out.IsDemo || out.AnalysisID == "" {
		t.Fatalf("%+v", out)
	}
	// stateless: the follow-up call on a new request finds the analysis
	ok[CompareOutput](t, call(t, cs, "compare_medication_evidence", map[string]any{"analysis_id": out.AnalysisID}))
	statuses := rec.all()
	if len(statuses) == 0 {
		t.Fatal("no request was made")
	}
	for _, s := range statuses {
		if s != http.StatusOK {
			t.Errorf("statuses %v, want all 200", statuses)
			break
		}
	}

	for _, authz := range []string{
		"Bearer SECRET-token-cccccccccccccccc", // unknown
		"Bearer " + tokenA[:len(tokenA)-1],     // a prefix
		"Bearer " + tokenA + "x",               // an extension
		"Bearer " + strings.ToUpper(tokenA),    // case
		"Basic " + tokenA,                      // another scheme
		"Bearer",                               // no token
		"Bearer " + tokenA + " " + tokenB,      // two tokens
		"",                                     // none
	} {
		res := rawPost(t, ts.URL+Path, authz, pingBody, nil)
		body, _ := io.ReadAll(res.Body)
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%q: status %d", authz, res.StatusCode)
		}
		if bytes.Contains(body, []byte("SECRET")) || bytes.Contains(body, []byte("aaaa")) {
			t.Errorf("%q: the 401 body shows a token: %s", authz, body)
		}
	}
}

// Without tokens (MCP_ALLOW_NO_AUTH=1 on loopback) the handler is open,
// but still keeps the SDK's DNS-rebinding guard and refuses cross-site
// browser requests.
func TestOpenLoopbackHandlerKeepsTheBrowserGuards(t *testing.T) {
	cfg, err := LoadConfig(env(map[string]string{"MCP_ALLOW_NO_AUTH": "1"}))
	if err != nil {
		t.Fatal(err)
	}
	ts := httpServer(t, cfg)
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).
		Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: ts.URL + Path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"scenario_id": "s1-clear"}))
	_ = cs.Close()

	// a page on another site posting to the local server
	if res := rawPost(t, ts.URL+Path, "", pingBody, map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://attacker.example"}); res.StatusCode != http.StatusForbidden {
		t.Errorf("cross-site request: status %d", res.StatusCode)
	}
	// DNS rebinding: a loopback connection naming a foreign host
	req, _ := http.NewRequest("POST", ts.URL+Path, strings.NewReader(pingBody))
	req.Host = "attacker.example"
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusForbidden {
		t.Errorf("foreign Host header: status %d", res.StatusCode)
	}
}

// PropagateRequestCancellation: a client that cancels over HTTP stops the
// analysis its call started (job cancelled, analysis deleted).
func TestHTTPCancellationReachesTheTool(t *testing.T) {
	const id = "00000000-0000-4000-8000-0000000000bb"
	g := newGate(ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel})
	p := liveProviders(g, scenario(t, "s1-clear").Reference, &countingExplainer{})
	svc := newService(t, svcOptions{providers: &p, newID: func() string { return id }})
	cfg, err := LoadConfig(env(map[string]string{"MCP_API_TOKENS": tokenA}))
	if err != nil {
		t.Fatal(err)
	}
	ts := httpServerFor(t, svc, cfg)
	// runs before the server's cleanup: if the cancellation never reached
	// the tool, its read is let go so the test fails instead of hanging
	t.Cleanup(func() { close(g.release) })
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).
		Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: ts.URL + Path, HTTPClient: &http.Client{Transport: &statusRecorder{token: tokenA}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cs.Close() }()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "extract_medication_label", Arguments: map[string]any{"images_base64": []string{b64(sharp(t))}}})
		done <- err
	}()
	waitFor(t, g.started, "the read")
	cancel()
	if err := <-done; err == nil {
		t.Error("the cancelled call returned a result")
	}
	waitFor(t, g.cancelled, "the job's cancellation")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := svc.Status(id); isCode(err, contracts.ErrNotFound) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the abandoned analysis is still stored")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Go port spec §5: request bodies are capped at 30 MiB (413 over it).
func TestRequestBodiesAreCappedAt30MiB(t *testing.T) {
	if MaxRequestBodyBytes != 30<<20 {
		t.Fatalf("MaxRequestBodyBytes %d", MaxRequestBodyBytes)
	}
	cfg, err := LoadConfig(env(map[string]string{"MCP_API_TOKENS": tokenA}))
	if err != nil {
		t.Fatal(err)
	}
	ts := httpServer(t, cfg)
	body := `{"jsonrpc":"2.0","id":1,"method":"ping","params":{},"pad":"` + strings.Repeat(" ", MaxRequestBodyBytes) + `"}`
	if res := rawPost(t, ts.URL+Path, "Bearer "+tokenA, body, nil); res.StatusCode != http.StatusRequestEntityTooLarge {
		t.Errorf("status %d", res.StatusCode)
	}
}
