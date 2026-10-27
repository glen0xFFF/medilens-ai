package contracts

import (
	"encoding/json"
	"fmt"
	"slices"
	"time"
)

// QualityReason: analysis.ts QualityReasonSchema.
type QualityReason string

const (
	QualityBlurry  QualityReason = "BLURRY"
	QualityTooDark QualityReason = "TOO_DARK"
	QualityGlare   QualityReason = "GLARE"
)

// QualityReasons lists every QualityReason in schema order.
var QualityReasons = []QualityReason{QualityBlurry, QualityTooDark, QualityGlare}

// Valid reports whether r is one of the schema values.
func (r QualityReason) Valid() bool { return slices.Contains(QualityReasons, r) }

// QualityReport: analysis.ts QualityReportSchema.
type QualityReport struct {
	OK            bool            `json:"ok"`
	Sharpness     float64         `json:"sharpness"`
	Luminance     float64         `json:"luminance"`
	GlareFraction float64         `json:"glareFraction"`
	Reasons       []QualityReason `json:"reasons"`
}

// MarshalJSON encodes nil slices as [].
func (q QualityReport) MarshalJSON() ([]byte, error) {
	type plain QualityReport
	p := plain(q)
	p.Reasons = emptyIfNil(p.Reasons)
	return json.Marshal(p)
}

// Explanation: analysis.ts ExplanationSchema.
type Explanation struct {
	DisplayText      string     `json:"displayText"`
	SpokenChunks     []string   `json:"spokenChunks"`
	SafetyNotices    []string   `json:"safetyNotices"`
	SupportingFields []FieldKey `json:"supportingFields"`
}

// MarshalJSON encodes nil slices as [].
func (e Explanation) MarshalJSON() ([]byte, error) {
	type plain Explanation
	p := plain(e)
	p.SpokenChunks = emptyIfNil(p.SpokenChunks)
	p.SafetyNotices = emptyIfNil(p.SafetyNotices)
	p.SupportingFields = emptyIfNil(p.SupportingFields)
	return json.Marshal(p)
}

// PipelineState: analysis.ts PipelineStateSchema.
type PipelineState string

const (
	PipelineLabelUnreadable  PipelineState = "label_unreadable"
	PipelineNotALabel        PipelineState = "not_a_label"
	PipelineLoosePill        PipelineState = "loose_pill"
	PipelineTextExtracted    PipelineState = "text_extracted"
	PipelineExplanationReady PipelineState = "explanation_ready"
)

// PipelineStates lists every PipelineState in schema order.
var PipelineStates = []PipelineState{
	PipelineLabelUnreadable, PipelineNotALabel, PipelineLoosePill,
	PipelineTextExtracted, PipelineExplanationReady,
}

// Valid reports whether s is one of the schema values.
func (s PipelineState) Valid() bool { return slices.Contains(PipelineStates, s) }

// ImageRetention is the literal "none" (analysis.ts imageRetention): images
// are never kept. The zero value encodes as "none"; any other value is an
// encoding or decoding error.
type ImageRetention string

// ImageRetentionNone is the only value the contract allows.
const ImageRetentionNone ImageRetention = "none"

// MarshalJSON encodes "none", and refuses any other value.
func (r ImageRetention) MarshalJSON() ([]byte, error) {
	if r != "" && r != ImageRetentionNone {
		return nil, fmt.Errorf("contracts: imageRetention must be %q, got %q", ImageRetentionNone, string(r))
	}
	return json.Marshal(string(ImageRetentionNone))
}

// UnmarshalJSON accepts only "none".
func (r *ImageRetention) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	if ImageRetention(s) != ImageRetentionNone {
		return fmt.Errorf("contracts: imageRetention must be %q, got %q", ImageRetentionNone, s)
	}
	*r = ImageRetentionNone
	return nil
}

// AnalysisResult: analysis.ts AnalysisResultSchema. Label is nil when the
// image failed the quality check and the reader was never called. CreatedAt
// and ExpiresAt are ISO timestamps in the JS toISOString form (FormatTime).
type AnalysisResult struct {
	ID             string          `json:"id"`
	IsDemo         bool            `json:"isDemo"`
	CreatedAt      string          `json:"createdAt"`
	ExpiresAt      string          `json:"expiresAt"`
	PipelineState  PipelineState   `json:"pipelineState"`
	Quality        QualityReport   `json:"quality"`
	Label          *ExtractedLabel `json:"label"`
	Match          MatchAssessment `json:"match"`
	Explanation    Explanation     `json:"explanation"`
	ImageRetention ImageRetention  `json:"imageRetention"`
}

// DemoScenarioRequest: analysis.ts DemoScenarioRequestSchema.
type DemoScenarioRequest struct {
	ScenarioID string `json:"scenarioId"`
}

// DemoScenarioSummary: analysis.ts DemoScenarioSummarySchema. PresetQuestion
// is the question the scenario is built to show (s7); absent otherwise.
type DemoScenarioSummary struct {
	ID             string  `json:"id"`
	Title          string  `json:"title"`
	PresetQuestion *string `json:"presetQuestion,omitempty"`
}

// FormatTime formats t like JS Date.prototype.toISOString: UTC, millisecond
// precision, a Z suffix (the Node timestamps, e.g. 2026-10-27T08:00:00.000Z).
func FormatTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
