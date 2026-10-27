package domain

// Port of apps/server/src/domain/answers.ts: deterministic answers to
// questions the safety gate allowed (Task 7b controller ruling). Every
// answer is built here from the scan's printed fields and fixed sentences.
// The one model contribution is the explain_text explanation: the server
// quotes the whole printed field around the asked phrase verbatim
// (ExplainQuote), and adds a short model explanation of it only when the
// field has no printed negation or condition and the explanation is made of
// the closed vocabulary below (ExplanationFits). The model never writes any
// other answer text.
//
// The closed-vocabulary RegExps are flagless and run through jsregex from
// the TS sources (global replaces through ReplaceAllFunc). The phrase
// lookup's `iu` RegExp is a scanner here (locate):
//
//	new RegExp((WORD_CHAR(first) ? '(?<![\p{L}\p{N}])' : '') +
//	  escapeRegExp(needle) +
//	  (WORD_CHAR(last) ? '(?![\p{L}\p{N}])' : ''), 'iu')
//
// A `u` RegExp matches whole code points, and with `i` it compares them by
// simple case folding: foldEqual uses Go's case orbits, isLNFold the
// lookaround class under folding; TestCaseFoldTables checks both against
// V8 for every code point. The remaining small RegExps:
//
//	/[‘’‛′`]/g etc.   foldPunctuation (one unit for one)
//	/\.+$/, /[.!?]+$/                      strings.TrimRight
//	/\p{Cf}/gu                             unicode.Cf (TestJSUnicodeTables)
//	/\p{Nd}/u                              unicode.Nd
//	/[ .,!]+/ split                        strings.FieldsFunc (empties skipped)

import (
	"slices"
	"strings"
	"unicode"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/jsregex"
)

// AnswerFallbackText: the answer when nothing else may be said.
const AnswerFallbackText = "I can only answer from what is printed on the label."

// PhraseNotFoundText: the asked phrase is printed in no field.
const PhraseNotFoundText = "I can't find that phrase on this label."

// NoLabelText: the scan has no readable label to answer from.
const NoLabelText = "I couldn't read this label, so I can't answer questions about it."

const (
	noExplanation = "I can't explain this phrase further."
	uncertain     = "Some of this was not clear on the pack, so it may be wrong."
	nothingRead   = "I could not read that on this label."
	allClear      = "Every part I read on this label was clear."
)

// FieldNames is how each field is named when its printed value is read
// back ("Expiry date as printed: ..."). Treat as read-only.
var FieldNames = map[contracts.FieldKey]string{
	contracts.FieldBrandName:          "Brand name",
	contracts.FieldGenericNames:       "Generic name",
	contracts.FieldStrength:           "Strength",
	contracts.FieldDosageForm:         "Dosage form",
	contracts.FieldManufacturer:       "Manufacturer",
	contracts.FieldRegistrationNumber: "Registration number",
	contracts.FieldDirections:         "Directions",
	contracts.FieldWarnings:           "Warnings",
	contracts.FieldStorage:            "Storage",
	contracts.FieldExpiryDate:         "Expiry date",
	contracts.FieldBatchNumber:        "Batch number",
	contracts.FieldRxOrOtc:            "Prescription status",
}

// fieldNameLower is FIELD_NAMES[key].toLowerCase() (the names are ASCII).
func fieldNameLower(key contracts.FieldKey) string { return strings.ToLower(FieldNames[key]) }

// pluralFields take a plural verb ("The warnings on the label say ...").
var pluralFields = []contracts.FieldKey{contracts.FieldDirections, contracts.FieldWarnings}

// readKeys: a whole-label read, every field in reading order (final review I3).
var readKeys = contracts.FieldKeys

// explainKeys: what an explain_text question that names no field or phrase
// reads back ("What does this mean?").
var explainKeys = []contracts.FieldKey{contracts.FieldDirections, contracts.FieldWarnings}

