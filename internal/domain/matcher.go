package domain

// Port of apps/server/src/domain/matcher.ts: the deterministic
// label-to-registry matcher (spec §5.4). It decides the verification status
// the app speaks aloud, so every rule errs towards the weaker status: a
// field that cannot be read or parsed is `missing`, never `matched` and
// never `conflicting`.
//
// The TS file's RegExps carry the i or u flag and use no lookaround; each is
// a small hand-written scanner here, compared with V8 by
// TestMatcherRegexpScanners:
//
//	/\+|,|\band\b/i             splitNameList
//	/^\p{N}+(\p{L}+)$/u         gluedStrengthUnit
//	/film[\s\p{Pd}]*coated/gu   replaceFilmCoated
//	/[^\p{L}\p{N}-]+/u          splitFormTokens
//	/\p{L}/u, /\p{Cf}/u         hasLetter, hasFormatChar

import (
	"slices"
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"

	"github.com/medilens-ai/medilens/internal/contracts"
)

const (
	expiryNote      = "Registration expiry is not the product's expiry date."
	unavailableNote = "Registry lookup unavailable; nothing was verified."
	// NotAttemptedNote is the limitation of a lookup that never ran.
	NotAttemptedNote = "Registry lookup was not attempted."
	// RegNotFoundNote: a clear registration number on the pack is not in the registry.
	RegNotFoundNote = "The registration number on the pack was not found in the registry."
	// AdvisoriesUncheckedNote: the advisory lookup failed, so [] means unknown.
	AdvisoriesUncheckedNote = "FDA safety advisories for this product could not be checked."
)

// compared are the label fields the matcher compares, in report order.
var compared = []contracts.FieldKey{
	contracts.FieldRegistrationNumber,
	contracts.FieldBrandName,
	contracts.FieldGenericNames,
	contracts.FieldStrength,
	contracts.FieldDosageForm,
}

type outcome uint8

const (
	outcomeMissing outcome = iota
	outcomeMatched
	outcomeConflict
)

type evaluation struct {
	record   contracts.ReferenceRecord
	outcomes map[contracts.FieldKey]outcome
	// conflicts is never nil: an empty list encodes as [].
	conflicts []contracts.FieldConflict
	// score is the number of fields that matched; ties between fitting
	// records are ambiguous (rule 7).
	score int
	// nameMatched: brand or generic name matched (rule 5).
	nameMatched bool
	// formBlocksVerified: a stated dosage form could not be confirmed; at
	// most `partial`.
	formBlocksVerified bool
}

// ClearValue is the value of a label field, or nil when it is absent,
// unreadable or not `clear` (rule 10). A key that appears more than once is
// not comparable. A nil label has no fields.
func ClearValue(label *contracts.ExtractedLabel, key contracts.FieldKey) *string {
	if label == nil {
		return nil
	}
	var found *contracts.LabelField
	n := 0
	for i := range label.Fields {
		if label.Fields[i].Key == key {
			n++
			found = &label.Fields[i]
		}
	}
	if n != 1 || found.Legibility != contracts.LegibilityClear || found.Value == nil {
		return nil
	}
	if jsTrim(*found.Value) == "" {
		return nil
	}
	v := *found.Value
	return &v
}

// lowerASCIIByte lowers an ASCII letter byte; any other byte is returned as is.
func lowerASCIIByte(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + ('a' - 'A')
	}
	return c
}

func isASCIIWordByte(s string, i int) bool {
	if i < 0 || i >= len(s) {
		return false
	}
	c := s[i]
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
}

// splitNameList is s.split(/\+|,|\band\b/i). Every separator is ASCII, so
// byte offsets stand in for code units: a byte of a multi-byte character is
// never ASCII, and no ASCII word character either, which is how JS \b sees
// the code units of a non-ASCII character. Without the u flag, /i folds
// "and" onto ASCII letters only.
func splitNameList(s string) []string {
	var out []string
	p := 0
	for q := 0; q < len(s); {
		e := -1
		switch {
		case s[q] == '+' || s[q] == ',':
			e = q + 1
		case q+3 <= len(s) && lowerASCIIByte(s[q]) == 'a' && lowerASCIIByte(s[q+1]) == 'n' && lowerASCIIByte(s[q+2]) == 'd' &&
			!isASCIIWordByte(s, q-1) && !isASCIIWordByte(s, q+3):
			e = q + 3
		}
		if e < 0 {
			q++
			continue
		}
		out = append(out, s[p:q])
		p, q = e, e
	}
	return append(out, s[p:])
}

