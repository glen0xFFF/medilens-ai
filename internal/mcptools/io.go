package mcptools

import (
	"encoding/base64"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/imaging"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

// Tool inputs and outputs (Go port spec §5). Inputs are closed JSON
// objects: no URL, no shell, no free query, only a photo, a demo scenario
// id, an analysis id, a question about it and a registration number that
// must be one of its stored candidates. Outputs are typed; every output
// about an analysis carries isDemo (true for made-up demo data).

const (
	// MaxIDLength bounds analysis_id and registration_number (an analysis
	// id is a 36-character UUID).
	MaxIDLength = 64
	// maxImageBase64Length is the longest image_base64 accepted before
	// decoding: the base64 of MaxImageBytes plus a line break pair every
	// 64 characters. Longer text is IMAGE_TOO_LARGE without a decode.
	maxImageBase64Length = (imaging.MaxImageBytes+2)/3*4 + 2*((imaging.MaxImageBytes+2)/3*4/64+1)
)

/* ------------------------------------------------------------ inputs */

// AssessInput is assess_image_quality's input.
type AssessInput struct {
	ImageBase64 string `json:"image_base64"`
}

// ExtractInput is extract_medication_label's input: photos or a scenario.
type ExtractInput struct {
	ImagesBase64 []string `json:"images_base64,omitempty"`
	ScenarioID   string   `json:"scenario_id,omitempty"`
}

// AnalysisInput names a stored analysis.
type AnalysisInput struct {
	AnalysisID string `json:"analysis_id"`
}

// ExplainInput is explain_verified_label's input.
type ExplainInput struct {
	AnalysisID string `json:"analysis_id"`
	Question   string `json:"question"`
}

// DetailsInput is get_reference_details's input.
type DetailsInput struct {
	AnalysisID         string `json:"analysis_id"`
	RegistrationNumber string `json:"registration_number"`
}

// object is a closed JSON Schema object.
func object(required []string, props map[string]any) map[string]any {
	return map[string]any{
		"type":                 "object",
		"properties":           props,
		"required":             required,
		"additionalProperties": false,
	}
}

func analysisIDSchema() map[string]any {
	return map[string]any{
		"type": "string", "minLength": 1, "maxLength": MaxIDLength,
		"description": "The analysis_id returned by extract_medication_label. Analyses are kept for 15 minutes.",
	}
}

func scenarioIDs() []any {
	var ids []any
	for _, s := range demo.Summaries() {
		ids = append(ids, s.ID)
	}
	return ids
}

var (
	assessSchema = object([]string{"image_base64"}, map[string]any{
		"image_base64": map[string]any{
			"type": "string", "minLength": 1,
			"description": "One JPEG, PNG or WebP photo as standard base64 (no data: prefix), at most 8 MiB decoded.",
		},
	})
	extractSchema = object([]string{}, map[string]any{
		"images_base64": map[string]any{
			"type": "array", "minItems": pipeline.MinImages, "maxItems": pipeline.MaxImages,
			"items":       map[string]any{"type": "string", "minLength": 1},
			"description": "1 to 3 photos of different sides of ONE medicine package, each a JPEG, PNG or WebP as standard base64 (no data: prefix), at most 8 MiB decoded. Send this or scenario_id, not both.",
		},
		"scenario_id": map[string]any{
			"type": "string", "enum": scenarioIDs(),
			"description": "A built-in demo scenario (made-up DEMO DATA, no photo needed). Send this or images_base64, not both.",
		},
	})
	analysisSchema = object([]string{"analysis_id"}, map[string]any{"analysis_id": analysisIDSchema()})
	explainSchema  = object([]string{"analysis_id", "question"}, map[string]any{
		"analysis_id": analysisIDSchema(),
		"question": map[string]any{
			"type":        "string",
			"description": "A question about what is printed on this label, 1 to 300 characters, for example: What strength is printed here?",
		},
	})
	detailsSchema = object([]string{"analysis_id", "registration_number"}, map[string]any{
		"analysis_id": analysisIDSchema(),
		"registration_number": map[string]any{
			"type": "string", "minLength": 1, "maxLength": MaxIDLength,
			"description": "The registrationNumber of one of the analysis's registry candidates, exactly as lookup_medication_reference returned it.",
		},
	})
)

// decodeImage decodes one base64 photo: IMAGE_TOO_LARGE from its length
// before decoding, VALIDATION_FAILED when it is not standard base64, and
// IMAGE_TOO_LARGE when it decodes to over 8 MiB. The format is checked by
// the caller (pipeline.ValidateUploads).
func decodeImage(s string) ([]byte, error) {
	if len(s) > maxImageBase64Length {
		return nil, pipeline.NewError(contracts.ErrImageTooLarge)
	}
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, &toolError{code: contracts.ErrValidationFailed, message: "Send each photo as standard base64, with no data: prefix."}
	}
	if len(b) > imaging.MaxImageBytes {
		return nil, pipeline.NewError(contracts.ErrImageTooLarge)
	}
	return b, nil
}

