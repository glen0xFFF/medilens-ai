package domain

// Port of apps/server/src/domain/summary.ts: the deterministic spoken
// summary (spec §5.5). Everything spoken here is either a fixed sentence or
// a label value transcribed from the user's own pack. Registry rows are
// never read aloud: in particular registrationExpiry (certificate expiry)
// must never be mistaken for the product's expiry.
//
// Lengths are JS lengths (UTF-16 code units), so a chunk is cut where the
// Node build cuts it. The TS file's RegExps and their Go form:
//
//	/counterfeit/i                      containsFoldASCII: a non-u /i
//	                                    folds ASCII letters only
//	/[.!?]$/                            endsSentence (last code unit)
//	/\s+/g → ' ', trim()                jsCollapse (JS \s, JS trim)
//	/(?<=[.!?])\s+(?=[A-Z])/            splitSentences, on collapsed text

import (
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/medilens-ai/medilens/internal/contracts"
)

// FinalLine closes every summary and every answer.
const FinalLine = "Confirm with your pharmacist or doctor."

// CounterfeitAdvisorySentence is spoken only when an advisory title says
// "counterfeit" (final review Minor 8).
const CounterfeitAdvisorySentence = "The FDA has issued an advisory about counterfeit versions of this product. Check with your pharmacist."

// NeutralAdvisorySentence is spoken for any other advisory: a recall or
// unregistered-product notice is not a counterfeit warning.
const NeutralAdvisorySentence = "The FDA has issued an advisory that mentions this product. Check with your pharmacist."

// PartlyUnclear marks a printed value that is not clear, in the summary and
// in Q&A read-backs alike (final review I1): "Directions as printed, partly
// unclear: ...".
const PartlyUnclear = "partly unclear"

// RegistryNotChecked: a label was read but the registry was not searched
// (final review Minor 1).
const RegistryNotChecked = "The FDA registry was not checked."

// LoosePillSentence: a loose tablet is never identified.
const LoosePillSentence = "This looks like a loose tablet. I can't identify a medicine from how it looks. Please ask a pharmacist."

// NotALabelSentence: the photo shows no medicine label.
const NotALabelSentence = "I couldn't find a medicine label in this photo."

const (
	demoNotice         = "Demo data. This is a made-up example, not a real medicine."
	unreadableSentence = "I couldn't read this label."
	retakeSentence     = "Please take another photo."
	maxChunk           = 400
)

var qualitySentence = map[contracts.QualityReason]string{
	contracts.QualityBlurry:  "The photo is blurry.",
	contracts.QualityTooDark: "The photo is too dark.",
	contracts.QualityGlare:   "There is glare on the label.",
}

// StatusSentence is the registry status sentence; the registry answer
// speaks the same ones. Treat as read-only.
var StatusSentence = map[contracts.MatchStatus]string{
	contracts.MatchVerified:    "This matches a product in the Philippine FDA registry.",
	contracts.MatchPartial:     "This partly matches a product in the Philippine FDA registry. Some details could not be confirmed.",
	contracts.MatchAmbiguous:   "More than one registered product could match this label. I can't tell which one.",
	contracts.MatchNoMatch:     "No matching registration found. This does not mean the product is fake. Ask your pharmacist.",
	contracts.MatchUnavailable: "I couldn't check the FDA registry right now.",
}

var fieldName = map[contracts.FieldKey]string{
	contracts.FieldBrandName:          "brand name",
	contracts.FieldGenericNames:       "generic name",
	contracts.FieldStrength:           "strength",
	contracts.FieldDosageForm:         "dosage form",
	contracts.FieldManufacturer:       "manufacturer",
	contracts.FieldRegistrationNumber: "registration number",
	contracts.FieldDirections:         "directions",
	contracts.FieldWarnings:           "warnings",
	contracts.FieldStorage:            "storage",
	contracts.FieldExpiryDate:         "expiry date",
	contracts.FieldBatchNumber:        "batch number",
	contracts.FieldRxOrOtc:            "prescription status",
}

// fieldOrder is the order of the unclear-fields sentence (the schema order).
var fieldOrder = contracts.FieldKeys

