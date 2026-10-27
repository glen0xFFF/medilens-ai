// Package contracts mirrors the Zod schemas in packages/contracts/src with
// identical JSON keys. Nullable fields are pointers (encoded as null), optional
// fields use omitempty, and every array is encoded as [] when nil, because the
// Zod schemas reject null where they expect an array.
package contracts

import (
	"encoding/json"
	"slices"
)

// Ptr returns a pointer to v, for nullable and optional fields.
func Ptr[T any](v T) *T { return &v }

// emptyIfNil returns s, or an empty non-nil slice when s is nil.
func emptyIfNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// Legibility: label.ts LegibilitySchema.
type Legibility string

const (
	LegibilityClear      Legibility = "clear"
	LegibilityPartial    Legibility = "partial"
	LegibilityUnreadable Legibility = "unreadable"
)

// Legibilities lists every Legibility in schema order.
var Legibilities = []Legibility{LegibilityClear, LegibilityPartial, LegibilityUnreadable}

// Valid reports whether l is one of the schema values.
func (l Legibility) Valid() bool { return slices.Contains(Legibilities, l) }

// FieldKey: label.ts FieldKeySchema.
type FieldKey string

const (
	FieldBrandName          FieldKey = "brandName"
	FieldGenericNames       FieldKey = "genericNames"
	FieldStrength           FieldKey = "strength"
	FieldDosageForm         FieldKey = "dosageForm"
	FieldManufacturer       FieldKey = "manufacturer"
	FieldRegistrationNumber FieldKey = "registrationNumber"
	FieldDirections         FieldKey = "directions"
	FieldWarnings           FieldKey = "warnings"
	FieldStorage            FieldKey = "storage"
	FieldExpiryDate         FieldKey = "expiryDate"
	FieldBatchNumber        FieldKey = "batchNumber"
	FieldRxOrOtc            FieldKey = "rxOrOtc"
)

// FieldKeys lists every FieldKey in schema order.
var FieldKeys = []FieldKey{
	FieldBrandName, FieldGenericNames, FieldStrength, FieldDosageForm,
	FieldManufacturer, FieldRegistrationNumber, FieldDirections, FieldWarnings,
	FieldStorage, FieldExpiryDate, FieldBatchNumber, FieldRxOrOtc,
}

// Valid reports whether k is one of the schema values.
func (k FieldKey) Valid() bool { return slices.Contains(FieldKeys, k) }

// LabelField: label.ts LabelFieldSchema. A field absent from the pack has a
// nil Value; values are never invented.
type LabelField struct {
	Key          FieldKey   `json:"key"`
	Value        *string    `json:"value"`
	Legibility   Legibility `json:"legibility"`
	EvidenceText *string    `json:"evidenceText"`
	ImageIndex   *int       `json:"imageIndex"`
	Notes        *string    `json:"notes"`
}

// ImageKind: label.ts ImageKindSchema.
type ImageKind string

const (
	ImageKindLabel       ImageKind = "label"
	ImageKindLoosePill   ImageKind = "loose_pill"
	ImageKindNotMedicine ImageKind = "not_medicine"
	ImageKindUnreadable  ImageKind = "unreadable"
)

// ImageKinds lists every ImageKind in schema order.
var ImageKinds = []ImageKind{ImageKindLabel, ImageKindLoosePill, ImageKindNotMedicine, ImageKindUnreadable}

// Valid reports whether k is one of the schema values.
func (k ImageKind) Valid() bool { return slices.Contains(ImageKinds, k) }

// ExtractedLabel: label.ts ExtractedLabelSchema.
type ExtractedLabel struct {
	ImageKind ImageKind    `json:"imageKind"`
	Fields    []LabelField `json:"fields"`
	RawText   string       `json:"rawText"`
	Warnings  []string     `json:"warnings"`
}

// MarshalJSON encodes nil slices as [].
func (l ExtractedLabel) MarshalJSON() ([]byte, error) {
	type plain ExtractedLabel
	p := plain(l)
	p.Fields = emptyIfNil(p.Fields)
	p.Warnings = emptyIfNil(p.Warnings)
	return json.Marshal(p)
}