// registryKeys: the registry answer cites the first of these the scan printed.
var registryKeys = []contracts.FieldKey{
	contracts.FieldRegistrationNumber,
	contracts.FieldBrandName,
	contracts.FieldGenericNames,
	contracts.FieldStrength,
}

// AnswerInput is what an answer is built from: the scan, the question and
// the safety gate's allowed intent (refused questions never reach here).
type AnswerInput struct {
	Label    contracts.ExtractedLabel  `json:"label"`
	Match    contracts.MatchAssessment `json:"match"`
	Question string                    `json:"question"`
	Intent   AllowedIntent             `json:"intent"`
}

// keysFor is the fields read back for a question (final review I3): the
// field the question names, else the intent's default.
func keysFor(intent AllowedIntent, question string) []contracts.FieldKey {
	if intent == IntentStrength {
		return []contracts.FieldKey{contracts.FieldStrength}
	}
	if asked := AskedFields(question); asked != nil {
		return asked
	}
	if intent == IntentExplainText {
		return explainKeys
	}
	return readKeys
}

/* ------------------------------------------------------------- building */

func hasValue(f contracts.LabelField) bool {
	return f.Value != nil && jsTrim(*f.Value) != ""
}

// fieldOf is the first field of key with a value, or nil.
func fieldOf(fields []contracts.LabelField, key contracts.FieldKey) *contracts.LabelField {
	for i := range fields {
		if fields[i].Key == key && hasValue(fields[i]) {
			return &fields[i]
		}
	}
	return nil
}

