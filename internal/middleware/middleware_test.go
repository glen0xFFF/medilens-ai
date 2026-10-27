package middleware

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/observability"
)

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

func (s *sink) lines(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(s.String()), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("log line %q: %v", l, err)
		}
		out = append(out, m)
	}
	return out
}

func do(h http.Handler, r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// errorBody checks a contract error body: the status, the code, the
// request id of the response header, and no stack text.
func errorBody(t *testing.T, w *httptest.ResponseRecorder, status int, code contracts.ErrorCode) contracts.ErrorDetail {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d, want %d: %s", w.Code, status, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Errorf("Content-Type %q", ct)
	}
	var body map[string]map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", w.Body.String(), err)
	}
	e := body["error"]
	if len(body) != 1 || len(e) != 3 {
		t.Errorf("body shape %v", body)
	}
	if e["code"] != string(code) {
		t.Errorf("code %v, want %s", e["code"], code)
	}
	if e["requestId"] != w.Header().Get(RequestIDHeader) {
		t.Errorf("requestId %v, header %q", e["requestId"], w.Header().Get(RequestIDHeader))
	}
	for _, s := range []string{"stack", "at ", "goroutine", ".go:", "panic"} {
		if strings.Contains(w.Body.String(), s) {
			t.Errorf("error body contains %q: %s", s, w.Body.String())
		}
	}
	msg, _ := e["message"].(string)
	return contracts.ErrorDetail{Code: code, Message: msg, RequestID: e["requestId"].(string)}
}

/* ------------------------------------------------------------ request id */

func TestEveryResponseCarriesAFreshUUIDRequestID(t *testing.T) {
	var seen string
	h := RequestID(nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = RequestIDFrom(r.Context())
	}))
	a := do(h, httptest.NewRequest("GET", "/healthz", nil))
	if id := a.Header().Get("X-Request-Id"); !uuidV4.MatchString(id) || id != seen {
		t.Errorf("header %q, context %q", id, seen)
	}
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("X-Request-Id", "client-chosen-id")
	b := do(h, req)
	if id := b.Header().Get("X-Request-Id"); !uuidV4.MatchString(id) || id == a.Header().Get("X-Request-Id") {
		t.Errorf("second id %q", id)
	}
	if RequestIDFrom(httptest.NewRequest("GET", "/", nil).Context()) != "unknown" {
		t.Error("no request id should read as unknown, as in Node")
	}
}

// Final review M15: when a value cannot be encoded, the 500 body carries
// the request's own id (the X-Request-Id already set), not "unknown".
func TestAnUnencodableValueIsA500WithTheRequestID(t *testing.T) {
	h := RequestID(func() string { return "req-42" }, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteJSON(w, http.StatusOK, map[string]any{"bad": make(chan int)})
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/x", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status %d", rec.Code)
	}
	var body struct {
		Error struct{ Code, Message, RequestID string }
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "INTERNAL_ERROR" || body.Error.RequestID != "req-42" || rec.Header().Get(RequestIDHeader) != "req-42" {
		t.Errorf("body %s header %q", rec.Body.String(), rec.Header().Get(RequestIDHeader))
	}
}

func TestWriteError(t *testing.T) {
	h := RequestID(nil, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, r, http.StatusNotFound, contracts.ErrNotFound, "Not found.")
	}))
	w := do(h, httptest.NewRequest("GET", "/x", nil))
	if e := errorBody(t, w, 404, contracts.ErrNotFound); e.Message != "Not found." {
		t.Errorf("message %q", e.Message)
	}
}

/* ------------------------------------------------------------ access log */

