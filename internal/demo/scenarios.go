// Package demo holds the eight deterministic demo scenarios (base spec §7),
// the same data as apps/server/src/demo/scenarios.ts. Everything here is
// synthetic DEMO DATA: fictional product names, registration numbers in the
// unused DR-XY9xxxxx range, and source URLs on the reserved example.org
// domain, never the PH FDA site. The expected match status of each
// scenario comes from running the real matcher over these fixtures, never
// from a stored value.
//
// Each call builds the scenarios afresh, so a caller can never change the
// data another caller sees.
package demo

import (
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
)

// UploadScenario is the fixture a real upload is read as when the mock
// model provider is active (Node DEMO_UPLOAD_SCENARIO, Task 10 ruling).
const UploadScenario = "s1-clear"

// CheckedAt is the registry check time on every demo record. The
// GET /references endpoint still reports checkedAt null for a demo result,
// because demo data was never checked against any registry.
const CheckedAt = "2026-10-27T00:00:00.000Z"

// SourceURLPrefix is where a demo record's "source page" points: a reserved
// example domain, never the FDA (final review Minor 18).
const SourceURLPrefix = "https://example.org/medilens-demo/"

// Note is the photo note on the scenarios with no readable label.
const Note = "DEMO DATA: synthetic fixture, not a real product."

// FixtureProvider is the provider name on every demo record.
const FixtureProvider = "demo-fixture"

// Scenario is one demo scenario (Node DemoScenario). PresetQuestion and
// CannedAnswer are set on s7 only.
type Scenario struct {
	ID             string
	Title          string
	Quality        contracts.QualityReport
	Label          contracts.ExtractedLabel
	Reference      contracts.SearchResult
	PresetQuestion *string
	CannedAnswer   *contracts.Answer
}

func goodQuality() contracts.QualityReport {
	return contracts.QualityReport{OK: true, Sharpness: 48.2, Luminance: 132, GlareFraction: 0.01, Reasons: []contracts.QualityReason{}}
}

func badQuality() contracts.QualityReport {
	return contracts.QualityReport{
		OK: false, Sharpness: 4.1, Luminance: 168, GlareFraction: 0.21,
		Reasons: []contracts.QualityReason{contracts.QualityBlurry, contracts.QualityGlare},
	}
}

func field(key contracts.FieldKey, value *string, legibility contracts.Legibility) contracts.LabelField {
	f := contracts.LabelField{Key: key, Legibility: legibility}
	if value != nil {
		f.Value = contracts.Ptr(*value)
		f.EvidenceText = contracts.Ptr(*value)
		f.ImageIndex = contracts.Ptr(0)
	}
	return f
}

func clearField(key contracts.FieldKey, value string) contracts.LabelField {
	return field(key, &value, contracts.LegibilityClear)
}

// label is a readable label whose rawText is DEMO DATA plus every
// evidence text, one per line.
func label(fields []contracts.LabelField) contracts.ExtractedLabel {
	raw := "DEMO DATA"
	for _, f := range fields {
		if f.EvidenceText != nil {
			raw += "\n" + *f.EvidenceText
		}
	}
	return contracts.ExtractedLabel{ImageKind: contracts.ImageKindLabel, Fields: fields, RawText: raw, Warnings: []string{}}
}

func record(registrationNumber, brandName, genericName, strengthForm string) contracts.ReferenceRecord {
	encoded, _ := domain.EncodeURIComponent(registrationNumber) // ASCII literals: always encodable
	return contracts.ReferenceRecord{
		Provider:           FixtureProvider,
		SourceURL:          SourceURLPrefix + encoded,
		RegistrationNumber: registrationNumber,
		BrandName:          contracts.Ptr(brandName),
		GenericName:        contracts.Ptr(genericName),
		StrengthForm:       contracts.Ptr(strengthForm),
		Manufacturer:       contracts.Ptr("Demo Pharma Labs (DEMO DATA)"),
		Classification:     contracts.Ptr("Over-the-counter (DEMO DATA)"),
		RegistrationExpiry: contracts.Ptr("2030-12-31"),
		CheckedAt:          CheckedAt,
	}
}

func ok(records ...contracts.ReferenceRecord) contracts.SearchResult {
	if records == nil {
		records = []contracts.ReferenceRecord{}
	}
	return contracts.SearchResult{Kind: contracts.SearchOK, Records: records, Advisories: []contracts.Advisory{}}
}

func paracelin500Fields() []contracts.LabelField {
	return []contracts.LabelField{
		clearField(contracts.FieldBrandName, "Paracelin 500"),
		clearField(contracts.FieldGenericNames, "Paracetamol"),
		clearField(contracts.FieldStrength, "500 mg"),
		clearField(contracts.FieldDosageForm, "Tablet"),
		clearField(contracts.FieldManufacturer, "Demo Pharma Labs"),
		clearField(contracts.FieldRegistrationNumber, "DR-XY900001"),
		clearField(contracts.FieldDirections, "Adults: 1 to 2 tablets every 4 to 6 hours as needed. Do not take more than 8 tablets in 24 hours."),
		clearField(contracts.FieldWarnings, "Do not use with other products containing paracetamol. Keep out of reach of children."),
		clearField(contracts.FieldStorage, "Store below 30 degrees Celsius in a dry place."),
		clearField(contracts.FieldExpiryDate, "05/2028"),
		clearField(contracts.FieldBatchNumber, "DB0001"),
		clearField(contracts.FieldRxOrOtc, "OTC"),
	}
}

func paracelin500Record() contracts.ReferenceRecord {
	return record("DR-XY900001", "Paracelin 500", "Paracetamol", "500 mg Tablet")
}