func uniqueKeys(keys []contracts.FieldKey) []contracts.FieldKey {
	out := []contracts.FieldKey{}
	for _, k := range keys {
		if !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	return out
}

// UnclearAnswer is a fixed non-answer: nothing is cited, and the final
// confirm line is still spoken.
func UnclearAnswer(text string) contracts.Answer {
	return contracts.Answer{
		Status:       contracts.AnswerUnclear,
		Text:         text,
		SpokenChunks: []string{text, FinalLine},
		CitedFields:  []contracts.FieldKey{},
		SafetyNotice: nil,
	}
}

// ConflictWarning is the fixed warning for a cited field the FDA registry
// record contradicts (spec §5.3 rule 6): the printed value is never read
// back as certain.
func ConflictWarning(key contracts.FieldKey, referenceValue string) string {
	ref := strings.TrimRight(jsTrim(referenceValue), ".")
	return "The FDA registry record lists " + ref + " for the " + fieldNameLower(key) +
		", which does not match the pack. Confirm with your pharmacist."
}

// build is the answer around sentences: conflict warnings for cited fields,
// the uncertain sentence, and the final confirm line last.
func build(sentences []string, cited []contracts.FieldKey, isUncertain bool, match contracts.MatchAssessment) contracts.Answer {
	if len(sentences) == 0 {
		return UnclearAnswer(nothingRead)
	}
	// one warning per conflicting field, the first registry value (final review Minor 6)
	var notices []string
	var warned []contracts.FieldKey
	for _, c := range match.Conflicting {
		if slices.Contains(cited, c.Key) && !slices.Contains(warned, c.Key) {
			warned = append(warned, c.Key)
			notices = append(notices, ConflictWarning(c.Key, c.ReferenceValue))
		}
	}
	if isUncertain {
		notices = append(notices, uncertain)
	}
	all := append(slices.Clone(sentences), notices...)
	var notice *string
	if len(notices) > 0 {
		n := strings.Join(notices, " ")
		notice = &n
	}
	return contracts.Answer{
		Status:       contracts.AnswerAnswered,
		Text:         strings.Join(all, " "),
		SpokenChunks: append(slices.Clone(all), FinalLine),
		CitedFields:  slices.Clone(cited),
		SafetyNotice: notice,
	}
}

/* -------------------------------------------------------- label answers */

// NotALabelAnswer (final review I2): a scan that is not a readable medicine
// pack answers every label question with the summary's own sentence, never
// a field value: a loose tablet is never identified, even if the model
// filled fields from its imprint. Nil for a label. An image kind outside
// the schema is answered as unreadable (TS returns undefined there, which
// also never reads a field).
func NotALabelAnswer(label contracts.ExtractedLabel) *contracts.Answer {
	var a contracts.Answer
	switch label.ImageKind {
	case contracts.ImageKindLabel:
		return nil
	case contracts.ImageKindLoosePill:
		a = UnclearAnswer(LoosePillSentence)
	case contracts.ImageKindNotMedicine:
		a = UnclearAnswer(NotALabelSentence)
	default:
		a = UnclearAnswer(NoLabelText)
	}
	return &a
}

// AnswerFromLabel is the deterministic answer from the label fields of the
// scan, for every allowed intent. Printed values are read back verbatim;
// nothing is inferred.
func AnswerFromLabel(in AnswerInput) contracts.Answer {
	if a := NotALabelAnswer(in.Label); a != nil {
		return *a
	}
	switch in.Intent {
	case IntentUnclearParts:
		return unclearParts(in.Label.Fields, in.Match)
	case IntentRegistry:
		return registryAnswer(in.Label.Fields, in.Match)
	default:
		return readBack(in.Label.Fields, keysFor(in.Intent, in.Question), in.Match)
	}
}

func unclearParts(fields []contracts.LabelField, match contracts.MatchAssessment) contracts.Answer {
	var unclear []contracts.LabelField
	for _, f := range fields {
		if f.Legibility != contracts.LegibilityClear {
			unclear = append(unclear, f)
		}
	}
	if len(unclear) == 0 {
		var read []contracts.FieldKey
		for _, k := range readKeys {
			if fieldOf(fields, k) != nil {
				read = append(read, k)
			}
		}
		if len(read) == 0 {
			return UnclearAnswer(nothingRead)
		}
		return build([]string{allClear}, read, false, match)
	}
	names := make([]string, len(unclear))
	// an unreadable field with no value is named, but there is no value to cite
	var cited []contracts.FieldKey
	for i, f := range unclear {
		names[i] = fieldNameLower(f.Key)
		if hasValue(f) {
			cited = append(cited, f.Key)
		}
	}
	return build(
		[]string{"These parts were not clear on the pack: " + strings.Join(names, ", ") + "."},
		uniqueKeys(cited), true, match,
	)
}

// registryAnswer is the registry outcome in the spoken summary's own
// sentences and notes, in its order (final review Minor 6).
func registryAnswer(fields []contracts.LabelField, match contracts.MatchAssessment) contracts.Answer {
	for _, key := range registryKeys {
		f := fieldOf(fields, key)
		if f == nil {
			continue
		}
		sentences := VerificationSentences(match)
		for _, note := range []string{RegNotFoundNote, AdvisoriesUncheckedNote} {
			if slices.Contains(match.Limitations, note) {
				sentences = append(sentences, note)
			}
		}
		if advisory := AdvisorySentence(match.Advisories); advisory != nil {
			sentences = append(sentences, *advisory)
		}
		return build(sentences, []contracts.FieldKey{key}, f.Legibility != contracts.LegibilityClear, match)
	}
	return UnclearAnswer(nothingRead)
}

// readBack reads each printed value as its own sentence. A value that is
// not clear carries the summary's marker before it (final review I1:
// "Strength as printed, partly unclear: 500 mg."), so the listener knows
// which value may be wrong.
func readBack(fields []contracts.LabelField, keys []contracts.FieldKey, match contracts.MatchAssessment) contracts.Answer {
	var sentences []string
	cited := []contracts.FieldKey{}
	isUncertain := false
	for _, key := range keys {
		f := fieldOf(fields, key)
		if f == nil {
			continue
		}
		cited = append(cited, key)
		value := strings.TrimRight(jsTrim(*f.Value), ".")
		name := FieldNames[key] + " as printed"
		if f.Legibility != contracts.LegibilityClear {
			name += ", " + PartlyUnclear
			isUncertain = true
		}
		sentences = append(sentences, name+": "+value+".")
	}
	return build(sentences, cited, isUncertain, match)
}

/* ------------------------------------------------------ printed phrases */

// PhraseHit is a field whose printed value contains the asked phrase.
type PhraseHit struct {
	Key contracts.FieldKey `json:"key"`
	// Printed is the phrase exactly as printed (original case), whitespace
	// runs collapsed.
	Printed    string               `json:"printed"`
	Legibility contracts.Legibility `json:"legibility"`
}

// foldPunctuation maps typographic quotes and dashes to ASCII, one code
// point (and one UTF-16 unit) for one, so indices are kept.
func foldPunctuation(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '‘', '’', '‛', '′', '`':
			return '\''
		case '“', '”', '„', '‟', '″':
			return '"'
		}
		if r >= '‐' && r <= '―' {
			return '-'
		}
		return r
	}, s)
}

