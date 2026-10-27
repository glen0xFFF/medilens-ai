// Package domain holds the pure label/registry logic ported from
// apps/server/src/domain. Nothing here does I/O.
package domain

// Port of apps/server/src/domain/parsers.ts. Every function is conservative:
// when in doubt it returns nil or "not equal", so a mismatch is surfaced
// instead of a false confirmation.
//
// The TS regular expressions use lookbehind and lookahead, which Go's RE2
// does not support, so each one is re-expressed as a hand-written scanner
// over runes. Every replaced region is BMP-only (ASCII digits, letters,
// JS whitespace, `%`, `/`), so rune indices line up exactly with the TS
// UTF-16 indices. Character classes follow JS, not Go:
//   - `\s` is the JS set (isJSSpace), which differs from unicode.IsSpace
//     (no U+0085, but U+FEFF);
//   - `\d` is ASCII only, `\p{N}`/`\p{L}`/`\p{Cf}`/`\p{So}`/`\p{Sc}` are
//     the Unicode categories;
//   - non-`u` case-insensitive classes (`/gi`, `/i`) match ASCII letters
//     only (plus `Μ` for `[µμ]`), `u` case-insensitive words also accept the
//     simple case foldings `K` (U+212A) and `ſ` (U+017F) (foldRune).

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

// StrengthUnit is one of mg, mcg, g, mL, IU, %.
type StrengthUnit string

// PerUnit is one of mL, g, L.
type PerUnit string

// Per is the denominator of a concentration such as `250 mg/5 mL`.
type Per struct {
	Amount float64 `json:"amount"`
	Unit   PerUnit `json:"unit"`
}

// Strength mirrors the TS Strength. Per is only present for concentrations.
type Strength struct {
	Amount float64      `json:"amount"`
	Unit   StrengthUnit `json:"unit"`
	Per    *Per         `json:"per,omitempty"`
}

// strengthMark is the private-use character that marks where a recognised
// strength was blanked out.
const strengthMark = '\uE000'

var unitMap = map[string]StrengthUnit{
	"mcg":        "mcg",
	"microgram":  "mcg",
	"micrograms": "mcg",
	"mg":         "mg",
	"milligram":  "mg",
	"milligrams": "mg",
	"g":          "g",
	"gram":       "g",
	"grams":      "g",
	"ml":         "mL",
	"iu":         "IU",
	"%":          "%",
}

var perUnitMap = map[string]PerUnit{"ml": "mL", "g": "g", "l": "L"}

// isJSSpace is the JS RegExp `\s` set (WhiteSpace and LineTerminator).
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00A0', '\u1680',
		'\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF':
		return true
	}
	return r >= '\u2000' && r <= '\u200A'
}