// nameSet splits a list of ingredient names on `+`, `,` or the word `and`.
func nameSet(s string) map[string]bool {
	set := map[string]bool{}
	for _, part := range splitNameList(s) {
		if n := NormalizeName(part); n != "" {
			set[n] = true
		}
	}
	return set
}

func setsEqual(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for x := range a {
		if !b[x] {
			return false
		}
	}
	return true
}

// containsWords reports whether the words of inner appear as a contiguous
// run of whole words in outer.
func containsWords(outer, inner string) bool {
	o := strings.Split(outer, " ")
	in := strings.Split(inner, " ")
	for start := 0; start+len(in) <= len(o); start++ {
		if slices.Equal(o[start:start+len(in)], in) {
			return true
		}
	}
	return false
}

func compareBrand(labelValue, referenceValue string) outcome {
	a, b := NormalizeName(labelValue), NormalizeName(referenceValue)
	if a == "" || b == "" {
		return outcomeMissing
	}
	if a == b || containsWords(a, b) || containsWords(b, a) {
		return outcomeMatched
	}
	return outcomeConflict
}

func compareGeneric(labelValue, referenceValue string) outcome {
	a, b := nameSet(labelValue), nameSet(referenceValue)
	if len(a) == 0 || len(b) == 0 {
		return outcomeMissing
	}
	if setsEqual(a, b) {
		return outcomeMatched
	}
	return outcomeConflict
}

// compareStrength: registry strengthForm is free text such as `500 mg
// Tablet`. Dropping the dosage-form words leaves the strength part. A nil
// parse on either side means "not comparable".
func compareStrength(labelValue, strengthForm string) outcome {
	a := ParseStrength(labelValue)
	b := ParseStrength(NormalizeName(strengthForm))
	if a == nil || b == nil {
		return outcomeMissing
	}
	if StrengthsEqual(a, b) {
		return outcomeMatched
	}
	return outcomeConflict
}

// unitWords are units skipped when looking for form text in
// `500 mg/5 mL Suspension` (μ is U+03BC, what NFKC makes of µ).
var unitWords = map[string]bool{
	"mg": true, "mcg": true, "μg": true, "ug": true, "g": true, "gram": true, "grams": true,
	"milligram": true, "milligrams": true, "microgram": true, "micrograms": true, "ml": true, "l": true, "iu": true,
}

// strengthWords are standalone words that belong to a strength or pack
// size, not to a form.
func isStrengthWord(w string) bool { return unitWords[w] || w == "per" || w == "x" }

// gluedStrengthUnit is /^\p{N}+(\p{L}+)$/u.exec(s)?.[1]: the unit of a
// number glued to letters (`500mg`), or nil. \p{N} and \p{L} are disjoint,
// so the split point is unique and no backtracking can change it.
func gluedStrengthUnit(s string) *string {
	rs := []rune(s)
	i := 0
	for i < len(rs) && unicode.IsNumber(rs[i]) {
		i++
	}
	if i == 0 {
		return nil
	}
	j := i
	for j < len(rs) && unicode.IsLetter(rs[j]) {
		j++
	}
	if j == i || j != len(rs) {
		return nil
	}
	unit := string(rs[i:])
	return &unit
}

// replaceFilmCoated is s.replace(/film[\s\p{Pd}]*coated/gu, 'film-coated'):
// `Film Coated`, `Film–Coated` and `Film—Coated` all become `film-coated`.
// The class never contains 'c', so the greedy run is the only one that can
// be followed by "coated"; after a miss the scan moves one code point on.
func replaceFilmCoated(s string) string {
	rs := []rune(s)
	var b strings.Builder
	for i := 0; i < len(rs); {
		if hasRunesAt(rs, i, "film") {
			j := i + 4
			for j < len(rs) && (isJSSpace(rs[j]) || unicode.Is(unicode.Pd, rs[j])) {
				j++
			}
			if hasRunesAt(rs, j, "coated") {
				b.WriteString("film-coated")
				i = j + len("coated")
				continue
			}
		}
		b.WriteRune(rs[i])
		i++
	}
	return b.String()
}