// foldEqual is whether a `iu` RegExp matches b for the literal a: equal
// under Unicode simple case folding (the same case orbit).
func foldEqual(a, b rune) bool {
	if a == b {
		return true
	}
	for o := unicode.SimpleFold(a); o != a; o = unicode.SimpleFold(o) {
		if o == b {
			return true
		}
	}
	return false
}

// isLNFold is /[\p{L}\p{N}]/iu on one code point: a letter or number, or a
// character case-folded together with one (U+0345 folds with iota).
func isLNFold(r rune) bool {
	if isLN(r) {
		return true
	}
	for o := unicode.SimpleFold(r); o != r; o = unicode.SimpleFold(o) {
		if isLN(o) {
			return true
		}
	}
	return false
}

// locatedHit is a hit with where it sits (in code points) in its field's
// collapsed printed value.
type locatedHit struct {
	PhraseHit
	value      string
	start, end int
}

// locate finds the phrase in each field, as the TS `iu` RegExp does: the
// first match in each field's collapsed, punctuation-folded value.
func locate(phrase string, label contracts.ExtractedLabel) []locatedHit {
	needle := []rune(foldPunctuation(jsCollapse(phrase)))
	if len(needle) == 0 {
		return nil
	}
	boundaryBefore := isLN(needle[0])
	boundaryAfter := isLN(needle[len(needle)-1])
	var hits []locatedHit
	for _, f := range label.Fields {
		if f.Value == nil {
			continue
		}
		value := jsCollapse(*f.Value)
		text := []rune(foldPunctuation(value))
		start := findFolded(text, needle, boundaryBefore, boundaryAfter)
		if start < 0 {
			continue
		}
		end := start + len(needle)
		hits = append(hits, locatedHit{
			PhraseHit: PhraseHit{Key: f.Key, Printed: string([]rune(value)[start:end]), Legibility: f.Legibility},
			value:     value,
			start:     start,
			end:       end,
		})
	}
	return hits
}

// findFolded is the code-point index of the first match of needle in text
// under simple case folding, with the optional letter-or-number boundaries,
// or -1.
func findFolded(text, needle []rune, boundaryBefore, boundaryAfter bool) int {
	for i := 0; i+len(needle) <= len(text); i++ {
		if boundaryBefore && i > 0 && isLNFold(text[i-1]) {
			continue
		}
		j := 0
		for j < len(needle) && foldEqual(needle[j], text[i+j]) {
			j++
		}
		if j < len(needle) {
			continue
		}
		if end := i + len(needle); boundaryAfter && end < len(text) && isLNFold(text[end]) {
			continue
		}
		return i
	}
	return -1
}

// FindPhraseInFields is every field whose printed value contains phrase:
// case-insensitive, with whitespace runs collapsed and typographic quotes
// matched as straight ones. A phrase never matches part of a printed word
// ("ache" is not in "headache"). Field values only, never rawText: the
// model is only ever asked about text the scan transcribed into a field.
// The result is never nil.
func FindPhraseInFields(phrase string, label contracts.ExtractedLabel) []PhraseHit {
	out := []PhraseHit{}
	for _, h := range locate(phrase, label) {
		out = append(out, h.PhraseHit)
	}
	return out
}