// SummaryInput is what the summary is built from. Label is nil when no
// label was read.
type SummaryInput struct {
	Label         *contracts.ExtractedLabel `json:"label"`
	Quality       contracts.QualityReport   `json:"quality"`
	Match         contracts.MatchAssessment `json:"match"`
	IsDemo        bool                      `json:"isDemo"`
	PipelineState contracts.PipelineState   `json:"pipelineState"`
}

// segment is a spoken segment: plain text, or (lead set) a value whose lead
// is repeated, as continued, on every chunk the body is split into.
type segment struct {
	text                  string
	lead, continued, body string
}

func plain(s string) segment { return segment{text: s} }

// BuildSummary is the deterministic spoken summary of a scan.
func BuildSummary(in SummaryInput) contracts.Explanation {
	var segments []segment
	safetyNotices := []string{}
	supportingFields := []contracts.FieldKey{}

	if in.IsDemo {
		segments = append(segments, plain(demoNotice))
	}

	label := in.Label
	kind := func(k contracts.ImageKind) bool { return label != nil && label.ImageKind == k }
	switch {
	case in.PipelineState == contracts.PipelineLoosePill || kind(contracts.ImageKindLoosePill):
		segments = append(segments, plain(LoosePillSentence))
		safetyNotices = append(safetyNotices, LoosePillSentence)
	case in.PipelineState == contracts.PipelineNotALabel || kind(contracts.ImageKindNotMedicine):
		segments = append(segments, plain(NotALabelSentence))
	case in.PipelineState == contracts.PipelineLabelUnreadable || label == nil || kind(contracts.ImageKindUnreadable):
		parts := []string{unreadableSentence}
		for _, r := range in.Quality.Reasons {
			parts = append(parts, qualitySentence[r])
		}
		parts = append(parts, retakeSentence)
		segments = append(segments, plain(strings.Join(parts, " ")))
	default:
		segments = labelSegments(*label, in.Match, segments, &safetyNotices, &supportingFields)
	}

	segments = append(segments, plain(FinalLine))
	safetyNotices = append(safetyNotices, FinalLine)

	spokenChunks := []string{}
	for _, s := range segments {
		spokenChunks = append(spokenChunks, chunkSegment(s)...)
	}
	return contracts.Explanation{
		DisplayText:      strings.Join(spokenChunks, "\n"),
		SpokenChunks:     spokenChunks,
		SafetyNotices:    uniqueStrings(safetyNotices),
		SupportingFields: supportingFields,
	}
}

