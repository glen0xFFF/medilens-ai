package contracts

import (
	"encoding/json"
	"slices"
)

// AnswerStatus: answer.ts AnswerSchema status.
type AnswerStatus string

const (
	AnswerAnswered AnswerStatus = "answered"
	AnswerRefused  AnswerStatus = "refused"
	AnswerUnclear  AnswerStatus = "unclear"
)

// AnswerStatuses lists every AnswerStatus in schema order.
var AnswerStatuses = []AnswerStatus{AnswerAnswered, AnswerRefused, AnswerUnclear}

// Valid reports whether s is one of the schema values.
func (s AnswerStatus) Valid() bool { return slices.Contains(AnswerStatuses, s) }

// Answer: answer.ts AnswerSchema.
type Answer struct {
	Status       AnswerStatus `json:"status"`
	Text         string       `json:"text"`
	SpokenChunks []string     `json:"spokenChunks"`
	CitedFields  []FieldKey   `json:"citedFields"`
	SafetyNotice *string      `json:"safetyNotice"`
}

// MarshalJSON encodes nil slices as [].
func (a Answer) MarshalJSON() ([]byte, error) {
	type plain Answer
	p := plain(a)
	p.SpokenChunks = emptyIfNil(p.SpokenChunks)
	p.CitedFields = emptyIfNil(p.CitedFields)
	return json.Marshal(p)
}

// ExplainRequest: answer.ts ExplainRequestSchema (the question is trimmed
// and 1 to 300 characters; validation belongs to the handler).
type ExplainRequest struct {
	Question string `json:"question"`
}
