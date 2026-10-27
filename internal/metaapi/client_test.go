package metaapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testKey = "sk-test-not-a-real-key-123"

// step is one canned API response: a status, optional headers and a body,
// a request that hangs until the client gives up, or a dropped connection.
type step struct {
	status  int
	header  map[string]string
	body    string
	hang    bool
	dropped bool
}

const okBody = `{"id":"x","model":"muse-spark-1.3","choices":[{"index":0,"message":{"role":"assistant","content":"{}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}`

type seen struct {
	method, path, auth, contentType, accept string
	body                                    []byte
}

type fakeMeta struct {
	srv   *httptest.Server
	mu    sync.Mutex
	steps []step
	calls []seen
}

func newFakeMeta(t *testing.T, steps ...step) *fakeMeta {
	t.Helper()
	f := &fakeMeta{steps: steps}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.calls = append(f.calls, seen{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), r.Header.Get("Accept"), b})
		if len(f.steps) == 0 {
			f.mu.Unlock()
			w.WriteHeader(599)
			return
		}
		s := f.steps[0]
		f.steps = f.steps[1:]
		f.mu.Unlock()
		switch {
		case s.hang:
			<-r.Context().Done()
		case s.dropped:
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				conn.Close()
			}
		default:
			for k, v := range s.header {
				w.Header().Set(k, v)
			}
			w.WriteHeader(s.status)
			_, _ = io.WriteString(w, s.body)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeMeta) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

// sleeps records each wait the client asks for, without waiting.
type sleeps struct {
	mu    sync.Mutex
	waits []time.Duration
}

func (s *sleeps) sleep(ctx context.Context, d time.Duration) error {
	s.mu.Lock()
	s.waits = append(s.waits, d)
	s.mu.Unlock()
	return ctx.Err()
}