// fieldQuote is the whole printed field value of a hit, without its end
// punctuation.
func fieldQuote(h locatedHit) string {
	quote := jsTrim(strings.TrimRight(h.value, ".!?"))
	if quote == "" {
		return h.Printed
	}
	return quote
}

// ExplainQuote is what an explain_text answer quotes and the model is sent
// (Task 7b review rounds 1 and 2, dropped context): not the asked fragment
// and not its sentence, but the whole printed value of the first field
// that prints it, so a printed "Do not", heading or lead-in anywhere in the
// field is always spoken. Nil when the phrase is printed in no field.
func ExplainQuote(phrase string, label contracts.ExtractedLabel) *string {
	hits := locate(phrase, label)
	if len(hits) == 0 {
		return nil
	}
	q := fieldQuote(hits[0])
	return &q
}

/* ------------------------------------------ explanation: closed vocabulary */

// Task 7b review round 2: the content gate is an allowlist. An explanation
// may use only the words and the three phrase shapes below; anything else
// is rejected. The vocabulary has no verb of taking, using, mixing,
// applying or stopping, no "with", "for", "as" or "is", and no number,
// time, amount, person, verdict, permission or medical-claim word. Its only
// negation is "not" before a storage hazard, ending its sentence ("not hot
// or damp"), and "need" only appears in "need a prescription", so neither
// can be turned into its opposite. Over-rejection only costs the
// explanation; the printed quote is still spoken.

// vocabTopic is a topic of the vocabulary: used only when the printed text is
// about it.
type vocabTopic struct {
	// cue matches the printed text (normalized, lowercase) when it is about
	// this topic.
	cue   *jsregex.Regexp
	words []string
	// phrases are fixed shapes, each matched whole and ending its sentence.
	phrases []*jsregex.Regexp
}

// generalWords have no topic: they say nothing on their own.
var generalWords = []string{"a", "an", "and", "bottle", "in", "it", "its", "means", "or", "the", "this"}

const (
	hazard       = `(?:hot|warm|damp|wet|humid|moist)`
	hazardSource = `(?:heat|(?:direct )?(?:sun)?light|(?:the )?sun|moisture|humidity|damp|steam)`
	andOr        = `(?:,? (?:or|and) |, )`
)

// shape is a whole phrase shape: starts a word and ends its sentence.
func shape(source string) *jsregex.Regexp {
	return jsregex.MustCompile(`(?<![a-z'])(?:` + source + `)(?=[.!]|$)`)
}

// listOf is "a", "a or b", "a, b and c".
func listOf(item string) string { return item + `(?:` + andOr + item + `)*` }

var vocabTopics = []vocabTopic{
	{
		// storage
		cue:   jsregex.MustCompile(`(?<![a-z])(?:stor(?:e|es|ed|ing|age)|keep|kept|protect[a-z]*|refrigerat[a-z]*)(?![a-z])`),
		words: []string{"closed", "container", "cool", "dark", "dry", "keep", "lid", "place", "shut", "somewhere", "store", "tightly"},
		phrases: []*jsregex.Regexp{
			// the only negation: "(that is) not hot or damp"
			shape(`(?:(?:that|which) is )?not ` + listOf(hazard)),
			shape(`away from ` + listOf(hazardSource)),
		},
	},
	{
		// shaking
		cue:   jsregex.MustCompile(`(?<![a-z])shak(?:e|es|en|ing)(?![a-z])`),
		words: []string{"first", "gently", "shake", "well"},
	},
	{
		// needing a prescription, never the reverse
		cue: jsregex.MustCompile(`(?<![a-z])(?:prescri[a-z]*|rx|dispens[a-z]*)(?![a-z])`),
		phrases: []*jsregex.Regexp{
			shape(`(?:you )?need a (?:doctor's )?prescription(?: from a doctor)?(?: to (?:buy|get) (?:it|this))?`),
		},
	},
}