const s7Question = "How many should I take for my headache?"

// cannedRefusal is the refusal the safety gate gives for question, as a
// fixed Answer.
func cannedRefusal(question string) contracts.Answer {
	verdict := domain.ClassifyQuestion(question)
	text := domain.RefusalText[domain.RefusalOutsideLabel]
	if !verdict.Allowed {
		text = domain.RefusalText[verdict.Reason]
	}
	return contracts.Answer{
		Status:       contracts.AnswerRefused,
		Text:         text,
		SpokenChunks: []string{text},
		CitedFields:  []contracts.FieldKey{},
		SafetyNotice: contracts.Ptr("Please ask a pharmacist or your doctor."),
	}
}

func unreadable(key contracts.FieldKey) contracts.LabelField {
	return field(key, nil, contracts.LegibilityUnreadable)
}

// Scenarios returns the eight scenarios in order, freshly built.
func Scenarios() []Scenario {
	partial := "Paracel"
	return []Scenario{
		{
			ID:        "s1-clear",
			Title:     "DEMO DATA: Clear package, registration number matches",
			Quality:   goodQuality(),
			Label:     label(paracelin500Fields()),
			Reference: ok(paracelin500Record()),
		},
		{
			ID:      "s2-blurry",
			Title:   "DEMO DATA: Blurry photo with glare",
			Quality: badQuality(),
			Label: contracts.ExtractedLabel{
				ImageKind: contracts.ImageKindUnreadable, Fields: []contracts.LabelField{}, RawText: "", Warnings: []string{Note},
			},
			Reference: contracts.SearchResult{Kind: contracts.SearchNotAttempted},
		},
		{
			ID:      "s3-similar",
			Title:   "DEMO DATA: Two similar products",
			Quality: goodQuality(),
			Label: label([]contracts.LabelField{
				field(contracts.FieldBrandName, &partial, contracts.LegibilityPartial),
				clearField(contracts.FieldGenericNames, "Paracetamol"),
				clearField(contracts.FieldStrength, "500 mg"),
				clearField(contracts.FieldDosageForm, "Tablet"),
				unreadable(contracts.FieldRegistrationNumber),
			}),
			Reference: ok(
				record("DR-XY900002", "Paracelin 500", "Paracetamol", "500 mg Tablet"),
				record("DR-XY900003", "Paracelin-Forte 500", "Paracetamol", "500 mg Tablet"),
			),
		},
		{
			ID:      "s4-conflict",
			Title:   "DEMO DATA: Label strength differs from the registry",
			Quality: goodQuality(),
			Label: label([]contracts.LabelField{
				clearField(contracts.FieldBrandName, "Paracelin"),
				clearField(contracts.FieldGenericNames, "Paracetamol"),
				clearField(contracts.FieldStrength, "500 mg"),
				clearField(contracts.FieldDosageForm, "Tablet"),
				clearField(contracts.FieldRegistrationNumber, "DR-XY900004"),
			}),
			Reference: ok(record("DR-XY900004", "Paracelin 250", "Paracetamol", "250 mg Tablet")),
		},
		{
			ID:      "s5-nomatch",
			Title:   "DEMO DATA: Unknown product",
			Quality: goodQuality(),
			Label: label([]contracts.LabelField{
				clearField(contracts.FieldBrandName, "Amoxivan 500"),
				clearField(contracts.FieldGenericNames, "Amoxicillin"),
				clearField(contracts.FieldStrength, "500 mg"),
				clearField(contracts.FieldDosageForm, "Capsule"),
				clearField(contracts.FieldRegistrationNumber, "DR-XY900099"),
			}),
			Reference: ok(),
		},
		{
			ID:      "s6-loose-pill",
			Title:   "DEMO DATA: Loose pill",
			Quality: goodQuality(),
			Label: contracts.ExtractedLabel{
				ImageKind: contracts.ImageKindLoosePill,
				Fields: []contracts.LabelField{
					unreadable(contracts.FieldBrandName),
					unreadable(contracts.FieldGenericNames),
					unreadable(contracts.FieldStrength),
				},
				RawText:  "",
				Warnings: []string{Note},
			},
			Reference: contracts.SearchResult{Kind: contracts.SearchNotAttempted},
		},
		{
			ID:             "s7-unsupported-question",
			Title:          "DEMO DATA: Unsupported dosing question",
			Quality:        goodQuality(),
			Label:          label(paracelin500Fields()),
			Reference:      ok(paracelin500Record()),
			PresetQuestion: contracts.Ptr(s7Question),
			CannedAnswer:   contracts.Ptr(cannedRefusal(s7Question)),
		},
		{
			ID:        "s8-registry-down",
			Title:     "DEMO DATA: Registry unavailable",
			Quality:   goodQuality(),
			Label:     label(paracelin500Fields()),
			Reference: contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: "DEMO DATA: simulated registry timeout."},
		},
	}
}

// Get returns the scenario with id, freshly built, or false.
func Get(id string) (Scenario, bool) {
	for _, s := range Scenarios() {
		if s.ID == id {
			return s, true
		}
	}
	return Scenario{}, false
}

// Summaries is the scenario list the API shows: id, title, and the preset
// question where a scenario has one.
func Summaries() []contracts.DemoScenarioSummary {
	all := Scenarios()
	out := make([]contracts.DemoScenarioSummary, len(all))
	for i, s := range all {
		out[i] = contracts.DemoScenarioSummary{ID: s.ID, Title: s.Title, PresetQuestion: s.PresetQuestion}
	}
	return out
}