func TestAccessLogIsOneLineOfMethodRouteStatusDurationAndRequestID(t *testing.T) {
	var logs sink
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/analyses/{id}/explanation", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusTeapot)
	})
	mux.HandleFunc("GET /plain", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte("ok")) })
	h := RequestID(nil, AccessLog(observability.New(&logs), mux))

	req := httptest.NewRequest("POST", "/api/v1/analyses/SECRET-id/explanation?token=SECRET-query",
		strings.NewReader(`{"question":"SECRET-question"}`))
	req.Header.Set("Authorization", "Bearer SECRET-token")
	w := do(h, req)
	do(h, httptest.NewRequest("GET", "/plain", nil))
	do(h, httptest.NewRequest("GET", "/nope/SECRET-path", nil))

	out := logs.String()
	if strings.Contains(out, "SECRET") {
		t.Errorf("log leaks a path, query, header or body:\n%s", out)
	}
	lines := logs.lines(t)
	if len(lines) != 3 {
		t.Fatalf("%d lines:\n%s", len(lines), out)
	}
	first := lines[0]
	want := map[string]any{
		"msg": "request", "method": "POST", "route": "POST /api/v1/analyses/{id}/explanation",
		"status": float64(418), "requestId": w.Header().Get(RequestIDHeader),
	}
	for k, v := range want {
		if first[k] != v {
			t.Errorf("%s = %v, want %v", k, first[k], v)
		}
	}
	if _, ok := first["durationMs"].(float64); !ok {
		t.Errorf("durationMs %v", first["durationMs"])
	}
	allowed := map[string]bool{"time": true, "level": true, "msg": true, "requestId": true, "method": true, "route": true, "status": true, "durationMs": true}
	for k := range first {
		if !allowed[k] {
			t.Errorf("unexpected key %q", k)
		}
	}
	if lines[1]["status"] != float64(200) || lines[1]["route"] != "GET /plain" {
		t.Errorf("implicit 200: %v", lines[1])
	}
	if lines[2]["status"] != float64(404) || lines[2]["route"] != "" {
		t.Errorf("no route: %v", lines[2])
	}
}

// http.ResponseController reaches Flush and SetWriteDeadline through the
// logging wrapper (it has Unwrap), which SSE needs.
func TestTheLoggingWrapperKeepsFlushAndDeadlines(t *testing.T) {
	var flushErr, deadlineErr error
	h := AccessLog(observability.New(io.Discard), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rc := http.NewResponseController(w)
		deadlineErr = rc.SetWriteDeadline(time.Time{})
		_, _ = w.Write([]byte("data: x\n\n"))
		flushErr = rc.Flush()
	}))
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if flushErr != nil || deadlineErr != nil {
		t.Errorf("flush %v, deadline %v", flushErr, deadlineErr)
	}
}

/* ------------------------------------------------------------ recover */

func TestAPanicIsA500WithNoStack(t *testing.T) {
	var logs sink
	h := RequestID(nil, AccessLog(observability.New(&logs), Recover(observability.New(&logs),
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic(fmt.Errorf("SECRET-panic-text at handler.go:12"))
		}))))
	w := do(h, httptest.NewRequest("GET", "/x", nil))
	e := errorBody(t, w, 500, contracts.ErrInternal)
	if e.Message != "Something went wrong. Please try again." {
		t.Errorf("message %q", e.Message)
	}
	out := logs.String()
	if strings.Contains(out, "SECRET") || strings.Contains(out, "goroutine") {
		t.Errorf("log leaks the panic:\n%s", out)
	}
	if !strings.Contains(out, `"msg":"panic recovered"`) || !strings.Contains(out, `"panicType":"*fmt.wrapError"`) &&
		!strings.Contains(out, `"panicType":"*errors.errorString"`) {
		t.Errorf("no panic line:\n%s", out)
	}
	if !strings.Contains(out, `"status":500`) {
		t.Errorf("the access log misses the 500:\n%s", out)
	}
}

