package contracts

import "slices"

// ErrorCode: errors.ts ErrorCodeSchema.
type ErrorCode string

const (
	ErrInvalidImage         ErrorCode = "INVALID_IMAGE"
	ErrImageTooLarge        ErrorCode = "IMAGE_TOO_LARGE"
	ErrLiveBudgetExhausted  ErrorCode = "LIVE_BUDGET_EXHAUSTED"
	ErrLabelUnreadable      ErrorCode = "LABEL_UNREADABLE"
	ErrOCRFailed            ErrorCode = "OCR_FAILED"
	ErrReferenceUnavailable ErrorCode = "REFERENCE_UNAVAILABLE"
	ErrNoReliableMatch      ErrorCode = "NO_RELIABLE_MATCH"
	ErrConflictingMatch     ErrorCode = "CONFLICTING_MATCH"
	ErrUnsupportedRequest   ErrorCode = "UNSUPPORTED_REQUEST"
	ErrRateLimited          ErrorCode = "RATE_LIMITED"
	ErrNotFound             ErrorCode = "NOT_FOUND"
	ErrValidationFailed     ErrorCode = "VALIDATION_FAILED"
	ErrInternal             ErrorCode = "INTERNAL_ERROR"
)

// ErrorCodes lists every ErrorCode in schema order.
var ErrorCodes = []ErrorCode{
	ErrInvalidImage, ErrImageTooLarge, ErrLiveBudgetExhausted, ErrLabelUnreadable,
	ErrOCRFailed, ErrReferenceUnavailable, ErrNoReliableMatch, ErrConflictingMatch,
	ErrUnsupportedRequest, ErrRateLimited, ErrNotFound, ErrValidationFailed, ErrInternal,
}

// Valid reports whether c is one of the schema values.
func (c ErrorCode) Valid() bool { return slices.Contains(ErrorCodes, c) }

// ErrorBody: errors.ts ErrorBodySchema. Never carries a stack trace.
type ErrorBody struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail is the inner object of ErrorBody.
type ErrorDetail struct {
	Code      ErrorCode `json:"code"`
	Message   string    `json:"message"`
	RequestID string    `json:"requestId"`
}
