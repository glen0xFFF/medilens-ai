// Package eval is the Go port of apps/server/src/eval (tag
// node-fallback-v1): the label accuracy eval scoring (score.go, spec §5.1
// "Accuracy eval") and the live smoke-test recorders and report (smoke.go).
// Pure functions and http.RoundTripper wrappers only: services/eval and
// services/smoke do the I/O.
//
// A field is "confidently wrong" when its value is wrong while the reader
// called it clear; an unreadable field is never confidently wrong.
package eval

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
)

// GroundTruth is eval/packs/<id>/truth.json after validation (Node
// GroundTruthSchema): every string trimmed as zod's .trim() outputs it.
type GroundTruth struct {
	PackID string
	// Images are file names inside the pack folder, in reading order (1-3).
	Images       []string
	BrandName    string
	GenericNames []string
	Strength     string
	DosageForm   string
	// RegistrationNumber is nil when the pack prints none.
	RegistrationNumber *string
	// ExpiryDate is nil when the pack prints none.
	ExpiryDate *string
}

// ScoredFields are the six eval fields, in report order.
var ScoredFields = []contracts.FieldKey{
	contracts.FieldBrandName,
	contracts.FieldGenericNames,
	contracts.FieldStrength,
	contracts.FieldDosageForm,
	contracts.FieldRegistrationNumber,
	contracts.FieldExpiryDate,
}

// FieldScore is one scored field of one read.
type FieldScore struct {
	Field            contracts.FieldKey
	Correct          bool
	Legibility       contracts.Legibility
	ConfidentlyWrong bool
}

/* ------------------------------------------------------------ truth file */

// The refine messages of GroundTruthSchema, verbatim.
const (
	strengthMessage     = `strength must be parseable, e.g. "500 mg"`
	registrationMessage = `registrationNumber must be a recognised registration number, e.g. "DR-XY12345"`
	expiryMessage       = `expiryDate must be a month and year, e.g. "03/2027", "2027-03" or "MAR 2027"`
)

// errInvalidJSON is the eval script's message for a truth file JSON.parse
// rejects.
var errInvalidJSON = errors.New("truth.json is not valid JSON")

type issue struct{ path, message string }

// IssuesError is a truth file that fails the schema. Its text is the
// issues as the Node eval script printed them: "path: message" joined by
// "; ", with zod 4's messages.
type IssuesError struct{ issues []issue }

func (e *IssuesError) Error() string {
	parts := make([]string, len(e.issues))
	for i, is := range e.issues {
		parts[i] = is.path + ": " + is.message
	}
	return strings.Join(parts, "; ")
}

// zodType is the name zod 4 gives a JSON value in "received ..." (absent
// is undefined).
func zodType(v any, present bool) string {
	switch v.(type) {
	case nil:
		if !present {
			return "undefined"
		}
		return "null"
	case string:
		return "string"
	case json.Number:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	}
	return "object"
}

func invalidType(want string, v any, present bool) string {
	return "Invalid input: expected " + want + ", received " + zodType(v, present)
}