func hasRunesAt(rs []rune, i int, word string) bool {
	if i+len(word) > len(rs) {
		return false
	}
	for k := 0; k < len(word); k++ {
		if rs[i+k] != rune(word[k]) {
			return false
		}
	}
	return true
}

func isFormSeparator(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) && r != '-' }

// splitFormTokens is s.split(/[^\p{L}\p{N}-]+/u): split on maximal runs of
// anything but letters, numbers and '-', keeping empty leading and trailing
// pieces as JS does.
func splitFormTokens(s string) []string {
	rs := []rune(s)
	var out []string
	p := 0
	for q := 0; q < len(rs); {
		if !isFormSeparator(rs[q]) {
			q++
			continue
		}
		e := q
		for e < len(rs) && isFormSeparator(rs[e]) {
			e++
		}
		out = append(out, string(rs[p:q]))
		p, q = e, e
	}
	return append(out, string(rs[p:]))
}

// hasLetter is /\p{L}/u.test(s).
func hasLetter(s string) bool { return strings.IndexFunc(s, unicode.IsLetter) >= 0 }

// hasFormatChar is /\p{Cf}/u.test(s).
func hasFormatChar(s string) bool {
	return strings.IndexFunc(s, func(r rune) bool { return unicode.Is(unicode.Cf, r) }) >= 0
}

func formOf(word string) (string, bool) {
	f, ok := DosageFormWords[word]
	return f, ok
}

func isVocabulary(word string) bool {
	_, ok := formOf(word)
	return ok || DosageFormModifiers[word]
}

// formWords splits free text into lower-case words. A hyphen-glued token
// that is not itself a vocabulary word (`500mg-capsule`) is split at its
// hyphens, so the form is still seen. Numbers, units and glued strengths
// are dropped. Any other word that mixes letters and digits (`capsule500`,
// `10s`) is kept, so it counts as unrecognised.
func formWords(text string) []string {
	var words []string
	tokens := replaceFilmCoated(cases.Lower(language.Und).String(norm.NFKC.String(text)))
	for _, token := range splitFormTokens(tokens) {
		parts := []string{token}
		if !isVocabulary(token) {
			parts = strings.Split(token, "-")
		}
		for _, part := range parts {
			if !hasLetter(part) || isStrengthWord(part) {
				continue
			}
			if unit := gluedStrengthUnit(part); unit != nil && unitWords[*unit] {
				continue
			}
			words = append(words, part)
		}
	}
	return words
}

type formReading struct {
	// forms are the canonical forms named, e.g. `tablet`, `eye drops`.
	forms map[string]bool
	// unrecognised: some word is neither a form word, a modifier nor part
	// of the strength.
	unrecognised bool
}

// readForm reads the form words in free text. It returns nil when the text
// holds no form text at all (only numbers and strength units).
func readForm(text string) *formReading {
	words := formWords(text)
	if len(words) == 0 {
		return nil
	}
	// A format character (zero-width space, soft hyphen) is never stripped silently.
	r := &formReading{forms: map[string]bool{}, unrecognised: hasFormatChar(text)}
	for i := 0; i < len(words); i++ {
		word := words[i]
		if DosageFormModifiers[word] {
			continue
		}
		if DropsQualifiers[word] && i+1 < len(words) {
			if next, ok := formOf(words[i+1]); ok && next == "drops" {
				r.forms[word+" drops"] = true
				i++
				continue
			}
		}
		if form, ok := formOf(word); ok {
			r.forms[form] = true
		} else {
			r.unrecognised = true
		}
	}
	return r
}

type formComparison struct {
	outcome outcome
	// blocksVerified: the form could not be confirmed although it was
	// stated, so `verified` is out of reach.
	blocksVerified bool
}