func isDigit(r rune) bool       { return r >= '0' && r <= '9' }
func isASCIILetter(r rune) bool { return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') }
func isN(r rune) bool           { return unicode.IsNumber(r) }
func isL(r rune) bool           { return unicode.IsLetter(r) }
func isLN(r rune) bool          { return isL(r) || isN(r) }

// foldRune is the simple case folding a `/iu` RegExp applies, restricted
// to what can fold onto an ASCII letter.
func foldRune(r rune) rune {
	switch {
	case r >= 'A' && r <= 'Z':
		return r + ('a' - 'A')
	case r == '\u212A': // KELVIN SIGN
		return 'k'
	case r == '\u017F': // LATIN SMALL LETTER LONG S
		return 's'
	}
	return r
}

// asciiLower lowers ASCII letters only (a non-`u` `/i` match is ASCII).
func asciiLower(rs []rune) string {
	var b strings.Builder
	for _, r := range rs {
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		b.WriteRune(r)
	}
	return b.String()
}

func at(t []rune, i int) (rune, bool) {
	if i < 0 || i >= len(t) {
		return 0, false
	}
	return t[i], true
}

func skipSpace(t []rune, i int) int {
	for i < len(t) && isJSSpace(t[i]) {
		i++
	}
	return i
}

func skipDigits(t []rune, i int) int {
	for i < len(t) && isDigit(t[i]) {
		i++
	}
	return i
}

// number matches `\d+(?:\.\d+)?` at i and returns its end, or -1. Backtracking
// to a shorter number can never let the rest of any caller's pattern match,
// so the greedy match is the only one.
func number(t []rune, i int) int {
	if r, ok := at(t, i); !ok || !isDigit(r) {
		return -1
	}
	j := skipDigits(t, i)
	if r, ok := at(t, j); ok && r == '.' {
		if r2, ok := at(t, j+1); ok && isDigit(r2) {
			j = skipDigits(t, j+1)
		}
	}
	return j
}

// asciiLetterRun returns the end of the run of ASCII letters starting at i.
func asciiLetterRun(t []rune, i int) int {
	for i < len(t) && isASCIILetter(t[i]) {
		i++
	}
	return i
}

// unitAt matches UNIT, `(micrograms?|milligrams?|grams?|mcg|mg|g|ml|iu|%)(?![a-z])`
// with the `i` flag, at i. Every alternative is ASCII letters or `%`, and none
// may be followed by an ASCII letter, so a letter unit is the whole letter run.
func unitAt(t []rune, i int) (unit string, end int, ok bool) {
	r, ok := at(t, i)
	if !ok {
		return "", 0, false
	}
	if r == '%' {
		if n, ok := at(t, i+1); ok && isASCIILetter(n) {
			return "", 0, false
		}
		return "%", i + 1, true
	}
	end = asciiLetterRun(t, i)
	word := asciiLower(t[i:end])
	switch word {
	case "micrograms", "microgram", "milligrams", "milligram", "grams", "gram", "mcg", "mg", "g", "ml", "iu":
		return word, end, true
	}
	return "", 0, false
}

// perSepAt matches `\s*(?:\/|per(?![a-z]))\s*` (`i` flag) at i and returns
// whether the separator was `/` and the end, or ok=false.
func perSepAt(t []rune, i int) (slash bool, end int, ok bool) {
	p := skipSpace(t, i)
	r, has := at(t, p)
	switch {
	case !has:
		return false, 0, false
	case r == '/':
		return true, skipSpace(t, p+1), true
	case p+3 <= len(t) && asciiLower(t[p:p+3]) == "per":
		if n, ok := at(t, p+3); ok && isASCIILetter(n) {
			return false, 0, false
		}
		return false, skipSpace(t, p+3), true
	}
	return false, 0, false
}

type strengthMatch struct {
	start, end         int
	amount, unit       string
	perAmount, perUnit string
	hasPer, hasPerAmt  bool
}

// strengthAt matches STRENGTH_RE at i (the lookbehind is checked by the caller).
func strengthAt(t []rune, i int) (strengthMatch, bool) {
	numEnd := number(t, i)
	if numEnd < 0 {
		return strengthMatch{}, false
	}
	unit, unitEnd, ok := unitAt(t, skipSpace(t, numEnd))
	if !ok {
		return strengthMatch{}, false
	}
	m := strengthMatch{start: i, end: unitEnd, amount: string(t[i:numEnd]), unit: unit}
	// Optional PER group: `\s*(?:\/|per(?![a-z]))\s*(\d+(?:\.\d+)?)?\s*(ml|g|l)(?![a-z])`.
	_, q, ok := perSepAt(t, unitEnd)
	if !ok {
		return m, true
	}
	perAmt := ""
	hasPerAmt := false
	if n := number(t, q); n >= 0 {
		perAmt, hasPerAmt = string(t[q:n]), true
		q = n
	}
	q = skipSpace(t, q)
	uEnd := asciiLetterRun(t, q)
	switch pu := asciiLower(t[q:uEnd]); pu {
	case "ml", "g", "l":
		m.end = uEnd
		m.hasPer, m.perUnit = true, pu
		m.hasPerAmt, m.perAmount = hasPerAmt, perAmt
	}
	return m, true
}

// nextStrength finds the next STRENGTH_RE match at or after pos.
func nextStrength(t []rune, pos int) (strengthMatch, bool) {
	for i := pos; i < len(t); i++ {
		if !isDigit(t[i]) {
			continue
		}
		// `(?<![\d.a-z])` with the `i` flag.
		if p, ok := at(t, i-1); ok && (isDigit(p) || p == '.' || isASCIILetter(p)) {
			continue
		}
		if m, ok := strengthAt(t, i); ok {
			return m, true
		}
	}
	return strengthMatch{}, false
}

// startsWithStrength is STARTS_WITH_STRENGTH, `^NUMBER\s*UNIT`, at i.
func startsWithStrength(t []rune, i int) bool {
	n := number(t, i)
	if n < 0 {
		return false
	}
	_, _, ok := unitAt(t, skipSpace(t, n))
	return ok
}

// replaceMicroG is `.replace(/[µμ]g/gi, 'mcg')`. Without the `u` flag, `i`
// compares upper-case forms, so the capital `Μ` (U+039C) matches too.
func replaceMicroG(t []rune) []rune {
	out := make([]rune, 0, len(t))
	for i := 0; i < len(t); i++ {
		switch t[i] {
		case '\u00B5', '\u03BC', '\u039C':
			if n, ok := at(t, i+1); ok && (n == 'g' || n == 'G') {
				out = append(out, 'm', 'c', 'g')
				i++
				continue
			}
		}
		out = append(out, t[i])
	}
	return out
}

// dottedThousands is DOTTED_THOUSANDS,
// `(?<![\d.])[1-9]\d{0,2}\.\d{3}(?!\d)\s*[a-zµμ%]` with the `i` flag.
func dottedThousands(t []rune) bool {
	for i := 0; i < len(t); i++ {
		if t[i] < '1' || t[i] > '9' {
			continue
		}
		if p, ok := at(t, i-1); ok && (isDigit(p) || p == '.') {
			continue
		}
		j := skipDigits(t, i+1)
		if j-i-1 > 2 {
			continue
		}
		if r, ok := at(t, j); !ok || r != '.' {
			continue
		}
		if j+4 > len(t) || !isDigit(t[j+1]) || !isDigit(t[j+2]) || !isDigit(t[j+3]) {
			continue
		}
		if r, ok := at(t, j+4); ok && isDigit(r) {
			continue
		}
		r, ok := at(t, skipSpace(t, j+4))
		if ok && (isASCIILetter(r) || r == '%' || r == '\u00B5' || r == '\u03BC' || r == '\u039C') {
			return true
		}
	}
	return false
}

// isThousands is THOUSANDS, `^[1-9]\d?(?:,\d{3})+$`.
func isThousands(tok []rune) bool {
	if len(tok) == 0 || tok[0] < '1' || tok[0] > '9' {
		return false
	}
	i := 1
	if i < len(tok) && isDigit(tok[i]) {
		i++
	}
	groups := 0
	for i < len(tok) {
		if tok[i] != ',' || i+4 > len(tok) || !isDigit(tok[i+1]) || !isDigit(tok[i+2]) || !isDigit(tok[i+3]) {
			return false
		}
		i += 4
		groups++
	}
	return groups > 0
}

// foldThousands applies COMMA_NUMBER, `(?<![\p{N}.,])\d+(?:,\d+)+` (`gu`),
// dropping the commas of tokens that pass isThousands.
func foldThousands(t []rune) []rune {
	out := make([]rune, 0, len(t))
	for i := 0; i < len(t); {
		start := i
		if !isDigit(t[i]) {
			out = append(out, t[i])
			i++
			continue
		}
		if p, ok := at(t, i-1); ok && (isN(p) || p == '.' || p == ',') {
			out = append(out, t[i])
			i++
			continue
		}
		j := skipDigits(t, i)
		groups := 0
		for {
			c, ok := at(t, j)
			d, ok2 := at(t, j+1)
			if !ok || !ok2 || c != ',' || !isDigit(d) {
				break
			}
			j = skipDigits(t, j+1)
			groups++
		}
		if groups == 0 {
			out = append(out, t[i])
			i++
			continue
		}
		tok := t[start:j]
		for _, r := range tok {
			if r != ',' || !isThousands(tok) {
				out = append(out, r)
			}
		}
		i = j
	}
	return out
}

// hasWord is WORD, `\p{L}{2}`.
func hasWord(t []rune) bool {
	for i := 0; i+1 < len(t); i++ {
		if isL(t[i]) && isL(t[i+1]) {
			return true
		}
	}
	return false
}

// closesWordGroup reports whether the bracket at text[at] closes a group of
// the same bracket type that holds a word.
func closesWordGroup(text []rune, idx int) bool {
	closeB := text[idx]
	openB := '['
	if closeB == ')' {
		openB = '('
	}
	depth := 0
	for j := idx - 1; j >= 0; j-- {
		if text[j] == closeB {
			depth++
		} else if text[j] == openB {
			if depth == 0 {
				return hasWord(text[j+1 : idx])
			}
			depth--
		}
	}
	return false
}

// acceptedJoinShape is ACCEPTED_JOIN, `^(?:\s+|\.|[)\]]+\s+)$`.
func acceptedJoinShape(gap []rune) bool {
	if len(gap) == 0 {
		return false
	}
	if len(gap) == 1 && gap[0] == '.' {
		return true
	}
	i := 0
	for i < len(gap) && (gap[i] == ')' || gap[i] == ']') {
		i++
	}
	brackets := i
	for i < len(gap) && isJSSpace(gap[i]) {
		i++
	}
	if i != len(gap) {
		return false
	}
	return brackets == 0 || i > brackets
}

// isAcceptedJoin reports whether gap, found at text[start], is an accepted
// join between two numbers.
func isAcceptedJoin(text []rune, start int, gap []rune) bool {
	if !acceptedJoinShape(gap) {
		return false
	}
	for k, r := range gap {
		if (r == ')' || r == ']') && !closesWordGroup(text, start+k) {
			return false
		}
	}
	return true
}

// hasUnacceptedJoin applies NUMBER_GAP, `\p{N}(?=([^\p{L}\p{N}]+)\p{N})` (`gu`).
func hasUnacceptedJoin(text []rune) bool {
	for i, r := range text {
		if !isN(r) {
			continue
		}
		j := i + 1
		for j < len(text) && !isLN(text[j]) {
			j++
		}
		if j == i+1 || j >= len(text) || !isN(text[j]) {
			continue
		}
		if !isAcceptedJoin(text, i+1, text[i+1:j]) {
			return true
		}
	}
	return false
}

// lnRun returns the end of the run of letters and numbers starting at i.
func lnRun(t []rune, i int) int {
	for i < len(t) && isLN(t[i]) {
		i++
	}
	return i
}

// foldEquals compares t, under `/iu` case folding, to the ASCII word w.
func foldEquals(t []rune, w string) bool {
	if len(t) != len(w) {
		return false
	}
	for k, r := range t {
		if foldRune(r) != rune(w[k]) {
			return false
		}
	}
	return true
}

// wordIn reports whether the whole [\p{L}\p{N}] run t[i:end] is one of
// words. Each pattern alternative must be followed by `(?![\p{L}\p{N}])`,
// so it can only match a whole run.
func wordIn(t []rune, i int, words []string) (end int, ok bool) {
	end = lnRun(t, i)
	for _, w := range words {
		if foldEquals(t[i:end], w) {
			return end, true
		}
	}
	return 0, false
}

var (
	countWords    = []string{"tablets", "tablet", "capsules", "capsule", "caplets", "caplet", "sachets", "sachet", "each", "x", "forte"}
	followerWords = []string{"tablets", "tablet", "capsules", "capsule", "caplets", "caplet", "sachets", "sachet", "each", "x", "forte", "plus", "and"}
	vitaminWords  = []string{"b1", "b2", "b3", "b5", "b6", "b7", "b9", "b12", "d2", "d3", "k1", "k2"}
)

// matcher matches an allowlisted pattern at i and returns its end.
type matcher func(t []rune, i int) (int, bool)

// packGridAt is PACK_GRID, `(?<![\p{L}\p{N}.])\d+\s*x\s*\d+(?![\p{N}.])` (`giu`).
func packGridAt(t []rune, i int) (int, bool) {
	if !isDigit(t[i]) {
		return 0, false
	}
	if p, ok := at(t, i-1); ok && (isLN(p) || p == '.') {
		return 0, false
	}
	k := skipSpace(t, skipDigits(t, i))
	if r, ok := at(t, k); !ok || (r != 'x' && r != 'X') {
		return 0, false
	}
	k = skipSpace(t, k+1)
	if r, ok := at(t, k); !ok || !isDigit(r) {
		return 0, false
	}
	end := skipDigits(t, k)
	if r, ok := at(t, end); ok && (isN(r) || r == '.') {
		return 0, false
	}
	return end, true
}

// countWordAt is COUNT_WORD,
// `(?<![\p{L}\p{N}.])\d+\s*(?:tablets?|...|x|forte)(?![\p{L}\p{N}])` (`giu`).
func countWordAt(t []rune, i int) (int, bool) {
	if !isDigit(t[i]) {
		return 0, false
	}
	if p, ok := at(t, i-1); ok && (isLN(p) || p == '.') {
		return 0, false
	}
	return wordIn(t, skipSpace(t, skipDigits(t, i)), countWords)
}

// vitaminAt is VITAMIN_NAME,
// `(?<![\p{L}\p{N}])(?:b(?:1|2|3|5|6|7|9|12)|d2|d3|k1|k2)(?![\p{L}\p{N}])` (`giu`).
func vitaminAt(t []rune, i int) (int, bool) {
	if !isLN(t[i]) {
		return 0, false
	}
	if p, ok := at(t, i-1); ok && isLN(p) {
		return 0, false
	}
	return wordIn(t, i, vitaminWords)
}

func isSlashLike(r rune) bool {
	return r == '/' || r == '\\' || r == '\u2044' || r == '\u2215'
}

func isUnitLikeStart(r rune) bool {
	return isL(r) || unicode.Is(unicode.So, r) || unicode.Is(unicode.Sc, r) || r == '%' || r == '\u2030'
}

// isFollowerSkip is FOLLOWER_SKIP's class, `[^\p{L}\p{N}\p{So}\p{Sc}%‰]`.
func isFollowerSkip(r rune) bool {
	return !isN(r) && !isUnitLikeStart(r) && r != strengthMark
}

// followedByUnitLikeText reports whether the text after `from` starts, past
// punctuation and any chain of follower words, with something that could be
// a unit, or whether a slash is skipped on the way. text is the unblanked
// input, rune-aligned with s.
func followedByUnitLikeText(s []rune, from int, text []rune) bool {
	i := from
	for {
		start := i
		for i < len(s) && isFollowerSkip(s[i]) {
			i++
		}
		skipped := s[start:i]
		for _, r := range skipped {
			if isSlashLike(r) {
				return true
			}
		}
		if i == len(s) {
			return false
		}
		if !isUnitLikeStart(s[i]) {
			return len(skipped) > 0 && !isAcceptedJoin(text, start, skipped)
		}
		end, ok := wordIn(s, i, followerWords)
		if !ok {
			return true
		}
		i = end
	}
}

// blankAllowlisted blanks every match of an allowlisted pattern, or returns
// nil if any match is followed by unit-like text.
func blankAllowlisted(residual []rune, match matcher, text []rune) []rune {
	out := append([]rune(nil), residual...)
	for i := 0; i < len(residual); {
		end, ok := match(residual, i)
		if !ok {
			i++
			continue
		}
		if followedByUnitLikeText(residual, end, text) {
			return nil
		}
		for k := i; k < end; k++ {
			out[k] = ' '
		}
		i = end
	}
	return out
}

// jsNumber is `Number(s)` for a `\d+(?:\.\d+)?` string.
func jsNumber(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f // ±Inf on overflow, as in JS
}

// ParseStrength parses every strength in s and fails closed (nil). Every
// digit in the input must be consumed, either by a recognised strength or by
// an allowlisted non-strength pattern (pack counts, vitamin names). If any
// digit is left over, a strength has an unknown `per`, or the number is an
// ambiguous `1.000`, the result is nil.
func ParseStrength(s string) []Strength {
	// NFKC folds full-width `ｍｇ`, the `㎎` ligature and NBSP into plain text.
	text := replaceMicroG([]rune(jsNFKC(s)))
	for _, r := range text {
		// The strength marker must not be forgeable from the input, and a
		// format character can hide a join between numbers (`0<ZWSP>,5`).
		if r == strengthMark || unicode.Is(unicode.Cf, r) {
			return nil
		}
	}
	if dottedThousands(text) {
		return nil
	}
	text = foldThousands(text)
	if hasUnacceptedJoin(text) {
		return nil
	}

	var out []Strength
	residual := append([]rune(nil), text...)
	for pos := 0; ; {
		m, ok := nextStrength(text, pos)
		if !ok {
			break
		}
		// Only `500mg/125mg` (a slash between two strengths) may follow a strength.
		if slash, after, ok := perSepAt(text, m.end); ok && !(slash && startsWithStrength(text, after)) {
			return nil
		}
		for k := m.start; k < m.end; k++ {
			residual[k] = strengthMark
		}
		unit, ok := unitMap[m.unit]
		if !ok {
			return nil
		}
		entry := Strength{Amount: jsNumber(m.amount), Unit: unit}
		if m.hasPer {
			perUnit, ok := perUnitMap[m.perUnit]
			if !ok {
				return nil
			}
			amount := 1.0
			if m.hasPerAmt {
				amount = jsNumber(m.perAmount)
			}
			entry.Per = &Per{Amount: amount, Unit: perUnit}
		}
		out = append(out, entry)
		pos = m.end
	}

	for _, match := range []matcher{packGridAt, countWordAt, vitaminAt} {
		residual = blankAllowlisted(residual, match, text)
		if residual == nil {
			return nil
		}
	}
	// `\p{N}` also catches digits that `\d` misses, e.g. Arabic-Indic `١٠`.
	for _, r := range residual {
		if isN(r) {
			return nil
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

type canonicalStrength struct {
	amount       float64
	dimension    string
	hasPer       bool
	perAmount    float64
	perDimension string
}

var massToMcg = map[StrengthUnit]float64{"mcg": 1, "mg": 1_000, "g": 1_000_000}

var perToBase = map[PerUnit]struct {
	factor    float64
	dimension string
}{
	"mL": {1, "mL"},
	"L":  {1_000, "mL"},
	"g":  {1, "g"},
}

func canonical(s Strength) canonicalStrength {
	c := canonicalStrength{amount: s.Amount, dimension: string(s.Unit)}
	if f, ok := massToMcg[s.Unit]; ok {
		c.amount, c.dimension = s.Amount*f, "mass"
	}
	if s.Per != nil {
		if p, ok := perToBase[s.Per.Unit]; ok {
			c.hasPer, c.perAmount, c.perDimension = true, s.Per.Amount*p.factor, p.dimension
		}
	}
	return c
}

func numbersEqual(a, b float64) bool {
	return math.Abs(a-b) <= 1e-9*math.Max(math.Max(math.Abs(a), math.Abs(b)), 1)
}

func canonicalEqual(a, b canonicalStrength) bool {
	if a.dimension != b.dimension || a.hasPer != b.hasPer || a.perDimension != b.perDimension {
		return false
	}
	if !numbersEqual(a.amount, b.amount) {
		return false
	}
	return !a.hasPer || numbersEqual(a.perAmount, b.perAmount)
}

// StrengthsEqual is multiset equality after unit normalisation (mcg/mg/g
// convert; IU, % and mL only compare with the same unit). `per` must match
// exactly after normalisation: `250 mg/5 mL` is not equal to `50 mg/mL`.
// A nil slice is the TS null and never equals anything; an empty non-nil
// slice is the TS `[]`.
func StrengthsEqual(a, b []Strength) bool {
	if a == nil || b == nil || len(a) != len(b) {
		return false
	}
	remaining := make([]canonicalStrength, 0, len(b))
	for _, s := range b {
		remaining = append(remaining, canonical(s))
	}
	for _, s := range a {
		item := canonical(s)
		idx := -1
		for k, r := range remaining {
			if canonicalEqual(item, r) {
				idx = k
				break
			}
		}
		if idx == -1 {
			return false
		}
		remaining = append(remaining[:idx], remaining[idx+1:]...)
	}
	return true
}

var regRE = regexp.MustCompile(`^(?:DR-XY|DRHR-|DRP-|DR-)[0-9]+$`)

// NormalizeRegistrationNumber upper-cases (JS full case mapping), drops JS
// whitespace and folds typographic dashes; it returns nil unless the result
// is a well-formed PH FDA registration number.
func NormalizeRegistrationNumber(s string) *string {
	upper := cases.Upper(language.Und).String(s)
	var b strings.Builder
	for _, r := range upper {
		switch {
		case isJSSpace(r):
			continue
		// OCR often yields typographic dashes: U+2010..U+2015 and U+2212.
		case (r >= '\u2010' && r <= '\u2015') || r == '\u2212':
			b.WriteRune('-')
		default:
			b.WriteRune(r)
		}
	}
	cleaned := b.String()
	if !regRE.MatchString(cleaned) {
		return nil
	}
	return &cleaned
}

// DosageFormWords is the one dosage-form vocabulary: lower-case word to
// canonical form. The matcher compares canonical forms, and NormalizeName
// drops every word here (and every modifier) from names. Treat as read-only.
var DosageFormWords = map[string]string{
	"tablet":   "tablet",
	"tablets":  "tablet",
	"capsule":  "capsule",
	"capsules": "capsule",
	// A softgel is a soft gelatin capsule.
	"softgel":       "capsule",
	"softgels":      "capsule",
	"caplet":        "caplet",
	"caplets":       "caplet",
	"syrup":         "syrup",
	"elixir":        "elixir",
	"suspension":    "suspension",
	"solution":      "solution",
	"cream":         "cream",
	"ointment":      "ointment",
	"gel":           "gel",
	"lotion":        "lotion",
	"drop":          "drops",
	"drops":         "drops",
	"injection":     "injection",
	"powder":        "powder",
	"granule":       "granules",
	"granules":      "granules",
	"sachet":        "sachet",
	"sachets":       "sachet",
	"suppository":   "suppository",
	"suppositories": "suppository",
	"spray":         "spray",
	"lozenge":       "lozenge",
	"lozenges":      "lozenge",
	"patch":         "patch",
	"patches":       "patch",
	"inhaler":       "inhaler",
}

// DosageFormModifiers qualify a form without changing it: a film-coated
// tablet is a tablet. Treat as read-only.
var DosageFormModifiers = map[string]bool{"film-coated": true}

// DropsQualifiers make `drops` a different form (`eye drops` is not `ear
// drops`). NormalizeName keeps them, because they also occur in brand names.
// Treat as read-only.
var DropsQualifiers = map[string]bool{"eye": true, "ear": true, "nasal": true}

func isFormWord(word string) bool {
	_, ok := DosageFormWords[word]
	return ok || DosageFormModifiers[word]
}

// NormalizeName lower-cases (JS full case mapping), turns ® and ™ into
// spaces, splits on JS whitespace and drops dosage-form words and modifiers.
func NormalizeName(s string) string {
	lower := jsLower(s)
	lower = strings.NewReplacer("\u00AE", " ", "\u2122", " ").Replace(lower)
	words := strings.FieldsFunc(lower, isJSSpace)
	kept := make([]string, 0, len(words))
	for _, w := range words {
		if !isFormWord(w) {
			kept = append(kept, w)
		}
	}
	return strings.Join(kept, " ")
}