/* ------------------------------------------------------------ outputs */

// Next actions of assess_image_quality.
const (
	// NextActionExtract: the photo is good enough to read.
	NextActionExtract = "extract_medication_label"
	// NextActionRetake: take another photo (see reasons).
	NextActionRetake = "retake_photo"
)

// AssessOutput is assess_image_quality's output: the base QualityReport
// plus what to do next.
type AssessOutput struct {
	OK            bool                      `json:"ok"`
	Reasons       []contracts.QualityReason `json:"reasons"`
	Sharpness     float64                   `json:"sharpness"`
	Luminance     float64                   `json:"luminance"`
	GlareFraction float64                   `json:"glareFraction"`
	NextAction    string                    `json:"nextAction"`
}

// Field is one label field as printed: its value (null when absent), how
// legible it was and the verbatim text it was read from.
type Field struct {
	Key          contracts.FieldKey   `json:"key"`
	Value        *string              `json:"value"`
	Legibility   contracts.Legibility `json:"legibility"`
	EvidenceText *string              `json:"evidenceText"`
}

// ExtractOutput is extract_medication_label's output. ImageKind is null
// and Fields empty when the photo failed the quality check (no label was
// read).
type ExtractOutput struct {
	AnalysisID    string                  `json:"analysis_id"`
	PipelineState contracts.PipelineState `json:"pipelineState"`
	ImageKind     *contracts.ImageKind    `json:"imageKind"`
	Fields        []Field                 `json:"fields"`
	Warnings      []string                `json:"warnings"`
	IsDemo        bool                    `json:"isDemo"`
}

// Lookup statuses: the registry lookup of the analysis was made (ok),
// failed (unavailable) or was not attempted (no clear text to search for,
// a quality failure, a loose pill or no label).
const (
	LookupOK           = "ok"
	LookupUnavailable  = "unavailable"
	LookupNotAttempted = "not_attempted"
)

// LookupOutput is lookup_medication_reference's output.
type LookupOutput struct {
	Status      string                      `json:"status"`
	Candidates  []contracts.ReferenceRecord `json:"candidates"`
	Advisories  []contracts.Advisory        `json:"advisories"`
	Limitations []string                    `json:"limitations"`
	IsDemo      bool                        `json:"isDemo"`
}

// CompareOutput is compare_medication_evidence's output: the stored
// MatchAssessment, key for key, plus isDemo.
type CompareOutput struct {
	Status      contracts.MatchStatus       `json:"status"`
	Matched     []contracts.FieldKey        `json:"matched"`
	Conflicting []contracts.FieldConflict   `json:"conflicting"`
	Missing     []contracts.FieldKey        `json:"missing"`
	Candidates  []contracts.ReferenceRecord `json:"candidates"`
	Advisories  []contracts.Advisory        `json:"advisories"`
	Limitations []string                    `json:"limitations"`
	IsDemo      bool                        `json:"isDemo"`
}

// ExplainOutput is explain_verified_label's output: the API's Answer, key
// for key, plus isDemo. A refusal is a result (status refused).
type ExplainOutput struct {
	Status       contracts.AnswerStatus `json:"status"`
	Text         string                 `json:"text"`
	SpokenChunks []string               `json:"spokenChunks"`
	CitedFields  []contracts.FieldKey   `json:"citedFields"`
	SafetyNotice *string                `json:"safetyNotice"`
	IsDemo       bool                   `json:"isDemo"`
}

// Source names of get_reference_details, by record provider.
const (
	PHFDASourceName = "Philippine FDA product registry (verification.fda.gov.ph)"
	DemoSourceName  = "MediLens demo registry (DEMO DATA, not a real registry)"
)

// DetailsOutput is get_reference_details's output. CheckedAt is when the
// registry was checked, null for demo data (never checked against any
// registry). The record's registrationExpiry is the registration
// certificate's expiry, never the medicine's.
type DetailsOutput struct {
	SourceName  string                    `json:"sourceName"`
	SourceURL   string                    `json:"sourceUrl"`
	Record      contracts.ReferenceRecord `json:"record"`
	CheckedAt   *string                   `json:"checkedAt"`
	Limitations []string                  `json:"limitations"`
	IsDemo      bool                      `json:"isDemo"`
}

func nonNil[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}
