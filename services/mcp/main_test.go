package main

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/observability"
)

const token = "SECRET-token-0123456789abcdef"

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

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func noListen(t *testing.T) func(string, string) (net.Listener, error) {
	return func(string, string) (net.Listener, error) {
		t.Error("the server listened")
		return nil, errors.New("no")
	}
}

// The plan's startup test: a non-loopback bind with no tokens is refused
// before anything listens, with or without MCP_ALLOW_NO_AUTH=1.
func TestRefusesANonLoopbackBindWithNoTokens(t *testing.T) {
	for _, e := range []map[string]string{
		{"MCP_ADDR": "0.0.0.0:8788"},
		{"MCP_ADDR": ":8788"},
		{"MCP_ADDR": "192.168.1.20:8788"},
		{"MCP_ADDR": "0.0.0.0:8788", "MCP_ALLOW_NO_AUTH": "1"},
		{"MCP_ADDR": "[::]:8788", "MCP_ALLOW_NO_AUTH": "1"},
	} {
		var logs sink
		code := run(context.Background(), env(e), observability.New(&logs), noListen(t))
		if code != 1 || !strings.Contains(logs.String(), `"msg":"startup failed"`) || !strings.Contains(logs.String(), "MCP_API_TOKENS") {
			t.Errorf("%v: exit %d, log:\n%s", e, code, logs.String())
		}
	}
}

// Loopback without tokens still needs the explicit opt-out.
func TestRefusesLoopbackWithNoTokensUnlessAllowed(t *testing.T) {
	var logs sink
	if code := run(context.Background(), env(nil), observability.New(&logs), noListen(t)); code != 1 {
		t.Errorf("exit %d", code)
	}
	if !strings.Contains(logs.String(), "MCP_ALLOW_NO_AUTH") {
		t.Errorf("log:\n%s", logs.String())
	}
}

// A host name that binds off loopback is caught after the bind.
func TestRefusesAnOpenServerWhoseBoundAddressIsNotLoopback(t *testing.T) {
	var logs sink
	closed := make(chan struct{})
	code := run(context.Background(), env(map[string]string{"MCP_ALLOW_NO_AUTH": "1", "MCP_ADDR": "localhost:8788"}), observability.New(&logs),
		func(string, string) (net.Listener, error) {
			return fakeListener{addr: &net.TCPAddr{IP: net.IPv4zero, Port: 8788}, closed: closed}, nil
		})
	if code != 1 {
		t.Errorf("exit %d", code)
	}
	select {
	case <-closed:
	default:
		t.Error("the listener was not closed")
	}
}

type fakeListener struct {
	addr   net.Addr
	closed chan struct{}
}

func (f fakeListener) Accept() (net.Conn, error) { return nil, errors.New("fake") }
func (f fakeListener) Close() error              { close(f.closed); return nil }
func (f fakeListener) Addr() net.Addr            { return f.addr }

func TestMuseSparkWithoutAKeyFailsAtStartup(t *testing.T) {
	var logs sink
	code := run(context.Background(), env(map[string]string{"MODEL_PROVIDER": "muse_spark", "MCP_API_TOKENS": token}), observability.New(&logs), noListen(t))
	if code != 1 || !strings.Contains(logs.String(), "MODEL_API_KEY") {
		t.Errorf("exit %d, log:\n%s", code, logs.String())
	}
}

func TestAnInvalidSettingNamesTheVariableNeverItsValue(t *testing.T) {
	var logs sink
	code := run(context.Background(), env(map[string]string{
		"MCP_API_TOKENS": "SECRET-short", "MCP_ADDR": "SECRET-addr", "MCP_ALLOW_NO_AUTH": "SECRET-yes",
	}), observability.New(&logs), noListen(t))
	out := logs.String()
	if code != 1 || strings.Contains(out, "SECRET") {
		t.Errorf("exit %d, log:\n%s", code, out)
	}
	for _, name := range []string{"MCP_API_TOKENS", "MCP_ADDR", "MCP_ALLOW_NO_AUTH"} {
		if !strings.Contains(out, name) {
			t.Errorf("log lacks %s:\n%s", name, out)
		}
	}
}

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

// The binary serves the tools behind the token on a loopback port, logs
// no token, and stops cleanly when its context ends.
func TestServesWithATokenAndStops(t *testing.T) {
	var logs sink
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr := make(chan net.Addr, 1)
	exit := make(chan int, 1)
	go func() {
		exit <- run(ctx, env(map[string]string{"MCP_API_TOKENS": token, "MCP_ADDR": "127.0.0.1:0"}), observability.New(&logs),
			func(network, address string) (net.Listener, error) {
				ln, err := net.Listen(network, address)
				if err == nil {
					addr <- ln.Addr()
				}
				return ln, err
			})
	}()
	var a net.Addr
	select {
	case a = <-addr:
	case code := <-exit:
		t.Fatalf("exit %d before listening:\n%s", code, logs.String())
	case <-time.After(10 * time.Second):
		t.Fatal("never listened")
	}
	url := "http://" + a.String() + "/mcp"
	cctx, ccancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer ccancel()
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).
		Connect(cctx, &mcp.StreamableClientTransport{Endpoint: url, HTTPClient: &http.Client{Transport: bearer{token}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := cs.CallTool(cctx, &mcp.CallToolParams{Name: "extract_medication_label", Arguments: map[string]any{"scenario_id": "s1-clear"}})
	if err != nil || res.IsError {
		t.Fatalf("%+v %v", res, err)
	}
	_ = cs.Close()
	// no token: 401
	resp, err := http.Post(url, "application/json", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("no token: %d", resp.StatusCode)
	}
	cancel()
	select {
	case code := <-exit:
		if code != 0 {
			t.Errorf("exit %d:\n%s", code, logs.String())
		}
	case <-time.After(30 * time.Second):
		t.Fatal("did not stop")
	}
	out := logs.String()
	if strings.Contains(out, "SECRET") || strings.Contains(out, "Paracelin") {
		t.Errorf("the log shows a token or label text:\n%s", out)
	}
	for _, want := range []string{`"msg":"listening"`, `"auth":"bearer"`, `"tokens":1`, `"modelProvider":"mock"`, `"msg":"stopped"`} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %s:\n%s", want, out)
		}
	}
}