func client(t *testing.T, f *fakeMeta, opts ...Option) (*Client, *sleeps) {
	t.Helper()
	s := &sleeps{}
	c, err := New(testKey, append([]Option{WithBaseURL(f.srv.URL + "/v1"), WithSleep(s.sleep)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	return c, s
}

func request() *ChatRequest {
	return &ChatRequest{
		Model:               "muse-spark-1.3",
		ReasoningEffort:     "low",
		MaxCompletionTokens: 4000,
		Messages: []Message{
			{Role: "system", Content: "Transcribe only."},
			{Role: "user", Content: []ContentPart{TextPart("Read this."), ImagePart("data:image/jpeg;base64,/9j/")}},
		},
		ResponseFormat: &ResponseFormat{
			Type:       "json_schema",
			JSONSchema: JSONSchema{Name: "medicine_label", Schema: json.RawMessage(`{"type":"object"}`), Strict: true},
		},
	}
}

func TestConstants(t *testing.T) {
	if BaseURL != "https://api.meta.ai/v1" {
		t.Errorf("BaseURL %q", BaseURL)
	}
	if Timeout != 45*time.Second {
		t.Errorf("Timeout %v", Timeout)
	}
}

func TestNewRequiresAKeyAndNeverEchoesIt(t *testing.T) {
	for _, k := range []string{"", "   "} {
		if _, err := New(k); err == nil {
			t.Errorf("New(%q) accepted a blank key", k)
		}
	}
	c, err := New(testKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x"} {
		for _, v := range []any{c, *c} {
			if out := fmt.Sprintf(verb, v); strings.Contains(out, testKey) || strings.Contains(out, fmt.Sprintf("%x", testKey)) {
				t.Errorf("%s of the client (%T) prints the key: %s", verb, v, out)
			}
		}
	}
}

func TestCompleteSendsOneJSONPostWithTheKey(t *testing.T) {
	f := newFakeMeta(t, step{status: 200, body: okBody})
	c, _ := client(t, f)
	res, failed, err := c.Complete(context.Background(), request())
	if err != nil || len(failed) != 0 {
		t.Fatalf("err %v, failed %v", err, failed)
	}
	if string(res.Model) != `"muse-spark-1.3"` || res.Usage == nil || res.Choices == nil {
		t.Errorf("response %+v", res)
	}
	got := f.calls[0]
	if got.method != http.MethodPost || got.path != "/v1/chat/completions" || got.auth != "Bearer "+testKey ||
		got.contentType != "application/json" || got.accept != "application/json" {
		t.Errorf("request %+v", got)
	}
	var body map[string]any
	if err := json.Unmarshal(got.body, &body); err != nil {
		t.Fatal(err)
	}
	want := `{"max_completion_tokens":4000,"messages":[{"content":"Transcribe only.","role":"system"},` +
		`{"content":[{"text":"Read this.","type":"text"},{"image_url":{"url":"data:image/jpeg;base64,/9j/"},"type":"image_url"}],"role":"user"}],` +
		`"model":"muse-spark-1.3","reasoning_effort":"low",` +
		`"response_format":{"json_schema":{"name":"medicine_label","schema":{"type":"object"},"strict":true},"type":"json_schema"}}`
	if b, _ := json.Marshal(body); string(b) != want {
		t.Errorf("body\n got %s\nwant %s", b, want)
	}
	if _, ok := body["stream"]; ok {
		t.Error("stream sent")
	}
}

// Spec §3: retry at most once, only on 429, 500 and 503, honouring
// Retry-After.
func TestRetriesOnceOn429500503(t *testing.T) {
	for _, status := range []int{429, 500, 503} {
		f := newFakeMeta(t, step{status: status, header: map[string]string{"Retry-After": "2"}, body: `{"error":{"message":"busy"}}`}, step{status: 200, body: okBody})
		c, s := client(t, f)
		res, failed, err := c.Complete(context.Background(), request())
		if err != nil || res == nil {
			t.Fatalf("%d: err %v", status, err)
		}
		if f.count() != 2 || len(failed) != 1 || failed[0].Status != status || failed[0].Kind != KindHTTPStatus {
			t.Errorf("%d: calls %d, failed %+v", status, f.count(), failed)
		}
		if len(s.waits) != 1 || s.waits[0] != 2*time.Second {
			t.Errorf("%d: waits %v, want [2s]", status, s.waits)
		}
	}
}

func TestRetryWithoutRetryAfterWaitsTheDefault(t *testing.T) {
	f := newFakeMeta(t, step{status: 500}, step{status: 200, body: okBody})
	c, s := client(t, f)
	if _, _, err := c.Complete(context.Background(), request()); err != nil {
		t.Fatal(err)
	}
	if len(s.waits) != 1 || s.waits[0] != DefaultRetryWait {
		t.Errorf("waits %v", s.waits)
	}
}

func TestRetryAfterAsAnHTTPDate(t *testing.T) {
	now := time.Date(2026, 10, 28, 1, 0, 0, 0, time.UTC)
	f := newFakeMeta(t, step{status: 429, header: map[string]string{"Retry-After": now.Add(3 * time.Second).Format(http.TimeFormat)}}, step{status: 200, body: okBody})
	c, s := client(t, f, WithNow(func() time.Time { return now }))
	if _, _, err := c.Complete(context.Background(), request()); err != nil {
		t.Fatal(err)
	}
	if len(s.waits) != 1 || s.waits[0] != 3*time.Second {
		t.Errorf("waits %v", s.waits)
	}
}

// Meta: do not retry a 504 (stream, lower the effort or shrink the input),
// nor 400/401/402/403/404/413.
func TestNeverRetries504OrAClientError(t *testing.T) {
	for _, status := range []int{504, 400, 401, 402, 403, 404, 413, 422, 502} {
		f := newFakeMeta(t, step{status: status, body: `{"error":{"message":"no"}}`}, step{status: 200, body: okBody})
		c, s := client(t, f)
		res, failed, err := c.Complete(context.Background(), request())
		var e *Error
		if res != nil || !errors.As(err, &e) || e.Status != status || e.Kind != KindHTTPStatus {
			t.Errorf("%d: res %v, err %v", status, res, err)
		}
		if f.count() != 1 || len(failed) != 1 || len(s.waits) != 0 {
			t.Errorf("%d: calls %d, failed %d, waits %v", status, f.count(), len(failed), s.waits)
		}
	}
}

func TestAtMostOneRetry(t *testing.T) {
	f := newFakeMeta(t, step{status: 503}, step{status: 503}, step{status: 200, body: okBody})
	c, _ := client(t, f)
	_, failed, err := c.Complete(context.Background(), request())
	var e *Error
	if !errors.As(err, &e) || e.Status != 503 {
		t.Fatalf("err %v", err)
	}
	if f.count() != 2 || len(failed) != 2 || failed[1] != e {
		t.Errorf("calls %d, failed %+v", f.count(), failed)
	}
}

// A Retry-After the time budget cannot honour is not retried early: the
// error is returned.
func TestRetryAfterBeyondTheBudgetIsNotRetried(t *testing.T) {
	f := newFakeMeta(t, step{status: 503, header: map[string]string{"Retry-After": "60"}}, step{status: 200, body: okBody})
	c, s := client(t, f)
	_, failed, err := c.Complete(context.Background(), request())
	if err == nil || f.count() != 1 || len(failed) != 1 || len(s.waits) != 0 {
		t.Errorf("err %v, calls %d, waits %v", err, f.count(), s.waits)
	}
	if failed[0].RetryAfter != 60*time.Second {
		t.Errorf("RetryAfter %v", failed[0].RetryAfter)
	}
}

func TestTimeoutIsAnErrorWithNoStatus(t *testing.T) {
	f := newFakeMeta(t, step{hang: true})
	c, _ := client(t, f, WithTimeout(100*time.Millisecond))
	start := time.Now()
	_, failed, err := c.Complete(context.Background(), request())
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindTimeout || e.Status != 0 || !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err %#v", err)
	}
	if len(failed) != 1 || f.count() != 1 {
		t.Errorf("failed %d, calls %d", len(failed), f.count())
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Errorf("took %v", d)
	}
}

func TestDroppedConnectionIsANetworkError(t *testing.T) {
	f := newFakeMeta(t, step{dropped: true}, step{status: 200, body: okBody})
	c, _ := client(t, f)
	_, failed, err := c.Complete(context.Background(), request())
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindNetwork || e.Status != 0 {
		t.Errorf("err %v", err)
	}
	// only HTTP 429/500/503 are retried
	if f.count() != 1 || len(failed) != 1 {
		t.Errorf("calls %d", f.count())
	}
}

func TestCancelledContextIsCanceled(t *testing.T) {
	f := newFakeMeta(t, step{hang: true})
	c, _ := client(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()
	_, _, err := c.Complete(ctx, request())
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindCanceled || !errors.Is(err, context.Canceled) {
		t.Errorf("err %v", err)
	}
}

// Final review Minor 12: an error carries a kind and a status, never the
// response body (it can echo request details) and never the key.
func TestErrorTextHasNoBodyAndNoKey(t *testing.T) {
	f := newFakeMeta(t, step{status: 401, body: `{"error":{"message":"Incorrect API key provided: ` + testKey + `"}}`})
	c, _ := client(t, f)
	_, _, err := c.Complete(context.Background(), request())
	if err == nil {
		t.Fatal("no error")
	}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s"} {
		out := fmt.Sprintf(verb, err)
		if strings.Contains(out, testKey) || strings.Contains(out, "Incorrect") {
			t.Errorf("%s of the error leaks: %s", verb, out)
		}
	}
	if !strings.Contains(err.Error(), "401") {
		t.Errorf("error %q has no status", err.Error())
	}
}

func TestUndecodableSuccessIsADecodeError(t *testing.T) {
	for _, body := range []string{"<html>busy</html>", "[]", "null", `{"model":"m"} trailing`, "", `"text"`} {
		f := newFakeMeta(t, step{status: 200, body: body}, step{status: 200, body: okBody})
		c, _ := client(t, f)
		_, failed, err := c.Complete(context.Background(), request())
		var e *Error
		if !errors.As(err, &e) || e.Kind != KindDecode || e.Status != 200 {
			t.Errorf("%q: err %v", body, err)
		}
		if f.count() != 1 || len(failed) != 1 {
			t.Errorf("%q: calls %d", body, f.count())
		}
	}
}

func TestOversizedResponseIsADecodeError(t *testing.T) {
	big := `{"model":"m","pad":"` + strings.Repeat("x", MaxResponseBytes) + `"}`
	f := newFakeMeta(t, step{status: 200, body: big})
	c, _ := client(t, f)
	_, _, err := c.Complete(context.Background(), request())
	var e *Error
	if !errors.As(err, &e) || e.Kind != KindDecode {
		t.Errorf("err %v", err)
	}
}

// Keys are matched exactly, as JS property access: encoding/json's
// case-insensitive field matching must not read "Model" as "model".
func TestResponseKeysAreExact(t *testing.T) {
	f := newFakeMeta(t, step{status: 200, body: `{"Model":"muse-spark-1.3","CHOICES":[],"Usage":{}}`})
	c, _ := client(t, f)
	res, _, err := c.Complete(context.Background(), request())
	if err != nil {
		t.Fatal(err)
	}
	if res.Model != nil || res.Choices != nil || res.Usage != nil {
		t.Errorf("response %+v", res)
	}
	f2 := newFakeMeta(t, step{status: 200, body: `{"model":"a","model":"b"}`})
	c2, _ := client(t, f2)
	res2, _, _ := c2.Complete(context.Background(), request())
	if string(res2.Model) != `"b"` {
		t.Errorf("duplicate key: %s, want the last as JSON.parse", res2.Model)
	}
}

func TestAny2xxIsSuccess(t *testing.T) {
	f := newFakeMeta(t, step{status: 201, body: okBody})
	c, _ := client(t, f)
	if _, _, err := c.Complete(context.Background(), request()); err != nil {
		t.Errorf("201: %v", err)
	}
}

func TestErrorString(t *testing.T) {
	e := &Error{Kind: KindHTTPStatus, Status: 429}
	if e.Error() != "meta api: http_status (status 429)" {
		t.Errorf("%q", e.Error())
	}
	e = &Error{Kind: KindTimeout}
	if e.Error() != "meta api: timeout" {
		t.Errorf("%q", e.Error())
	}
}