// ExplanationWords is every single word an explanation may use, sorted (a
// fresh slice); pinned by a test.
func ExplanationWords() []string {
	words := slices.Clone(generalWords)
	for _, t := range vocabTopics {
		words = append(words, t.words...)
	}
	slices.Sort(words)
	return words
}

const (
	maxExplanationChars = 240
	maxExplanationWords = 40
)

var (
	// fake: global constraint, never "fake" or "counterfeit" about the
	// pack, inside any word too.
	fake     = jsregex.MustCompile(`fake|counterfeit`)
	urlOrAt  = jsregex.MustCompile(`@|:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|gov|edu|ph|io|info|co|us|uk)\b`)
	outsideA = jsregex.MustCompile(`[^a-z' .,!]`) // lowercase ASCII letters, apostrophes, spaces and . , ! only
)

// normalizeExplanation is NFKC, invisible format characters removed, ASCII
// quotes and dashes, one line.
func normalizeExplanation(text string) string {
	t := strings.Map(func(r rune) rune {
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, jsNFKC(text))
	return jsCollapse(foldPunctuation(t))
}

// explanationTopics is the set of topics (indices into vocabTopics) an
// explanation uses, or ok false when it is not inside the closed
// vocabulary (or is empty, too long, or has a digit, a link or "fake").
func explanationTopics(text string) (used []bool, ok bool) {
	t := jsLower(normalizeExplanation(text))
	if t == "" || jsLen(t) > maxExplanationChars {
		return nil, false
	}
	if len(strings.Split(t, " ")) > maxExplanationWords {
		return nil, false
	}
	if strings.IndexFunc(t, func(r rune) bool { return unicode.Is(unicode.Nd, r) }) >= 0 ||
		fake.Test(t) || urlOrAt.Test(t) || outsideA.Test(t) {
		return nil, false
	}
	used = make([]bool, len(vocabTopics))
	rest := t
	for i, tp := range vocabTopics {
		for _, phrase := range tp.phrases {
			rest = phrase.ReplaceAllFunc(rest, func(string) string {
				used[i] = true
				return " "
			})
		}
	}
	words := strings.FieldsFunc(rest, func(r rune) bool { return r == ' ' || r == '.' || r == ',' || r == '!' })
	for _, word := range words {
		if slices.Contains(generalWords, word) {
			continue
		}
		i := slices.IndexFunc(vocabTopics, func(tp vocabTopic) bool { return slices.Contains(tp.words, word) })
		if i < 0 {
			return nil, false
		}
		used[i] = true
	}
	return used, true
}

// ExplanationAllowed is the content gate for a model explanation: true
// only when every word is in the closed vocabulary (ExplanationWords, plus
// the "not hot or damp", "away from heat" and "need a prescription"
// shapes), within 240 characters and 40 words, with no digit, link, "@",
// "fake" or "counterfeit". Over-rejection is accepted: the fallback is the
// quote-only answer.
func ExplanationAllowed(text string) bool {
	_, ok := explanationTopics(text)
	return ok
}

// notExplainedWords is printed text the vocabulary cannot carry: a
// negation, condition, exception, limit or group of people (finding 2 of
// review round 2 found negations printed as a heading or lead-in).
// Over-inclusion only costs the explanation.
var notExplainedWords = []string{
	// negation
	"not", "no", "never", "nor", "none", "neither", "nothing", "nobody", "nowhere", "without",
	"cannot", "[a-z]*n't", "dont", "doesnt", "didnt", "cant", "wont", "shouldnt", "mustnt", "isnt",
	"arent", "neednt", "non[a-z]*",
	// sold without a prescription: "need a prescription" would be false
	"otc", "counter",
	// condition, exception, limit
	"if", "unless", "except[a-z]*", "until", "till", "but", "however", "otherwise", "instead",
	"whether", "when[a-z]*", "while", "whilst", "provided", "limit[a-z]*", "exceed[a-z]*",
	"max[a-z]*", "overdos[a-z]*",
	// stopping, avoiding, warning
	"avoid[a-z]*", "stop[a-z]*", "discontinu[a-z]*", "discard[a-z]*", "dispos[a-z]*",
	"prohibit[a-z]*", "forbid[a-z]*", "contraindicat[a-z]*", "refrain[a-z]*", "caution[a-z]*",
	"warn[a-z]*", "beware", "danger[a-z]*", "consult[a-z]*",
	// groups of people
	"child[a-z]*", "kids?", "infants?", "bab(?:y|ies)", "toddlers?", "adults?", "elderly",
	"seniors?", "teen[a-z]*", "adolescen[a-z]*", "pregnan[a-z]*", "breast[ -]?fe[a-z]*", "nursing",
	"lactat[a-z]*", "patients?", "persons?", "people", "years?", "aged?",
}

var notExplained = jsregex.MustCompile(`(?<![a-z0-9])(?:` + strings.Join(notExplainedWords, "|") + `)(?![a-z0-9])`)

// printedForm is printed text as the cues see it: normalized, lowercase,
// one line.
func printedForm(printed string) string { return jsLower(normalizeExplanation(printed)) }

func quoteExplainableForm(p string) bool {
	if notExplained.Test(p) {
		return false
	}
	return slices.ContainsFunc(vocabTopics, func(tp vocabTopic) bool { return tp.cue.Test(p) })
}

// QuoteExplainable is whether printed text may be explained by the model at
// all: it has no negation, condition, exception, limit or group of people,
// and it is about a topic the vocabulary covers (storage, shaking, a
// prescription). When this is false the model is not called and the answer
// is the quote alone.
func QuoteExplainable(printed string) bool { return quoteExplainableForm(printedForm(printed)) }

// ExplanationFits is whether a model explanation may be spoken after this
// printed quote: the quote is explainable, the explanation passes
// ExplanationAllowed, and every topic the explanation uses is one the
// printed text is about (no storage advice after a dose, no prescription
// talk after a storage line).
func ExplanationFits(explanation, printed string) bool {
	used, ok := explanationTopics(explanation)
	// an explanation of general words only ("It means this.") says nothing
	if !ok || !slices.Contains(used, true) {
		return false
	}
	p := printedForm(printed)
	if !quoteExplainableForm(p) {
		return false
	}
	for i, u := range used {
		if u && !vocabTopics[i].cue.Test(p) {
			return false
		}
	}
	return true
}

/* ------------------------------------------------------ explain answers */

// ComposeExplainAnswer is the explain_text answer: the whole printed field
// around the phrase, quoted verbatim from the first field that prints it
// (ExplainQuote), marked partly unclear when that field is not clear, then
// the explanation if it fits that quote (ExplanationFits), else a fixed
// sentence. Answered even without an explanation: the quote is grounded.
// explanation is nil when the model was not asked or gave none.
func ComposeExplainAnswer(in AnswerInput, phrase string, explanation *string) contracts.Answer {
	if a := NotALabelAnswer(in.Label); a != nil {
		return *a
	}
	hits := locate(phrase, in.Label)
	if len(hits) == 0 {
		return UnclearAnswer(PhraseNotFoundText)
	}
	first := hits[0]
	printed := fieldQuote(first)
	says := "says"
	if slices.Contains(pluralFields, first.Key) {
		says = "say"
	}
	marker := ""
	if first.Legibility != contracts.LegibilityClear {
		marker = ", " + PartlyUnclear + ","
	}
	quote := "The " + fieldNameLower(first.Key) + " on the label" + marker + " " + says + ` "` + printed + `".`
	second := noExplanation
	if explanation != nil && ExplanationFits(*explanation, printed) {
		second = "In plain words: " + sentence(normalizeExplanation(*explanation))
	}
	keys := make([]contracts.FieldKey, len(hits))
	isUncertain := false
	for i, h := range hits {
		keys[i] = h.Key
		if h.Legibility != contracts.LegibilityClear {
			isUncertain = true
		}
	}
	return build([]string{quote, second}, uniqueKeys(keys), isUncertain, in.Match)
}