// compareDosageForm: label dosageForm against the form text in strengthForm.
//   - Both sides name recognised forms and the forms differ: conflict.
//   - The registry text has no form text at all, or the label states no
//     form: missing, and verified stays reachable (spec rule 3).
//   - Any other doubt (an unclear label value, an unrecognised word such as
//     Effervescent or Pessary): missing, capped at partial.
func compareDosageForm(label *contracts.ExtractedLabel, record contracts.ReferenceRecord) formComparison {
	stated := false
	if label != nil {
		for _, f := range label.Fields {
			if f.Key == contracts.FieldDosageForm && f.Value != nil && jsTrim(*f.Value) != "" {
				stated = true
				break
			}
		}
	}
	if !stated {
		return formComparison{outcomeMissing, false}
	}
	var ref *formReading
	if record.StrengthForm != nil {
		ref = readForm(*record.StrengthForm)
	}
	if ref == nil {
		return formComparison{outcomeMissing, false}
	}
	var lab *formReading
	if v := ClearValue(label, contracts.FieldDosageForm); v != nil {
		lab = readForm(*v)
	}
	if lab == nil {
		return formComparison{outcomeMissing, true}
	}
	if len(lab.forms) > 0 && len(ref.forms) > 0 && !setsEqual(lab.forms, ref.forms) {
		return formComparison{outcomeConflict, true}
	}
	if lab.unrecognised || ref.unrecognised || len(lab.forms) == 0 || len(ref.forms) == 0 {
		return formComparison{outcomeMissing, true}
	}
	return formComparison{outcomeMatched, false}
}

var comparators = []struct {
	key     contracts.FieldKey
	ref     func(contracts.ReferenceRecord) *string
	compare func(labelValue, ref string) outcome
}{
	{contracts.FieldBrandName, func(r contracts.ReferenceRecord) *string { return r.BrandName }, compareBrand},
	{contracts.FieldGenericNames, func(r contracts.ReferenceRecord) *string { return r.GenericName }, compareGeneric},
	{contracts.FieldStrength, func(r contracts.ReferenceRecord) *string { return r.StrengthForm }, compareStrength},
}

func evaluate(label *contracts.ExtractedLabel, record contracts.ReferenceRecord, registrationMatched bool) evaluation {
	e := evaluation{record: record, outcomes: map[contracts.FieldKey]outcome{}, conflicts: []contracts.FieldConflict{}}
	// Rule 2 compares only brand, generic, strength and form; the
	// registration number counts only when rule 1 selected the record by it.
	e.outcomes[contracts.FieldRegistrationNumber] = outcomeMissing
	if registrationMatched {
		e.outcomes[contracts.FieldRegistrationNumber] = outcomeMatched
	}
	for _, c := range comparators {
		labelValue := ClearValue(label, c.key)
		ref := c.ref(record)
		o := outcomeMissing
		if labelValue != nil && ref != nil {
			o = c.compare(*labelValue, *ref)
		}
		e.outcomes[c.key] = o
		if o == outcomeConflict {
			e.conflicts = append(e.conflicts, contracts.FieldConflict{Key: c.key, LabelValue: *labelValue, ReferenceValue: *ref})
		}
	}
	form := compareDosageForm(label, record)
	e.outcomes[contracts.FieldDosageForm] = form.outcome
	if labelForm := ClearValue(label, contracts.FieldDosageForm); form.outcome == outcomeConflict && labelForm != nil && record.StrengthForm != nil {
		e.conflicts = append(e.conflicts, contracts.FieldConflict{Key: contracts.FieldDosageForm, LabelValue: *labelForm, ReferenceValue: *record.StrengthForm})
	}
	for _, o := range e.outcomes {
		if o == outcomeMatched {
			e.score++
		}
	}
	e.nameMatched = e.outcomes[contracts.FieldBrandName] == outcomeMatched || e.outcomes[contracts.FieldGenericNames] == outcomeMatched
	e.formBlocksVerified = form.blocksVerified
	return e
}

func (e *evaluation) is(key contracts.FieldKey, o outcome) bool {
	got, ok := e.outcomes[key]
	return ok && got == o
}

// isVerified is rule 3, strict.
func isVerified(e *evaluation) bool {
	return len(e.conflicts) == 0 && !e.formBlocksVerified &&
		e.is(contracts.FieldRegistrationNumber, outcomeMatched) &&
		e.is(contracts.FieldBrandName, outcomeMatched) &&
		e.is(contracts.FieldStrength, outcomeMatched)
}

// isPartial is rule 4: a name match plus a matched strength. A name match on
// the record a clear registration number selected (rule 1) also reaches
// partial.
func isPartial(e *evaluation) bool {
	return len(e.conflicts) == 0 && e.nameMatched &&
		(e.is(contracts.FieldStrength, outcomeMatched) || e.is(contracts.FieldRegistrationNumber, outcomeMatched))
}