func TestAPanicAfterTheHeadersAddsNothing(t *testing.T) {
	h := RequestID(nil, Recover(observability.New(io.Discard), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"id":"x"}`))
		panic("SECRET")
	})))
	w := do(h, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 202 || w.Body.String() != `{"id":"x"}` {
		t.Errorf("%d %q", w.Code, w.Body.String())
	}
}

func TestAbortHandlerIsNotSwallowed(t *testing.T) {
	h := Recover(observability.New(io.Discard), http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	defer func() {
		if p := recover(); p != http.ErrAbortHandler {
			t.Errorf("recovered %v", p)
		}
	}()
	do(h, httptest.NewRequest("GET", "/x", nil))
	t.Error("ErrAbortHandler was swallowed")
}

/* ------------------------------------------------------------ CORS */

func TestNoCORSHeadersWithoutAnOrigin(t *testing.T) {
	h := CORS("", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	req := httptest.NewRequest("GET", "/healthz", nil)
	req.Header.Set("Origin", "http://localhost:8081")
	w := do(h, req)
	if len(w.Header()) != 0 {
		t.Errorf("headers %v", w.Header())
	}
}

func TestCORSForTheConfiguredOriginOnly(t *testing.T) {
	reached := 0
	h := CORS("http://localhost:8081", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached++ }))
	get := func(origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/healthz", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return do(h, req)
	}
	ok := get("http://localhost:8081")
	if ok.Header().Get("Access-Control-Allow-Origin") != "http://localhost:8081" ||
		!strings.Contains(ok.Header().Get("Access-Control-Expose-Headers"), "X-Request-Id") ||
		ok.Header().Get("Vary") != "Origin" {
		t.Errorf("allowed origin: %v", ok.Header())
	}
	for _, origin := range []string{"https://evil.example.com", "http://localhost:8081/", "http://LOCALHOST:8081", ""} {
		w := get(origin)
		if w.Header().Get("Access-Control-Allow-Origin") != "" || w.Header().Get("Vary") != "Origin" {
			t.Errorf("origin %q: %v", origin, w.Header())
		}
	}
	if reached != 5 {
		t.Errorf("reached %d", reached)
	}

	pre := httptest.NewRequest("OPTIONS", "/api/v1/analyses/x", nil)
	pre.Header.Set("Origin", "http://localhost:8081")
	pre.Header.Set("Access-Control-Request-Method", "DELETE")
	w := do(h, pre)
	if w.Code != 204 || reached != 5 {
		t.Fatalf("preflight %d, reached %d", w.Code, reached)
	}
	for k, want := range map[string]string{
		"Access-Control-Allow-Origin":  "http://localhost:8081",
		"Access-Control-Allow-Methods": "GET, POST, DELETE",
		"Access-Control-Allow-Headers": "Content-Type, Last-Event-ID",
		"Access-Control-Max-Age":       "600",
	} {
		if got := w.Header().Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	other := httptest.NewRequest("OPTIONS", "/api/v1/analyses/x", nil)
	other.Header.Set("Origin", "https://evil.example.com")
	if w := do(h, other); w.Header().Get("Access-Control-Allow-Origin") != "" || reached != 6 {
		t.Errorf("foreign preflight: %v, reached %d", w.Header(), reached)
	}
}

/* ------------------------------------------------------------ client ip */

func TestClientIP(t *testing.T) {
	trusted := []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")}
	for _, c := range []struct {
		remote string
		xff    []string
		want   string
	}{
		{"203.0.113.9:5555", []string{"1.2.3.4"}, "203.0.113.9"},
		{"10.1.2.3:5555", []string{"6.6.6.6, 198.51.100.7, 10.9.9.9"}, "198.51.100.7"},
		{"10.1.2.3:5555", []string{"6.6.6.6", "198.51.100.7,10.9.9.9"}, "198.51.100.7"},
		{"10.1.2.3:5555", nil, "10.1.2.3"},
		{"10.1.2.3:5555", []string{"10.4.4.4, 10.9.9.9"}, "10.1.2.3"},
		{"10.1.2.3:5555", []string{"6.6.6.6, not-an-ip"}, "10.1.2.3"},
		{"[::ffff:203.0.113.9]:1", nil, "203.0.113.9"},
		{"[::ffff:10.1.2.3]:1", []string{"198.51.100.8"}, "198.51.100.8"},
		{"10.1.2.3:5555", []string{"::ffff:198.51.100.9"}, "198.51.100.9"},
		{"[2001:db8::1]:443", []string{"1.2.3.4"}, "2001:db8::1"},
	} {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = c.remote
		for _, v := range c.xff {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := ClientIP(r, trusted); got.String() != c.want {
			t.Errorf("%s %v: %v, want %s", c.remote, c.xff, got, c.want)
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.1.2.3:5555"
	r.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := ClientIP(r, nil); got.String() != "10.1.2.3" {
		t.Errorf("no trusted proxies: %v", got)
	}
}

/* ------------------------------------------------------------ rate limit */

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func limited(t *testing.T, trusted []netip.Prefix) (http.Handler, *fakeClock, *RateLimiter) {
	t.Helper()
	clock := &fakeClock{t: time.Date(2026, 10, 28, 8, 0, 0, 0, time.UTC)}
	l := NewRateLimiter(RateLimitOptions{TrustedProxies: trusted, Now: clock.now})
	return RequestID(nil, l.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))), clock, l
}

func call(h http.Handler, method, path, remote string, xff ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = remote
	for _, v := range xff {
		r.Header.Add("X-Forwarded-For", v)
	}
	return do(h, r)
}

func spend(t *testing.T, h http.Handler, n int, method, path, remote string, xff ...string) {
	t.Helper()
	for i := 0; i < n; i++ {
		if w := call(h, method, path, remote, xff...); w.Code != 200 {
			t.Fatalf("request %d: %d %s", i+1, w.Code, w.Body.String())
		}
	}
}

// Go port spec §4: write routes (POST, DELETE) 30 a minute, read routes
// (GET) 240 a minute, per client address, as token buckets.
func TestWriteRoutesAre30AMinute(t *testing.T) {
	if WriteRequestsPerMinute != 30 || ReadRequestsPerMinute != 240 {
		t.Fatalf("limits %d %d", WriteRequestsPerMinute, ReadRequestsPerMinute)
	}
	h, clock, _ := limited(t, nil)
	spend(t, h, 20, "POST", "/api/v1/analyses", "203.0.113.1:1")
	spend(t, h, 10, "DELETE", "/api/v1/analyses/x", "203.0.113.1:1")
	w := call(h, "POST", "/api/v1/demo/scenarios", "203.0.113.1:1")
	e := errorBody(t, w, 429, contracts.ErrRateLimited)
	if e.Message != "Too many requests. Please wait a minute and try again." {
		t.Errorf("message %q", e.Message)
	}
	if ra := w.Header().Get("Retry-After"); ra != "2" {
		t.Errorf("Retry-After %q", ra)
	}
	// reads have their own bucket
	spend(t, h, 240, "GET", "/api/v1/analyses/x", "203.0.113.1:1")
	// one write token comes back every 2 s
	clock.advance(2 * time.Second)
	spend(t, h, 1, "POST", "/api/v1/analyses", "203.0.113.1:1")
	if w := call(h, "POST", "/api/v1/analyses", "203.0.113.1:1"); w.Code != 429 {
		t.Errorf("after one refill: %d", w.Code)
	}
}

func TestReadRoutesAre240AMinute(t *testing.T) {
	h, clock, _ := limited(t, nil)
	spend(t, h, 200, "GET", "/api/v1/analyses/x", "203.0.113.2:1")
	spend(t, h, 40, "HEAD", "/api/v1/analyses/x/events", "203.0.113.2:1")
	w := call(h, "GET", "/api/v1/config/capabilities", "203.0.113.2:1")
	errorBody(t, w, 429, contracts.ErrRateLimited)
	if ra := w.Header().Get("Retry-After"); ra != "1" {
		t.Errorf("Retry-After %q", ra)
	}
	spend(t, h, 30, "POST", "/api/v1/analyses", "203.0.113.2:1")
	clock.advance(250 * time.Millisecond)
	spend(t, h, 1, "GET", "/api/v1/analyses/x", "203.0.113.2:1")
}

func TestOnlyAPIRoutesAreLimited(t *testing.T) {
	h, _, _ := limited(t, nil)
	spend(t, h, 300, "GET", "/healthz", "203.0.113.3:1")
	spend(t, h, 300, "GET", "/readyz", "203.0.113.3:1")
	spend(t, h, 40, "POST", "/nope", "203.0.113.3:1")
}

func TestEachClientHasItsOwnBudget(t *testing.T) {
	h, _, _ := limited(t, nil)
	spend(t, h, 30, "POST", "/api/v1/analyses", "203.0.113.4:1")
	errorBody(t, call(h, "POST", "/api/v1/analyses", "203.0.113.4:2"), 429, contracts.ErrRateLimited)
	spend(t, h, 30, "POST", "/api/v1/analyses", "203.0.113.5:1")
	// an IPv6 client is keyed by its /56, as express-rate-limit v8 does
	spend(t, h, 30, "POST", "/api/v1/analyses", "[2001:db8:0:1::1]:1")
	errorBody(t, call(h, "POST", "/api/v1/analyses", "[2001:db8:0:ff::2]:1"), 429, contracts.ErrRateLimited)
	spend(t, h, 1, "POST", "/api/v1/analyses", "[2001:db8:0:100::1]:1")
}

func TestForwardedForCountsOnlyBehindATrustedProxy(t *testing.T) {
	h, _, _ := limited(t, []netip.Prefix{netip.MustParsePrefix("10.0.0.0/8")})
	spend(t, h, 30, "POST", "/api/v1/analyses", "10.0.0.2:1", "203.0.113.1")
	errorBody(t, call(h, "POST", "/api/v1/analyses", "10.0.0.2:1", "203.0.113.1"), 429, contracts.ErrRateLimited)
	spend(t, h, 30, "POST", "/api/v1/analyses", "10.0.0.2:1", "203.0.113.2")

	// not behind a trusted proxy: X-Forwarded-For changes nothing
	u, _, _ := limited(t, nil)
	spend(t, u, 30, "POST", "/api/v1/analyses", "198.51.100.1:1", "203.0.113.1")
	errorBody(t, call(u, "POST", "/api/v1/analyses", "198.51.100.1:1", "203.0.113.2"), 429, contracts.ErrRateLimited)
}

func TestIdleClientsAreForgotten(t *testing.T) {
	h, clock, l := limited(t, nil)
	for i := 0; i < 50; i++ {
		spend(t, h, 1, "GET", "/api/v1/analyses/x", fmt.Sprintf("203.0.113.%d:1", i))
	}
	if n := l.clients(); n != 50 {
		t.Fatalf("%d clients", n)
	}
	clock.advance(10 * time.Minute)
	spend(t, h, 1, "GET", "/api/v1/analyses/x", "198.51.100.1:1")
	if n := l.clients(); n != 1 {
		t.Errorf("%d clients after the sweep", n)
	}
}

// The 429 is a full contract error body, never the bare text of http.Error.
func TestRateLimitBodyIsJSONOnARealServer(t *testing.T) {
	h, _, _ := limited(t, nil)
	srv := httptest.NewServer(h)
	defer srv.Close()
	var last *http.Response
	for i := 0; i < 31; i++ {
		resp, err := http.Post(srv.URL+"/api/v1/analyses", "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		if last != nil {
			last.Body.Close()
		}
		last = resp
	}
	defer last.Body.Close()
	line, _ := bufio.NewReader(last.Body).ReadString('\n')
	if last.StatusCode != 429 || !strings.HasPrefix(line, `{"error":{"code":"RATE_LIMITED"`) {
		t.Errorf("%d %q", last.StatusCode, line)
	}
}