// ParseGroundTruth parses and validates a truth.json body as
// JSON.parse then GroundTruthSchema.safeParse: an error is either "truth.json
// is not valid JSON" or an *IssuesError listing every issue in schema
// order.
func ParseGroundTruth(data []byte) (GroundTruth, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return GroundTruth{}, errInvalidJSON
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return GroundTruth{}, errInvalidJSON
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return GroundTruth{}, &IssuesError{[]issue{{"", invalidType("object", v, true)}}}
	}

	var issues []issue
	add := func(path, message string) { issues = append(issues, issue{path, message}) }
	// str is z.string().trim().min(1) plus an optional refine, which zod
	// runs even after min(1) fails.
	str := func(path string, v any, present bool, refine func(string) bool, refineMessage string) (string, bool) {
		s, isString := v.(string)
		if !isString {
			add(path, invalidType("string", v, present))
			return "", false
		}
		s = domain.JSTrim(s)
		valid := true
		if s == "" {
			add(path, "Too small: expected string to have >=1 characters")
			valid = false
		}
		if refine != nil && !refine(s) {
			add(path, refineMessage)
			valid = false
		}
		return s, valid
	}
	field := func(key string, refine func(string) bool, refineMessage string) string {
		v, present := obj[key]
		s, _ := str(key, v, present, refine, refineMessage)
		return s
	}
	// list is z.array(z.string().trim().min(1)).min(1)[.max(3)]: a length
	// issue is reported alone, as zod 4 does.
	list := func(key string, max int) []string {
		v, present := obj[key]
		items, isArray := v.([]any)
		if !isArray {
			add(key, invalidType("array", v, present))
			return nil
		}
		if len(items) < 1 {
			add(key, "Too small: expected array to have >=1 items")
			return nil
		}
		if max > 0 && len(items) > max {
			add(key, "Too big: expected array to have <="+strconv.Itoa(max)+" items")
			return nil
		}
		out := make([]string, len(items))
		for i, item := range items {
			out[i], _ = str(key+"."+strconv.Itoa(i), item, true, nil, "")
		}
		return out
	}
	nullable := func(key string, refine func(string) bool, refineMessage string) *string {
		v, present := obj[key]
		if present && v == nil {
			return nil
		}
		s, _ := str(key, v, present, refine, refineMessage)
		return &s
	}

	t := GroundTruth{}
	t.PackID = field("packId", nil, "")
	t.Images = list("images", 3)
	t.BrandName = field("brandName", nil, "")
	t.GenericNames = list("genericNames", 0)
	t.Strength = field("strength", func(s string) bool { return domain.ParseStrength(s) != nil }, strengthMessage)
	t.DosageForm = field("dosageForm", nil, "")
	t.RegistrationNumber = nullable("registrationNumber", func(s string) bool { return domain.NormalizeRegistrationNumber(s) != nil }, registrationMessage)
	t.ExpiryDate = nullable("expiryDate", func(s string) bool { _, ok := ParseMonthYear(s); return ok }, expiryMessage)
	if len(issues) > 0 {
		return GroundTruth{}, &IssuesError{issues}
	}
	return t, nil
}

/* ----------------------------------------------------------- comparisons */

var (
	months     = []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
	fullMonths = []string{"january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"}
)

// jsSpace is \s of a JS RegExp (WhiteSpace and LineTerminator); RE2's \s
// is ASCII only. The /i flag of the TS patterns (no u flag) folds ASCII
// letters only, so it is spelled out as [eE] etc.
const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	// /^exp(?:iry)?(?:\s+date)?\s*[.:]?\s*/i: an optional leading EXP,
	// Exp., EXP:, Expiry, Expiry date:
	expPrefix = regexp.MustCompile(`^[eE][xX][pP](?:[iI][rR][yY])?(?:` + jsSpace + `+[dD][aA][tT][eE])?` + jsSpace + `*[.:]?` + jsSpace + `*`)
	mmYYYY    = regexp.MustCompile(`^([0-9]{1,2})` + jsSpace + `*[/-]` + jsSpace + `*([0-9]{4})$`)
	yyyyMM    = regexp.MustCompile(`^([0-9]{4})` + jsSpace + `*[/-]` + jsSpace + `*([0-9]{1,2})$`)
	monYYYY   = regexp.MustCompile(`^([a-zA-Z]+)\.?` + jsSpace + `+([0-9]{4})$`)
	// /\s*(?:[,+/;&]|\band\b)\s*/i: the generic-name separators (\b is
	// ASCII in both)
	genericSeparator = regexp.MustCompile(jsSpace + `*(?:[,+/;&]|\b[aA][nN][dD]\b)` + jsSpace + `*`)
)

// MonthYear is an expiry month (1-12) and year.
type MonthYear struct {
	Month int
	Year  int
}

