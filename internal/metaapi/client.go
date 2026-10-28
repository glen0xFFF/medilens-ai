// Package metaapi is a hand-written net/http client for the Meta Model API
// chat completions endpoint (Go port spec §3), the only Meta surface
// MediLens uses. The API is OpenAI-compatible; there is no Meta Go SDK, and
// a generic OpenAI SDK would retry a 504 and read OPENAI_* environment
// variables, which Meta's guidance and this project rule out.
//
// Facts used here, from apps/server/src/providers/museSpark.ts and Meta's
// docs (research note muse.md): base URL https://api.meta.ai/v1, bearer-key
// auth, POST /chat/completions, non-streaming. No live call has been made
// from Go; a response is treated as untrusted until checked by the caller.
//
// Retries: at most one, only after HTTP 429, 500 or 503, after the
// response's Retry-After (or DefaultRetryWait without one), and only when
// that wait fits in the request's time budget. A 504 is never retried
// (Meta: a non-streaming request that ran past the server limit; retrying
// it is billed again), nor any other status, timeout or network error.
//
// Errors carry a kind, the HTTP status and Retry-After only: never the
// response body (it can echo request details) and never the key.
package metaapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	// BaseURL is the Meta Model API base URL.
	BaseURL = "https://api.meta.ai/v1"
	// Timeout bounds one Complete call, both attempts and the wait between
	// them included (the Node client gave up at 45 s, final review Minor 10).
	Timeout = 45 * time.Second
	// DefaultRetryWait is the wait before the retry when the response has
	// no usable Retry-After.
	DefaultRetryWait = time.Second
	// MaxResponseBytes bounds a response body; a larger one is a decode
	// error. A 4000-token completion is far smaller.
	MaxResponseBytes = 4 << 20
)

// ErrorKind says how an attempt failed.
type ErrorKind string

// The error kinds.
const (
	KindHTTPStatus ErrorKind = "http_status" // a non-2xx response
	KindTimeout    ErrorKind = "timeout"     // the time budget ran out
	KindCanceled   ErrorKind = "canceled"    // the caller's context ended
	KindNetwork    ErrorKind = "network"     // no response: connection, DNS, TLS
	KindDecode     ErrorKind = "decode"      // a 2xx body that is not a JSON object
)

// Error is one failed attempt. Status is 0 when there was no HTTP
// response. The text never contains a response body or the key.
type Error struct {
	Kind   ErrorKind
	Status int
	// RetryAfter is the response's Retry-After as a wait, when it had one.
	RetryAfter    time.Duration
	HasRetryAfter bool
	cause         error
}

func (e *Error) Error() string {
	if e.Status == 0 {
		return "meta api: " + string(e.Kind)
	}
	return "meta api: " + string(e.Kind) + " (status " + strconv.Itoa(e.Status) + ")"
}

// Unwrap gives the underlying error, for errors.Is checks such as
// context.DeadlineExceeded.
func (e *Error) Unwrap() error { return e.cause }

// ChatRequest is a non-streaming chat completions request.
type ChatRequest struct {
	Model               string          `json:"model"`
	ReasoningEffort     string          `json:"reasoning_effort"`
	MaxCompletionTokens int             `json:"max_completion_tokens"`
	Messages            []Message       `json:"messages"`
	ResponseFormat      *ResponseFormat `json:"response_format,omitempty"`
}

// Message is a chat message. Content is a string or []ContentPart.
type Message struct {
	Role    string `json:"role"`
	Content any    `json:"content"`
}

// ContentPart is a text or image_url part of a user message.
type ContentPart struct {
	Type     string    `json:"type"`
	Text     *string   `json:"text,omitempty"`
	ImageURL *ImageURL `json:"image_url,omitempty"`
}

// ImageURL is an image part's URL: here always a data URL.
type ImageURL struct {
	URL string `json:"url"`
}

// TextPart is a text content part.
func TextPart(s string) ContentPart { return ContentPart{Type: "text", Text: &s} }

// ImagePart is an image_url content part.
func ImagePart(url string) ContentPart {
	return ContentPart{Type: "image_url", ImageURL: &ImageURL{URL: url}}
}

// ResponseFormat asks for structured output.
type ResponseFormat struct {
	Type       string     `json:"type"`
	JSONSchema JSONSchema `json:"json_schema"`
}

// JSONSchema is a named, strict JSON Schema for structured output.
type JSONSchema struct {
	Name   string          `json:"name"`
	Schema json.RawMessage `json:"schema"`
	Strict bool            `json:"strict"`
}