func labelSegments(
	label contracts.ExtractedLabel,
	match contracts.MatchAssessment,
	segments []segment,
	safetyNotices *[]string,
	supportingFields *[]contracts.FieldKey,
) []segment {
	// the first field of each key
	fields := map[contracts.FieldKey]*contracts.LabelField{}
	for i := range label.Fields {
		if _, ok := fields[label.Fields[i].Key]; !ok {
			fields[label.Fields[i].Key] = &label.Fields[i]
		}
	}
	// value is the trimmed value of the first field of key, or "" when it
	// has none; a field with a value supports the summary.
	value := func(key contracts.FieldKey) (*contracts.LabelField, string) {
		f := fields[key]
		if f == nil || f.Value == nil {
			return nil, ""
		}
		v := jsTrim(*f.Value)
		if v == "" {
			return nil, ""
		}
		if !slices.Contains(*supportingFields, key) {
			*supportingFields = append(*supportingFields, key)
		}
		return f, v
	}
	spoken := func(key contracts.FieldKey) string {
		f, v := value(key)
		if f == nil || f.Legibility == contracts.LegibilityClear {
			return v
		}
		return v + ", but this part is unclear"
	}

	// product name + strength + form
	brand := spoken(contracts.FieldBrandName)
	generic := spoken(contracts.FieldGenericNames)
	strength := spoken(contracts.FieldStrength)
	form := spoken(contracts.FieldDosageForm)
	name := brand
	if brand != "" && generic != "" {
		name = brand + " (" + generic + ")"
	} else if brand == "" {
		name = generic
	}
	var parts []string
	if name != "" {
		parts = append(parts, name)
	}
	if strength != "" {
		parts = append(parts, "strength "+strength)
	}
	if form != "" {
		parts = append(parts, "form "+form)
	}
	switch {
	case name != "":
		segments = append(segments, plain("This label reads: "+strings.Join(parts, "; ")+"."))
	case len(parts) > 0:
		segments = append(segments, plain("I couldn't read the medicine name. The label shows "+strings.Join(parts, "; ")+"."))
	default:
		segments = append(segments, plain("I couldn't read the medicine name."))
	}

	// verification status
	verification := VerificationSentences(match)
	if len(verification) > 0 {
		segments = append(segments, plain(strings.Join(verification, " ")))
	}
	if match.Status == contracts.MatchConflicting {
		*safetyNotices = append(*safetyNotices, verification...)
	}
	if slices.Contains(match.Limitations, RegNotFoundNote) {
		segments = append(segments, plain(RegNotFoundNote))
	}
	if slices.Contains(match.Limitations, AdvisoriesUncheckedNote) {
		segments = append(segments, plain(AdvisoriesUncheckedNote))
	}

	// registry advisory (any status)
	if advisory := AdvisorySentence(match.Advisories); advisory != nil {
		segments = append(segments, plain(*advisory))
		*safetyNotices = append(*safetyNotices, *advisory)
	}

	// Printed text: a non-clear value is introduced by the marker, and the
	// marker is repeated on every chunk the value is split into, so no part
	// of a partly unclear dose or instruction is ever read as certain.
	printed := func(key contracts.FieldKey, title, short string) {
		f, v := value(key)
		if f == nil {
			return
		}
		if f.Legibility == contracts.LegibilityClear {
			segments = append(segments, plain(title+": "+sentence(v)))
			return
		}
		segments = append(segments, segment{
			lead:      title + ", " + PartlyUnclear + ":",
			continued: short + " continued, " + PartlyUnclear + ":",
			body:      sentence(v),
		})
	}
	printed(contracts.FieldDirections, "Directions as printed", "Directions")
	printed(contracts.FieldWarnings, "Warnings as printed", "Warnings")
	printed(contracts.FieldExpiryDate, "Expiry date printed on the pack", "Expiry date")

	var unclear []string
	for _, k := range fieldOrder {
		if f := fields[k]; f != nil && f.Legibility != contracts.LegibilityClear {
			unclear = append(unclear, fieldName[k])
		}
	}
	if len(unclear) > 0 {
		segments = append(segments, plain("Some parts were unclear: "+strings.Join(unclear, ", ")+"."))
	}
	return segments
}

// AdvisorySentence is the spoken advisory sentence, or nil with no
// advisory: the counterfeit sentence only when an advisory title says
// "counterfeit" (any ASCII case), the neutral sentence for any other.
func AdvisorySentence(advisories []contracts.Advisory) *string {
	if len(advisories) == 0 {
		return nil
	}
	s := NeutralAdvisorySentence
	for _, a := range advisories {
		if containsFoldASCII(a.Title, "counterfeit") {
			s = CounterfeitAdvisorySentence
			break
		}
	}
	return &s
}

// containsFoldASCII is /needle/i.test(s) for a lowercase ASCII needle: a
// RegExp without the u flag folds case only between ASCII letters (a
// non-ASCII character never canonicalizes onto an ASCII one).
func containsFoldASCII(s, needle string) bool {
	b := []byte(s)
	for i, c := range b {
		b[i] = lowerASCIIByte(c)
	}
	return strings.Contains(string(b), needle)
}

// VerificationSentences is what the registry check found, naming each
// conflicting field, or that it was not checked. A status outside the
// schema is spoken as an unavailable registry, never as a match.
func VerificationSentences(match contracts.MatchAssessment) []string {
	switch match.Status {
	case contracts.MatchConflicting:
		var keys []contracts.FieldKey
		for _, c := range match.Conflicting {
			if !slices.Contains(keys, c.Key) {
				keys = append(keys, c.Key)
			}
		}
		if len(keys) == 0 {
			return []string{"Some details on the label do not match the registry."}
		}
		out := make([]string, len(keys))
		for i, k := range keys {
			out[i] = "The " + fieldName[k] + " on the label does not match the registry."
		}
		return out
	case contracts.MatchNotAttempted:
		return []string{RegistryNotChecked}
	}
	if s, ok := StatusSentence[match.Status]; ok {
		return []string{s}
	}
	return []string{StatusSentence[contracts.MatchUnavailable]}
}

// sentence ends text with a full stop unless it ends in . ! or ?.
func sentence(text string) string {
	if endsSentence(text) {
		return text
	}
	return text + "."
}