func keysWith(e *evaluation, o outcome) []contracts.FieldKey {
	out := []contracts.FieldKey{}
	for _, k := range compared {
		if e.is(k, o) {
			out = append(out, k)
		}
	}
	return out
}

// bestOf keeps the evaluations with the top score, in order.
func bestOf(es []*evaluation) []*evaluation {
	if len(es) == 0 {
		return nil
	}
	top := es[0].score
	for _, e := range es[1:] {
		top = max(top, e.score)
	}
	var out []*evaluation
	for _, e := range es {
		if e.score == top {
			out = append(out, e)
		}
	}
	return out
}

func withNotes(m contracts.MatchAssessment, notes []string) contracts.MatchAssessment {
	m.Limitations = []string{}
	if len(m.Candidates) > 0 {
		m.Limitations = append(m.Limitations, expiryNote)
	}
	m.Limitations = append(m.Limitations, notes...)
	return m
}

func allMatched(es []*evaluation, k contracts.FieldKey) bool {
	for _, e := range es {
		if !e.is(k, outcomeMatched) {
			return false
		}
	}
	return true
}

func records(es []*evaluation) []contracts.ReferenceRecord {
	out := make([]contracts.ReferenceRecord, len(es))
	for i, e := range es {
		out[i] = e.record
	}
	return out
}

// conflictResult is a `conflicting` result over one or more records: every
// conflict is listed (identical entries once), and a field counts as
// matched only if it matched on every listed record.
func conflictResult(es []*evaluation, advisories []contracts.Advisory, notes []string) contracts.MatchAssessment {
	conflicting := []contracts.FieldConflict{}
	for _, e := range es {
		for _, c := range e.conflicts {
			if !slices.Contains(conflicting, c) {
				conflicting = append(conflicting, c)
			}
		}
	}
	matched := []contracts.FieldKey{}
	missing := []contracts.FieldKey{}
	for _, k := range compared {
		if allMatched(es, k) {
			matched = append(matched, k)
		}
	}
	for _, k := range compared {
		if !slices.Contains(matched, k) && !slices.ContainsFunc(conflicting, func(c contracts.FieldConflict) bool { return c.Key == k }) {
			missing = append(missing, k)
		}
	}
	return withNotes(contracts.MatchAssessment{
		Status:      contracts.MatchConflicting,
		Matched:     matched,
		Conflicting: conflicting,
		Missing:     missing,
		Candidates:  records(es),
		Advisories:  advisories,
	}, notes)
}

