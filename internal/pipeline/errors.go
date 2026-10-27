package pipeline

import "github.com/medilens-ai/medilens/internal/contracts"

// Go API error codes (Go port spec §4). They are not in the Zod
// ErrorCodeSchema yet (packages/contracts gains them with the new endpoint
// schemas), so contracts.ErrorCodes, which mirrors that schema, does not
// list them.
const (
	// CodeAnalysisNotReady: the analysis is still processing (409).
	CodeAnalysisNotReady contracts.ErrorCode = "ANALYSIS_NOT_READY"
	// CodeAnalysisFailed: the analysis stopped with no more specific code
	// (it was cut off by a shutdown, or failed unexpectedly).
	CodeAnalysisFailed contracts.ErrorCode = "ANALYSIS_FAILED"
)

// errorMessages are the spoken-friendly messages per code (Node
// http/errors.ts ERROR_MESSAGES, verbatim), plus the Go API's new codes.
// None contains a stack-like "at " sequence.
var errorMessages = map[contracts.ErrorCode]string{
	contracts.ErrInvalidImage:         "Please send a JPEG, PNG or WebP photo.",
	contracts.ErrImageTooLarge:        "Each photo must be 8 MB or smaller.",
	contracts.ErrLiveBudgetExhausted:  "Live scanning is paused for today. Please use Demo Mode instead.",
	contracts.ErrLabelUnreadable:      "I couldn't read this label. Please take another photo.",
	contracts.ErrOCRFailed:            "I couldn't read the label right now. Please try again.",
	contracts.ErrReferenceUnavailable: "I couldn't check the FDA registry right now.",
	contracts.ErrNoReliableMatch:      "No matching registration found.",
	contracts.ErrConflictingMatch:     "Some details on the label do not match the registry.",
	contracts.ErrUnsupportedRequest:   "I can only read and explain the printed text on this label.",
	contracts.ErrRateLimited:          "Too many requests. Please wait a minute and try again.",
	contracts.ErrNotFound:             "This scan result has expired or does not exist. Please scan again.",
	contracts.ErrValidationFailed:     "The request is not valid.",
	contracts.ErrInternal:             "Something went wrong. Please try again.",
	CodeAnalysisNotReady:              "The analysis is still running. Please try again in a moment.",
	CodeAnalysisFailed:                "The analysis could not be finished. Please try again.",
}

// Error is a whole-analysis or request failure (Node PipelineError and
// HttpError): the contract error code and the message a client may show
// or speak. The message never carries label text, a question, a provider
// detail or a stack.
type Error struct {
	Code    contracts.ErrorCode
	Message string
}

// NewError is the error for code with its fixed message.
func NewError(code contracts.ErrorCode) *Error {
	msg, ok := errorMessages[code]
	if !ok {
		msg = errorMessages[contracts.ErrInternal]
	}
	return &Error{Code: code, Message: msg}
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }
