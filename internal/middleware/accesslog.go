package middleware

import (
	"log/slog"
	"net/http"
	"time"
)

// statusWriter records the status a handler sent. Unwrap lets
// http.ResponseController reach Flush and SetWriteDeadline underneath
// (without it a stream cannot be flushed through the wrapper).
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// AccessLog writes one line per request when its handler returns: the
// request id, method, route pattern (r.Pattern, set by the mux on the same
// request, so an analysis id in the path never reaches the log), status and
// duration in milliseconds. Nothing else: no path, query, header or body.
func AccessLog(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		defer func() {
			status := sw.status
			if status == 0 {
				status = http.StatusOK
			}
			logger.LogAttrs(r.Context(), slog.LevelInfo, "request",
				slog.String("requestId", RequestIDFrom(r.Context())),
				slog.String("method", r.Method),
				slog.String("route", r.Pattern),
				slog.Int("status", status),
				slog.Float64("durationMs", float64(time.Since(start).Microseconds())/1000),
			)
		}()
		next.ServeHTTP(sw, r)
	})
}