// AssessMatch compares what the label says with the registry search result
// and returns the verification status (spec §5.4). A nil label has no
// fields, the weakest evidence.
func AssessMatch(label *contracts.ExtractedLabel, search contracts.SearchResult) contracts.MatchAssessment {
	empty := func(status contracts.MatchStatus, note string) contracts.MatchAssessment {
		return contracts.MatchAssessment{
			Status: status, Matched: []contracts.FieldKey{}, Conflicting: []contracts.FieldConflict{},
			Missing: []contracts.FieldKey{}, Candidates: []contracts.ReferenceRecord{},
			Advisories: []contracts.Advisory{}, Limitations: []string{note},
		}
	}
	switch search.Kind {
	case contracts.SearchUnavailable:
		return empty(contracts.MatchUnavailable, unavailableNote)
	case contracts.SearchNotAttempted:
		return empty(contracts.MatchNotAttempted, NotAttemptedNote)
	case contracts.SearchOK:
	default:
		// Not a TS case (the union has three kinds): nothing was checked,
		// so nothing is verified.
		return empty(contracts.MatchUnavailable, unavailableNote)
	}
	advisories := append([]contracts.Advisory{}, search.Advisories...)

	// Rule 1: a clear registration number found exactly selects that record.
	labelReg := ClearValue(label, contracts.FieldRegistrationNumber)
	var reg *string
	if labelReg != nil {
		reg = NormalizeRegistrationNumber(*labelReg)
	}
	var byReg []contracts.ReferenceRecord
	if reg != nil {
		for _, r := range search.Records {
			if n := NormalizeRegistrationNumber(r.RegistrationNumber); n != nil && *n == *reg {
				byReg = append(byReg, r)
			}
		}
	}

	var relevant []*evaluation
	// Rule 11: an advisory lookup that failed is said, so [] is never read
	// as "no advisory".
	var advisoryNotes []string
	if search.AdvisoriesUnchecked {
		advisoryNotes = []string{AdvisoriesUncheckedNote}
	}
	notes := append([]string{}, advisoryNotes...)
	// Rule 1 with several records under one number: any record that cannot
	// be confirmed is unresolved evidence for the same registration, so
	// verified is out.
	unresolvedSibling := false
	if len(byReg) > 0 {
		for _, r := range byReg {
			e := evaluate(label, r, true)
			relevant = append(relevant, &e)
		}
		// Rule 6 on the rule 1 path: every record under this number speaks
		// for the pack, so a conflict on any of them is never outweighed by
		// a fit.
		var conflicted []*evaluation
		for _, e := range relevant {
			if len(e.conflicts) > 0 {
				conflicted = append(conflicted, e)
			}
		}
		if len(conflicted) > 0 {
			return conflictResult(conflicted, advisories, notes)
		}
		allVerified := true
		for _, e := range relevant {
			allVerified = allVerified && isVerified(e)
		}
		unresolvedSibling = len(relevant) > 1 && !allVerified
	} else {
		// A clear number on the pack that the registry does not hold is
		// worth saying.
		if labelReg != nil {
			notes = append([]string{RegNotFoundNote}, advisoryNotes...)
		}
		// Rule 2: a name search can return other products. A record is
		// about this label only if its brand or generic matches; a record
		// whose brand disagrees is a different product, not a conflict.
		for _, r := range search.Records {
			e := evaluate(label, r, false)
			if e.nameMatched && !e.is(contracts.FieldBrandName, outcomeConflict) {
				relevant = append(relevant, &e)
			}
		}
	}
	var fitting, conflicting []*evaluation
	for _, e := range relevant {
		if e.nameMatched && len(e.conflicts) == 0 {
			fitting = append(fitting, e)
		}
		// Only reachable on the rule 2 path, where a fit may outrank a conflict.
		if len(e.conflicts) > 0 {
			conflicting = append(conflicting, e)
		}
	}

	if len(fitting) > 0 {
		best := bestOf(fitting)
		// Rule 7: equal best score, choose none. A tie of weak fits does
		// not outrank a conflicting record (rule 6).
		if len(best) > 1 && (len(conflicting) == 0 || slices.ContainsFunc(best, isPartial)) {
			shared := []contracts.FieldKey{}
			missing := []contracts.FieldKey{}
			for _, k := range compared {
				if allMatched(best, k) {
					shared = append(shared, k)
				} else {
					missing = append(missing, k)
				}
			}
			return withNotes(contracts.MatchAssessment{
				Status:      contracts.MatchAmbiguous,
				Matched:     shared,
				Conflicting: []contracts.FieldConflict{},
				Missing:     missing,
				Candidates:  records(best),
				Advisories:  advisories,
			}, notes)
		}
		if chosen := best[0]; len(best) == 1 && isPartial(chosen) {
			status := contracts.MatchPartial
			if isVerified(chosen) && !unresolvedSibling {
				status = contracts.MatchVerified
			}
			return withNotes(contracts.MatchAssessment{
				Status:      status,
				Matched:     keysWith(chosen, outcomeMatched),
				Conflicting: []contracts.FieldConflict{},
				Missing:     keysWith(chosen, outcomeMissing),
				Candidates:  []contracts.ReferenceRecord{chosen.record},
				Advisories:  advisories,
			}, notes)
		}
	}

	// Rule 6: with no record that positively fits, a conflict outranks no_match.
	if len(conflicting) > 0 {
		return conflictResult(bestOf(conflicting)[:1], advisories, notes)
	}

	// Rule 8. missing lists the compared fields the label itself could not supply.
	missing := []contracts.FieldKey{}
	for _, k := range compared {
		if ClearValue(label, k) == nil {
			missing = append(missing, k)
		}
	}
	return withNotes(contracts.MatchAssessment{
		Status:      contracts.MatchNoMatch,
		Matched:     []contracts.FieldKey{},
		Conflicting: []contracts.FieldConflict{},
		Missing:     missing,
		Candidates:  []contracts.ReferenceRecord{},
		Advisories:  advisories,
	}, notes)
}
