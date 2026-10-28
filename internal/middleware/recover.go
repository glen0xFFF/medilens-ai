package middleware

import (
	"fmt"
	"log/slog"
	"net/http"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// internalMessage is ERROR_MESSAGES.INTERNAL_ERROR.
const internalMessage = "Something went wrong. Please try again."

// headerWriter notes whether the response has started.
type headerWriter struct {
	http.ResponseWriter
	started bool
}

func (h *headerWriter) WriteHeader(code int) {
	h.started = true
	h.ResponseWriter.WriteHeader(code)
}

func (h *headerWriter) Write(b []byte) (int, error) {
	h.started = true
	return h.ResponseWriter.Write(b)
}

func (h *headerWriter) Unwrap() http.ResponseWriter { return h.ResponseWriter }

// Recover turns a panic in a handler into 500 INTERNAL_ERROR with the
// contract body: never a stack and never the panic's text, which could
// carry label text. The log line has the request id and the panic value's
// type only. A panic after the response started adds nothing to it.
// http.ErrAbortHandler is passed on: net/http uses it to abort a response
// on purpose.
func Recover(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hw := &headerWriter{ResponseWriter: w}
		defer func() {
			p := recover()
			if p == nil {
				return
			}
			if p == http.ErrAbortHandler {
				panic(p)
			}
			logger.LogAttrs(r.Context(), slog.LevelError, "panic recovered",
				slog.String("requestId", RequestIDFrom(r.Context())),
				slog.String("panicType", fmt.Sprintf("%T", p)),
			)
			if !hw.started {
				WriteError(w, r, http.StatusInternalServerError, contracts.ErrInternal, internalMessage)
			}
		}()
		next.ServeHTTP(hw, r)
	})
}
