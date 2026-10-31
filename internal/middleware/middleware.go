// Package middleware is the HTTP plumbing of the Go API (Go port spec §4),
// a port of apps/server/src/http: the request id, the access log, panic
// recovery, CORS for one origin and the per-client rate limits, plus the
// contract error body every response error uses.
//
// The API wraps its mux in this order, outermost first: RequestID,
// AccessLog, Recover, CORS, RateLimiter. RequestID is the only one that
// replaces the request (to carry the id in its context); the others pass
// the same *http.Request down, so the access log reads the route pattern
// the mux sets on it.
package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"uuid"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// RequestIDHeader carries the request id on every response.
const RequestIDHeader = "X-Request-Id"

type requestIDKey struct{}

// RequestID gives every request a fresh random UUIDv4 (a client-sent
// X-Request-Id is ignored, so nothing from the client reaches a log line
// through it), returns it as X-Request-Id and puts it in the request's
// context. newID is nil in production.
func RequestID(newID func() string, next http.Handler) http.Handler {
	if newID == nil {
		newID = func() string { return uuid.NewV4().String() }
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := newID()
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

// RequestIDFrom is the request id in ctx, or "unknown" (Node requestIdOf).
func RequestIDFrom(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey{}).(string); ok {
		return id
	}
	return "unknown"
}

// internalBody is sent when a response cannot be encoded: the contract
// error body with the request id already set as X-Request-Id ("unknown"
// without one), so the body and the header agree (final review M15).
func internalBody(h http.Header) []byte {
	id := h.Get(RequestIDHeader)
	if id == "" {
		id = "unknown"
	}
	b, _ := json.Marshal(map[string]map[string]string{"error": {
		"code": string(contracts.ErrInternal), "message": "Something went wrong. Please try again.", "requestId": id,
	}})
	return b
}

// WriteJSON writes v as a JSON response with status. HTML characters are
// not escaped, as in JSON.stringify. A value that cannot be encoded is a
// 500 INTERNAL_ERROR body instead.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	if err := enc.Encode(v); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write(internalBody(h))
		return
	}
	w.WriteHeader(status)
	// Encode ends the value with a newline, which JSON allows
	_, _ = w.Write(buf.Bytes())
}

// WriteError writes the contract error body {error: {code, message,
// requestId}} (base spec §5.2): never a stack, never an error's own text.
func WriteError(w http.ResponseWriter, r *http.Request, status int, code contracts.ErrorCode, message string) {
	WriteJSON(w, status, contracts.ErrorBody{Error: contracts.ErrorDetail{
		Code: code, Message: message, RequestID: RequestIDFrom(r.Context()),
	}})
}