// ChatResponse holds the top-level values of a 2xx response body that the
// caller checks, raw and nil when the key is absent. Keys match exactly,
// as JS property access does (encoding/json would match "Model" too), and
// a repeated key keeps its last value, as JSON.parse.
type ChatResponse struct {
	Model   json.RawMessage
	Choices json.RawMessage
	Usage   json.RawMessage
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL points the client at another base URL: a local fake in tests.
func WithBaseURL(u string) Option { return func(c *Client) { c.baseURL = strings.TrimRight(u, "/") } }

// WithHTTPClient sends requests with h.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithTimeout replaces Timeout (tests).
func WithTimeout(d time.Duration) Option { return func(c *Client) { c.timeout = d } }

// WithSleep replaces the wait before a retry (tests). It must return early
// with ctx.Err() when ctx ends.
func WithSleep(f func(ctx context.Context, d time.Duration) error) Option {
	return func(c *Client) { c.sleep = f }
}

// WithNow replaces the clock used to read an HTTP-date Retry-After (tests).
func WithNow(f func() time.Time) Option { return func(c *Client) { c.now = f } }

// Client calls the chat completions endpoint. It is safe for concurrent use.
type Client struct {
	baseURL string
	apiKey  string
	http    *http.Client
	timeout time.Duration
	sleep   func(ctx context.Context, d time.Duration) error
	now     func() time.Time
}

// New makes a client for apiKey, which must not be blank. The error never
// contains the key.
func New(apiKey string, opts ...Option) (*Client, error) {
	if strings.TrimSpace(apiKey) == "" {
		return nil, errors.New("metaapi: an API key is required")
	}
	c := &Client{
		baseURL: BaseURL,
		apiKey:  apiKey,
		http:    &http.Client{},
		timeout: Timeout,
		sleep:   sleepCtx,
		now:     time.Now,
	}
	for _, o := range opts {
		o(c)
	}
	return c, nil
}

// Format prints the client without its key, whatever the verb (a value
// receiver, so a copied Client is covered too).
func (c Client) Format(f fmt.State, _ rune) {
	fmt.Fprintf(f, "metaapi.Client{baseURL: %q, key: [redacted]}", c.baseURL)
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func retryable(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusInternalServerError ||
		status == http.StatusServiceUnavailable
}

// Complete sends req, retrying once after a 429, 500 or 503 as described in
// the package doc. failed lists every attempt that did not succeed, in
// order; when err is non-nil it is the last of them, an *Error.
func (c *Client) Complete(ctx context.Context, req *ChatRequest) (res *ChatResponse, failed []*Error, err error) {
	body, mErr := json.Marshal(req)
	if mErr != nil {
		e := &Error{Kind: KindDecode, cause: mErr}
		return nil, []*Error{e}, e
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	for attempt := 1; ; attempt++ {
		res, e := c.once(ctx, body)
		if e == nil {
			return res, failed, nil
		}
		failed = append(failed, e)
		if attempt == 2 || e.Kind != KindHTTPStatus || !retryable(e.Status) {
			return nil, failed, e
		}
		wait := DefaultRetryWait
		if e.HasRetryAfter {
			wait = e.RetryAfter
		}
		if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) <= wait {
			return nil, failed, e
		}
		if c.sleep(ctx, wait) != nil {
			return nil, failed, e
		}
	}
}

// once is one attempt.
func (c *Client) once(ctx context.Context, body []byte) (*ChatResponse, *Error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, &Error{Kind: KindNetwork, cause: err}
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, transportError(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		e := &Error{Kind: KindHTTPStatus, Status: resp.StatusCode}
		e.RetryAfter, e.HasRetryAfter = retryAfter(resp.Header.Get("Retry-After"), c.now())
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10)) // never kept
		return nil, e
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, MaxResponseBytes+1))
	if err != nil {
		e := transportError(ctx, err)
		e.Status = resp.StatusCode
		return nil, e
	}
	if len(raw) > MaxResponseBytes {
		return nil, &Error{Kind: KindDecode, Status: resp.StatusCode}
	}
	out, ok := decodeResponse(raw)
	if !ok {
		return nil, &Error{Kind: KindDecode, Status: resp.StatusCode}
	}
	return out, nil
}

func transportError(ctx context.Context, err error) *Error {
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return &Error{Kind: KindTimeout, cause: context.DeadlineExceeded}
	case ctx.Err() != nil:
		return &Error{Kind: KindCanceled, cause: ctx.Err()}
	}
	return &Error{Kind: KindNetwork, cause: err}
}

// decodeResponse reads the top level of a JSON object body with exact keys.
func decodeResponse(raw []byte) (*ChatResponse, bool) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &top); err != nil || top == nil {
		return nil, false
	}
	return &ChatResponse{Model: top["model"], Choices: top["choices"], Usage: top["usage"]}, true
}

// retryAfter reads a Retry-After header: delay-seconds or an HTTP-date.
func retryAfter(h string, now time.Time) (time.Duration, bool) {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0, false
	}
	if secs, err := strconv.ParseUint(h, 10, 32); err == nil {
		return time.Duration(secs) * time.Second, true
	}
	if t, err := http.ParseTime(h); err == nil {
		return max(t.Sub(now), 0), true
	}
	return 0, false
}
