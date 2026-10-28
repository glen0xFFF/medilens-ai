package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/medilens-ai/medilens/internal/application"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/middleware"
	"github.com/medilens-ai/medilens/internal/observability"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// queueRetryAfter is the Retry-After, in seconds, of a create refused
// because every worker is busy and the queue is full (or the service is
// closing).
const queueRetryAfter = 5

// statusOf is the HTTP status of each error code the service returns
// (Node's PIPELINE_STATUS plus the Go API's codes). A code not listed is a
// 500 INTERNAL_ERROR, as in Node.
var statusOf = map[contracts.ErrorCode]int{
	contracts.ErrInvalidImage:        http.StatusUnsupportedMediaType,
	contracts.ErrImageTooLarge:       http.StatusRequestEntityTooLarge,
	contracts.ErrOCRFailed:           http.StatusBadGateway,
	contracts.ErrNotFound:            http.StatusNotFound,
	contracts.ErrLiveBudgetExhausted: http.StatusServiceUnavailable,
	contracts.ErrRateLimited:         http.StatusTooManyRequests,
	contracts.ErrValidationFailed:    http.StatusBadRequest,
	contracts.ErrInternal:            http.StatusInternalServerError,
	pipeline.CodeAnalysisNotReady:    http.StatusConflict,
	pipeline.CodeAnalysisFailed:      http.StatusInternalServerError,
}

func internalError() *pipeline.Error { return pipeline.NewError(contracts.ErrInternal) }

// writeError writes a *pipeline.Error as the contract error body.
func writeError(w http.ResponseWriter, r *http.Request, e *pipeline.Error) {
	status, ok := statusOf[e.Code]
	if !ok {
		e, status = internalError(), http.StatusInternalServerError
	}
	middleware.WriteError(w, r, status, e.Code, e.Message)
}

// fail answers a service error:
//
//   - a full queue is 503 RATE_LIMITED with Retry-After (Go port spec §4),
//     and a closing service 503 INTERNAL_ERROR with Retry-After;
//   - a *pipeline.Error keeps its code and message, with its status;
//   - the request's own context ending (the client left) is a 500 with no
//     log line;
//   - anything else is 500 INTERNAL_ERROR, logged by its type name only
//     (its text could carry label text or a provider detail).
func (a *API) fail(w http.ResponseWriter, r *http.Request, err error) {
	var pe *pipeline.Error
	switch {
	case errors.Is(err, application.ErrQueueFull):
		w.Header().Set("Retry-After", strconv.Itoa(queueRetryAfter))
		middleware.WriteError(w, r, http.StatusServiceUnavailable, application.ErrQueueFull.Code, application.ErrQueueFull.Message)
	case errors.Is(err, application.ErrClosed):
		w.Header().Set("Retry-After", strconv.Itoa(queueRetryAfter))
		e := internalError()
		middleware.WriteError(w, r, http.StatusServiceUnavailable, e.Code, e.Message)
	case errors.As(err, &pe):
		writeError(w, r, pe)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeError(w, r, internalError())
	default:
		a.log.LogAttrs(r.Context(), slog.LevelError, "unhandled error",
			slog.String("requestId", middleware.RequestIDFrom(r.Context())),
			slog.String("errorName", observability.ErrorName(err)),
		)
		writeError(w, r, internalError())
	}
}