// endsSentence is /[.!?]$/.test(text).
func endsSentence(text string) bool {
	if text == "" {
		return false
	}
	switch text[len(text)-1] {
	case '.', '!', '?':
		return true
	}
	return false
}

func uniqueStrings(xs []string) []string {
	out := []string{}
	for _, x := range xs {
		if !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	return out
}

func chunkSegment(s segment) []string {
	if s.lead == "" {
		return chunk(s.text, maxChunk)
	}
	lead := jsTrim(s.lead)
	continued := jsTrim(s.continued)
	budget := maxChunk - max(jsLen(lead), jsLen(continued)) - 1
	chunks := chunk(s.body, budget)
	for i, c := range chunks {
		if i == 0 {
			chunks[i] = lead + " " + c
		} else {
			chunks[i] = continued + " " + c
		}
	}
	return chunks
}

// ChunkSpeech splits text for speech exactly as the spoken summary does:
// whitespace runs collapsed, then chunks of at most 400 UTF-16 code units
// at sentence, then word boundaries. The result is never nil.
func ChunkSpeech(text string) []string { return chunk(text, maxChunk) }

// chunk splits text into chunks of at most max code units, at sentence then
// word boundaries. A sentence ends only at [.!?] followed by whitespace and
// an uppercase ASCII letter, so "2.5 mL" or "e.g. a cup" is never split.
func chunk(segment string, max int) []string {
	text := jsCollapse(segment)
	if jsLen(text) <= max {
		if text == "" {
			return []string{}
		}
		return []string{text}
	}
	out := []string{}
	current := ""
	flush := func() {
		if current != "" {
			out = append(out, current)
		}
		current = ""
	}
	for _, s := range splitSentences(text) {
		pieces := []string{s}
		if jsLen(s) > max {
			pieces = splitWords(s, max)
		}
		for _, p := range pieces {
			if current != "" && jsLen(current)+1+jsLen(p) > max {
				flush()
			}
			if current == "" {
				current = p
			} else {
				current += " " + p
			}
		}
	}
	flush()
	return out
}

// splitSentences is text.split(/(?<=[.!?])\s+(?=[A-Z])/) with each piece
// trimmed and empty pieces dropped, on collapsed text (single spaces, no
// leading or trailing space).
func splitSentences(text string) []string {
	var out []string
	start := 0
	for i := 1; i+1 < len(text); i++ {
		if text[i] != ' ' {
			continue
		}
		switch text[i-1] {
		case '.', '!', '?':
		default:
			continue
		}
		if next := text[i+1]; next < 'A' || next > 'Z' {
			continue
		}
		out = appendNonEmpty(out, text[start:i])
		start = i + 1
	}
	return appendNonEmpty(out, text[start:])
}

func appendNonEmpty(xs []string, s string) []string {
	if s = jsTrim(s); s != "" {
		xs = append(xs, s)
	}
	return xs
}

// splitWords packs the words of s into chunks of at most max code units; a
// single unbroken run longer than the limit is hard-cut every max code
// units, as String.prototype.slice cuts it. (A cut through a surrogate pair
// leaves a lone surrogate in JS; Go strings cannot hold one, so it becomes
// U+FFFD.)
func splitWords(s string, max int) []string {
	var out []string
	current := ""
	for _, word := range strings.Split(s, " ") {
		w16 := utf16.Encode([]rune(word))
		for i := 0; i < len(w16); i += max {
			w := string(utf16.Decode(w16[i:min(i+max, len(w16))]))
			if current != "" && jsLen(current)+1+jsLen(w) > max {
				out = append(out, current)
				current = ""
			}
			if current == "" {
				current = w
			} else {
				current += " " + w
			}
		}
	}
	if current != "" {
		out = append(out, current)
	}
	return out
}

// jsLen is the JS length of s: UTF-16 code units.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// jsCollapse is s.replace(/\s+/g, ' ').trim(): JS \s, JS trim.
func jsCollapse(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inSpace := false
	for _, r := range s {
		if isJSSpace(r) {
			if !inSpace {
				b.WriteByte(' ')
			}
			inSpace = true
			continue
		}
		inSpace = false
		b.WriteRune(r)
	}
	return strings.Trim(b.String(), " ")
}