// ParseMonthYear reads an expiry as month and year. It accepts MM/YYYY,
// MM-YYYY, YYYY-MM and MON YYYY, each with an optional EXP prefix; ok is
// false for anything else.
func ParseMonthYear(s string) (MonthYear, bool) {
	text := domain.JSTrim(s)
	if loc := expPrefix.FindStringIndex(text); loc != nil {
		text = text[loc[1]:]
	}
	text = domain.JSTrim(text)
	var my MonthYear
	if m := mmYYYY.FindStringSubmatch(text); m != nil {
		my.Month, _ = strconv.Atoi(m[1])
		my.Year, _ = strconv.Atoi(m[2])
	} else if m := yyyyMM.FindStringSubmatch(text); m != nil {
		my.Year, _ = strconv.Atoi(m[1])
		my.Month, _ = strconv.Atoi(m[2])
	} else if m := monYYYY.FindStringSubmatch(text); m != nil {
		word := strings.ToLower(m[1]) // ASCII letters only
		idx := max(slices.Index(months, word), slices.Index(fullMonths, word))
		if idx == -1 {
			return MonthYear{}, false
		}
		my.Month = idx + 1
		my.Year, _ = strconv.Atoi(m[2])
	} else {
		return MonthYear{}, false
	}
	if my.Month < 1 || my.Month > 12 {
		return MonthYear{}, false
	}
	return my, true
}

// canonicalForm is the canonical dosage form text: NormalizeName drops
// form words (it is built for brand names), so forms are canonicalised
// here with the same vocabulary: "Film-coated tablets" is "tablet", and a
// qualifier such as "eye" stays, so "eye drops" is not "ear drops".
func canonicalForm(s string) string {
	var out []string
	for _, w := range domain.JSFields(domain.JSLower(s)) {
		if domain.DosageFormModifiers[w] {
			continue
		}
		if c, ok := domain.DosageFormWords[w]; ok {
			w = c
		}
		out = append(out, w)
	}
	return strings.Join(out, " ")
}

// CompareUTF16 is the JS default sort order (Array.prototype.sort with
// no comparator): UTF-16 code units.
func CompareUTF16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

// genericSet is the generic names on a label ("Amoxicillin + Clavulanic
// acid") as a sorted set of normalised names.
func genericSet(names []string) []string {
	seen := map[string]bool{}
	var set []string
	for _, n := range names {
		for _, part := range genericSeparator.Split(n, -1) {
			p := domain.NormalizeName(part)
			if p != "" && !seen[p] {
				seen[p] = true
				set = append(set, p)
			}
		}
	}
	slices.SortFunc(set, CompareUTF16)
	return set
}

// valueMatches reports whether a non-null read value equals the truth for
// field.
func valueMatches(field contracts.FieldKey, truth GroundTruth, value string) bool {
	switch field {
	case contracts.FieldBrandName:
		t := domain.NormalizeName(truth.BrandName)
		return t != "" && t == domain.NormalizeName(value)
	case contracts.FieldGenericNames:
		t := genericSet(truth.GenericNames)
		return len(t) > 0 && slices.Equal(t, genericSet([]string{value}))
	case contracts.FieldStrength:
		// StrengthsEqual is false when either side is unparseable
		return domain.StrengthsEqual(domain.ParseStrength(truth.Strength), domain.ParseStrength(value))
	case contracts.FieldDosageForm:
		return canonicalForm(truth.DosageForm) == canonicalForm(value)
	case contracts.FieldRegistrationNumber:
		if truth.RegistrationNumber == nil {
			return false
		}
		t := domain.NormalizeRegistrationNumber(*truth.RegistrationNumber)
		r := domain.NormalizeRegistrationNumber(value)
		return t != nil && r != nil && *t == *r
	case contracts.FieldExpiryDate:
		if truth.ExpiryDate == nil {
			return false
		}
		t, tok := ParseMonthYear(*truth.ExpiryDate)
		r, rok := ParseMonthYear(value)
		return tok && rok && t == r
	}
	return false
}

func truthIsNull(field contracts.FieldKey, truth GroundTruth) bool {
	return (field == contracts.FieldRegistrationNumber && truth.RegistrationNumber == nil) ||
		(field == contracts.FieldExpiryDate && truth.ExpiryDate == nil)
}

