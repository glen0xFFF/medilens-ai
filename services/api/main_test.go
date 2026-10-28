package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/observability"
)

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
		t.Error("the API listened")
		return nil, errors.New("no")
	}
}

// Go port spec §3: MODEL_PROVIDER=muse_spark without MODEL_API_KEY is a
// startup error: exit 1, before anything listens.
func TestMuseSparkWithoutAKeyFailsAtStartup(t *testing.T) {
	var logs sink
	code := run(context.Background(), env(map[string]string{"MODEL_PROVIDER": "muse_spark"}), observability.New(&logs), noListen(t))
	if code != 1 {
		t.Errorf("exit %d", code)
	}
	out := logs.String()
	if !strings.Contains(out, `"msg":"startup failed"`) || !strings.Contains(out, "MODEL_API_KEY") {
		t.Errorf("log:\n%s", out)
	}
}

func TestAnInvalidSettingNamesTheVariableNeverItsValue(t *testing.T) {
	var logs sink
	code := run(context.Background(), env(map[string]string{
		"MODEL_PROVIDER": "SECRET-provider", "PORT": "SECRET-port", "MODEL_API_KEY": "SECRET-key", "CORS_ORIGIN": "SECRET-origin",
	}), observability.New(&logs), noListen(t))
	out := logs.String()
	if code != 1 || strings.Contains(out, "SECRET") {
		t.Errorf("exit %d, log:\n%s", code, out)
	}
	for _, name := range []string{"MODEL_PROVIDER", "PORT", "CORS_ORIGIN"} {
		if !strings.Contains(out, name) {
			t.Errorf("log lacks %s:\n%s", name, out)
		}
	}
}

func TestABindFailureExits1(t *testing.T) {
	var logs sink
	code := run(context.Background(), env(map[string]string{"PORT": "9191"}), observability.New(&logs),
		func(string, string) (net.Listener, error) {
			return nil, &net.OpError{Op: "listen", Err: errors.New("SECRET in use")}
		})
	out := logs.String()
	if code != 1 || !strings.Contains(out, `"msg":"listen failed"`) || !strings.Contains(out, `"errorName":"*net.OpError"`) ||
		!strings.Contains(out, `"port":9191`) || strings.Contains(out, "SECRET") {
		t.Errorf("exit %d, log:\n%s", code, out)
	}
}

// The binary serves on PORT, logs its providers at startup, and shuts down
// cleanly when its context ends (SIGINT or SIGTERM in main).
func TestRunServesAndShutsDown(t *testing.T) {
	var logs sink
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var addr string
	listen := func(network, a string) (net.Listener, error) {
		addr = network + " " + a
		return ln, nil
	}
	ctx, stop := context.WithCancel(context.Background())
	exited := make(chan int, 1)
	go func() {
		exited <- run(ctx, env(map[string]string{"PORT": "9191", "CORS_ORIGIN": "http://localhost:8081/"}), observability.New(&logs), listen)
	}()
	base := "http://" + ln.Addr().String()
	client := &http.Client{Timeout: 2 * time.Second}
	var ready *http.Response
	for i := 0; i < 50; i++ {
		if ready, err = client.Get(base + "/readyz"); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil {
		stop()
		t.Fatal(err)
	}
	b, _ := io.ReadAll(ready.Body)
	ready.Body.Close()
	if ready.StatusCode != 200 || strings.TrimSpace(string(b)) != `{"status":"ready","checks":{"model":"mock","references":"fixture"}}` {
		t.Errorf("readyz %d %s", ready.StatusCode, b)
	}
	req, _ := http.NewRequest("GET", base+"/api/v1/config/capabilities", nil)
	req.Header.Set("Origin", "http://localhost:8081")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var caps map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&caps)
	resp.Body.Close()
	if caps["modelProvider"] != "mock" || resp.Header.Get("Access-Control-Allow-Origin") != "http://localhost:8081" {
		t.Errorf("capabilities %v, headers %v", caps, resp.Header)
	}
	if addr != "tcp :9191" {
		t.Errorf("listened on %q", addr)
	}

	stop()
	select {
	case code := <-exited:
		if code != 0 {
			t.Errorf("exit %d", code)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no shutdown")
	}
	out := logs.String()
	var listening map[string]any
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) == nil && m["msg"] == "listening" {
			listening = m
		}
	}
	if listening["port"] != float64(9191) || listening["provider"] != "mock" || listening["modelProvider"] != "mock" ||
		listening["modelId"] != "mock" || listening["referenceProvider"] != "fixture" {
		t.Errorf("listening line %v", listening)
	}
	if !strings.Contains(out, `"msg":"stopped"`) {
		t.Errorf("no stopped line:\n%s", out)
	}
}
