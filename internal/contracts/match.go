package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
)

// ReferenceRecord: match.ts ReferenceRecordSchema. One registry row; only
// RegistrationNumber identifies it. RegistrationExpiry is the registration
// certificate's expiry, never the product's.
type ReferenceRecord struct {
	Provider           string  `json:"provider"`
	SourceURL          string  `json:"sourceUrl"`
	RegistrationNumber string  `json:"registrationNumber"`
	BrandName          *string `json:"brandName"`
	GenericName        *string `json:"genericName"`
	StrengthForm       *string `json:"strengthForm"`
	Manufacturer       *string `json:"manufacturer"`
	Classification     *string `json:"classification"`
	RegistrationExpiry *string `json:"registrationExpiry"`
	CheckedAt          string  `json:"checkedAt"`
}

// MatchStatus: match.ts MatchStatusSchema.
type MatchStatus string

const (
	MatchVerified     MatchStatus = "verified"
	MatchPartial      MatchStatus = "partial"
	MatchConflicting  MatchStatus = "conflicting"
	MatchAmbiguous    MatchStatus = "ambiguous"
	MatchNoMatch      MatchStatus = "no_match"
	MatchUnavailable  MatchStatus = "unavailable"
	MatchNotAttempted MatchStatus = "not_attempted"
)

// MatchStatuses lists every MatchStatus in schema order.
var MatchStatuses = []MatchStatus{
	MatchVerified, MatchPartial, MatchConflicting, MatchAmbiguous,
	MatchNoMatch, MatchUnavailable, MatchNotAttempted,
}

// Valid reports whether s is one of the schema values.
func (s MatchStatus) Valid() bool { return slices.Contains(MatchStatuses, s) }

// FieldConflict: match.ts FieldConflictSchema.
type FieldConflict struct {
	Key            FieldKey `json:"key"`
	LabelValue     string   `json:"labelValue"`
	ReferenceValue string   `json:"referenceValue"`
}

// Advisory: match.ts AdvisorySchema. Reported alongside the status, never
// folded into it.
type Advisory struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// MatchAssessment: match.ts MatchAssessmentSchema.
type MatchAssessment struct {
	Status      MatchStatus       `json:"status"`
	Matched     []FieldKey        `json:"matched"`
	Conflicting []FieldConflict   `json:"conflicting"`
	Missing     []FieldKey        `json:"missing"`
	Candidates  []ReferenceRecord `json:"candidates"`
	Advisories  []Advisory        `json:"advisories"`
	Limitations []string          `json:"limitations"`
}

// MarshalJSON encodes nil slices as [].
func (m MatchAssessment) MarshalJSON() ([]byte, error) {
	type plain MatchAssessment
	p := plain(m)
	p.Matched = emptyIfNil(p.Matched)
	p.Conflicting = emptyIfNil(p.Conflicting)
	p.Missing = emptyIfNil(p.Missing)
	p.Candidates = emptyIfNil(p.Candidates)
	p.Advisories = emptyIfNil(p.Advisories)
	p.Limitations = emptyIfNil(p.Limitations)
	return json.Marshal(p)
}

// SearchKind is the discriminant of SearchResult.
type SearchKind string

const (
	SearchOK           SearchKind = "ok"
	SearchUnavailable  SearchKind = "unavailable"
	SearchNotAttempted SearchKind = "not_attempted"
)

// SearchResult is the outcome of a registry lookup as the matcher consumes
// it: a mirror of the Node ReferenceSearchResult union
// (apps/server/src/providers/types.ts), ruling R2. It is not a Zod schema.
//
//	{kind:"ok", records, advisories, advisoriesUnchecked?: true}
//	{kind:"unavailable", reason}
//	{kind:"not_attempted"}
//
// AdvisoriesUnchecked means the advisory lookup failed: empty Advisories then
// means "unknown", not "none".
type SearchResult struct {
	Kind                SearchKind
	Records             []ReferenceRecord
	Advisories          []Advisory
	AdvisoriesUnchecked bool
	Reason              string
}

type searchOK struct {
	Kind                SearchKind        `json:"kind"`
	Records             []ReferenceRecord `json:"records"`
	Advisories          []Advisory        `json:"advisories"`
	AdvisoriesUnchecked *bool             `json:"advisoriesUnchecked,omitempty"`
}

type searchUnavailable struct {
	Kind   SearchKind `json:"kind"`
	Reason string     `json:"reason"`
}

type searchNotAttempted struct {
	Kind SearchKind `json:"kind"`
}

// MarshalJSON encodes only the keys of the variant Kind selects.
func (s SearchResult) MarshalJSON() ([]byte, error) {
	switch s.Kind {
	case SearchOK:
		var unchecked *bool
		if s.AdvisoriesUnchecked {
			unchecked = Ptr(true)
		}
		return json.Marshal(searchOK{s.Kind, emptyIfNil(s.Records), emptyIfNil(s.Advisories), unchecked})
	case SearchUnavailable:
		return json.Marshal(searchUnavailable{s.Kind, s.Reason})
	case SearchNotAttempted:
		return json.Marshal(searchNotAttempted{s.Kind})
	default:
		return nil, fmt.Errorf("contracts: unknown search result kind %q", s.Kind)
	}
}

// UnmarshalJSON decodes any variant; an unknown key is an error.
// advisoriesUnchecked, when present, must be true (the TS type is the
// literal true).
func (s *SearchResult) UnmarshalJSON(b []byte) error {
	var w struct {
		Kind                SearchKind        `json:"kind"`
		Records             []ReferenceRecord `json:"records"`
		Advisories          []Advisory        `json:"advisories"`
		AdvisoriesUnchecked *bool             `json:"advisoriesUnchecked"`
		Reason              string            `json:"reason"`
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&w); err != nil {
		return err
	}
	switch w.Kind {
	case SearchOK, SearchUnavailable, SearchNotAttempted:
	default:
		return fmt.Errorf("contracts: unknown search result kind %q", w.Kind)
	}
	if w.AdvisoriesUnchecked != nil && !*w.AdvisoriesUnchecked {
		return errors.New("contracts: advisoriesUnchecked may only be true")
	}
	*s = SearchResult{
		Kind:                w.Kind,
		Records:             w.Records,
		Advisories:          w.Advisories,
		AdvisoriesUnchecked: w.AdvisoriesUnchecked != nil,
		Reason:              w.Reason,
	}
	return nil
}