// ScoreLabel scores the six eval fields of one read. A field missing from
// the read is scored as an unreadable null. A null truth (not printed on
// the pack) is correct when the read is null or unreadable.
func ScoreLabel(truth GroundTruth, label contracts.ExtractedLabel) []FieldScore {
	out := make([]FieldScore, 0, len(ScoredFields))
	for _, field := range ScoredFields {
		var value *string
		legibility := contracts.LegibilityUnreadable
		// the first field with the key, as Array.prototype.find
		for _, f := range label.Fields {
			if f.Key == field {
				value, legibility = f.Value, f.Legibility
				break
			}
		}
		var correct bool
		if truthIsNull(field, truth) {
			correct = value == nil || legibility == contracts.LegibilityUnreadable
		} else {
			correct = value != nil && valueMatches(field, truth, *value)
		}
		out = append(out, FieldScore{
			Field:            field,
			Correct:          correct,
			Legibility:       legibility,
			ConfidentlyWrong: !correct && legibility == contracts.LegibilityClear,
		})
	}
	return out
}

/* ------------------------------------------------------------- aggregate */

// FieldSummary is the counts for one field over every scored pack.
type FieldSummary struct {
	Field            contracts.FieldKey
	Total            int
	Correct          int
	Unreadable       int
	ConfidentlyWrong int
}

// Summary is the aggregate of a run: counts only, no pack ids or values.
type Summary struct {
	Packs  int
	Fields []FieldSummary
}

// Summarize aggregates the scores of every scored pack.
func Summarize(perPack [][]FieldScore) Summary {
	s := Summary{Packs: len(perPack)}
	for _, field := range ScoredFields {
		fs := FieldSummary{Field: field}
		for _, pack := range perPack {
			for _, sc := range pack {
				if sc.Field != field {
					continue
				}
				fs.Total++
				if sc.Correct {
					fs.Correct++
				}
				if sc.Legibility == contracts.LegibilityUnreadable {
					fs.Unreadable++
				}
				if sc.ConfidentlyWrong {
					fs.ConfidentlyWrong++
				}
			}
		}
		s.Fields = append(s.Fields, fs)
	}
	return s
}

// MeetsBar is the bar (spec §5.1): zero confidently-wrong strengths or
// expiry dates.
func MeetsBar(s Summary) bool {
	for _, f := range s.Fields {
		if (f.Field == contracts.FieldStrength || f.Field == contracts.FieldExpiryDate) && f.ConfidentlyWrong != 0 {
			return false
		}
	}
	return true
}

// Run is how many packs a run saw: every pack folder found, those the run
// started on before any spend-cap stop, and those skipped (bad truth
// file, missing or invalid image, OCR_FAILED). Scored packs are
// Summary.Packs.
type Run struct {
	Found     int
	Attempted int
	Skipped   int
}

// RenderResultsMarkdown is docs/eval-results.md: aggregate counts only, no
// images or read text, byte for byte as the Node renderer wrote it.
func RenderResultsMarkdown(s Summary, date string, run Run) string {
	notAttempted := run.Found - run.Attempted
	clean := run.Skipped == 0 && notAttempted == 0
	lines := []string{
		"# Label accuracy eval results",
		"",
		"Run date: " + date + ". Reader: live Muse Spark.",
		"",
		fmt.Sprintf("Packs found: %d. Attempted: %d. Scored: %d. Skipped: %d. Not attempted (spend cap): %d.",
			run.Found, run.Attempted, s.Packs, run.Skipped, notAttempted),
	}
	if !clean {
		lines = append(lines, "", fmt.Sprintf("**Not a clean run:** the counts and the bar below cover the %d scored packs only.", s.Packs))
	}
	lines = append(lines,
		"",
		"Aggregate counts only. Photos, pack identities and read text stay on the owner's machine.",
		"",
		"| Field | Total | Correct | Unreadable | Confidently wrong |",
		"| --- | --- | --- | --- | --- |",
	)
	for _, f := range s.Fields {
		lines = append(lines, fmt.Sprintf("| %s | %d | %d | %d | %d |", f.Field, f.Total, f.Correct, f.Unreadable, f.ConfidentlyWrong))
	}
	bar := "NOT MET"
	if MeetsBar(s) {
		bar = "MET"
	}
	lines = append(lines, "", "Bar (zero confidently-wrong strengths or expiry dates): "+bar+".", "")
	return strings.Join(lines, "\n")
}
