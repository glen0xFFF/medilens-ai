package domain

// JS String.prototype.normalize('NFKC') and String.prototype.toLowerCase()
// as V8 computes them with ICU. golang.org/x/text bounds two contexts at 30
// characters where ICU has no bound (task G3 review round 1):
//
//   - norm.NFKC follows the UAX #15 Stream-Safe Text Format: after 30
//     consecutive non-starters it inserts U+034F COMBINING GRAPHEME JOINER,
//     which blocks canonical reordering and composition across it. The
//     safety gate then strips the U+034F as default-ignorable, so a question
//     could normalise to more code units in Go than in V8 and cross the
//     300-unit cap that V8 did not cross.
//   - cases.Lower looks at most 30 case-ignorables ahead for Final_Sigma,
//     and before a Σ it takes a character that is both cased and
//     case-ignorable (U+02B0, U+0345, ...) as cased, where ICU skips it.
//
// jsNFKC therefore runs the UAX #15 algorithm itself on x/text's
// per-character data: full compatibility decomposition, canonical ordering
// of every run of non-starters however long, then canonical composition.
// jsLower decides each Σ itself, with ICU's unbounded context, and leaves
// the context-free mappings to x/text. TestJSUnicodeTables checks both per
// code point against V8 (including the Σ context of every code point), and
// TestUnicodeRuns on V8-recorded strings with runs past 30 characters.

import (
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// Hangul syllable arithmetic (Unicode §3.12).
const (
	hangulSBase  = 0xAC00
	hangulLBase  = 0x1100
	hangulVBase  = 0x1161
	hangulTBase  = 0x11A7
	hangulLCount = 19
	hangulVCount = 21
	hangulTCount = 28
	hangulNCount = hangulVCount * hangulTCount
	hangulSCount = hangulLCount * hangulNCount
)

// jsNFKC is String.prototype.normalize('NFKC'): UAX #15 NFKC without the
// Stream-Safe bound (ICU never inserts U+034F).
func jsNFKC(s string) string {
	if isASCII(s) {
		return s // ASCII has no decomposition and composes with nothing in ASCII
	}
	rs := make([]rune, 0, len(s))
	for _, r := range s {
		rs = appendNFKD(rs, r)
	}
	ccc := make([]uint8, len(rs))
	for i, r := range rs {
		ccc[i] = combiningClass(r)
	}
	canonicalOrder(rs, ccc)
	return string(canonicalCompose(rs, ccc))
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// appendNFKD appends the full compatibility decomposition of r: x/text's
// per-character decomposition, and the Hangul syllable arithmetic x/text
// does not store.
func appendNFKD(dst []rune, r rune) []rune {
	if r < utf8.RuneSelf {
		return append(dst, r)
	}
	if s := r - hangulSBase; s >= 0 && s < hangulSCount {
		dst = append(dst, hangulLBase+s/hangulNCount, hangulVBase+s%hangulNCount/hangulTCount)
		if t := s % hangulTCount; t != 0 {
			dst = append(dst, hangulTBase+t)
		}
		return dst
	}
	var buf [utf8.UTFMax]byte
	d := norm.NFKD.Properties(buf[:utf8.EncodeRune(buf[:], r)]).Decomposition()
	if d == nil {
		return append(dst, r)
	}
	for len(d) > 0 {
		x, n := utf8.DecodeRune(d)
		d = d[n:]
		dst = appendNFKD(dst, x) // a Hangul syllable inside a decomposition
	}
	return dst
}

// combiningClass is the canonical combining class of a character that has
// no decomposition.
func combiningClass(r rune) uint8 {
	if r < 0x300 {
		return 0 // the first non-starter is U+0300
	}
	var buf [utf8.UTFMax]byte
	return norm.NFD.Properties(buf[:utf8.EncodeRune(buf[:], r)]).CCC()
}

// canonicalOrder is the Canonical Ordering Algorithm: every run of
// non-starters is sorted stably by combining class, however long the run.
func canonicalOrder(rs []rune, ccc []uint8) {
	for i := 0; i < len(rs); {
		if ccc[i] == 0 {
			i++
			continue
		}
		j := i + 1
		for j < len(rs) && ccc[j] != 0 {
			j++
		}
		sortRun(rs[i:j], ccc[i:j])
		i = j
	}
}

// sortRun sorts one run of non-starters stably by combining class: a
// counting sort, linear in the length of the run.
func sortRun(rs []rune, ccc []uint8) {
	sorted := true
	for i := 1; i < len(rs); i++ {
		if ccc[i-1] > ccc[i] {
			sorted = false
			break
		}
	}
	if sorted {
		return
	}
	var start [257]int
	for _, c := range ccc {
		start[int(c)+1]++
	}
	for c := 1; c < len(start); c++ {
		start[c] += start[c-1]
	}
	outR, outC := make([]rune, len(rs)), make([]uint8, len(rs))
	for i, r := range rs {
		p := start[ccc[i]]
		outR[p], outC[p] = r, ccc[i]
		start[ccc[i]]++
	}
	copy(rs, outR)
	copy(ccc, outC)
}

// canonicalCompose is the Canonical Composition Algorithm (UAX #15 §1.3):
// a character that is not blocked from the last starter and forms a
// primary composite with it replaces that starter. It works in place.
func canonicalCompose(rs []rune, ccc []uint8) []rune {
	if len(rs) == 0 {
		return rs
	}
	starter := 0
	// last is the class of the last character kept after the starter: 0
	// when nothing is between them, 256 before the first starter.
	last := 0
	if ccc[0] != 0 {
		last = 256
	}
	w := 1
	for i := 1; i < len(rs); i++ {
		c := int(ccc[i])
		if last == 0 || last < c {
			if p, ok := composePair(rs[starter], rs[i]); ok {
				rs[starter] = p
				continue
			}
		}
		if c == 0 {
			starter = w
		}
		last = c
		rs[w] = rs[i]
		w++
	}
	return rs[:w]
}

// composePair is the primary composite of a and b, if there is one.
func composePair(a, b rune) (rune, bool) {
	if l, v := a-hangulLBase, b-hangulVBase; l >= 0 && l < hangulLCount && v >= 0 && v < hangulVCount {
		return hangulSBase + (l*hangulVCount+v)*hangulTCount, true
	}
	if s, t := a-hangulSBase, b-hangulTBase; s >= 0 && s < hangulSCount && s%hangulTCount == 0 && t > 0 && t < hangulTCount {
		return a + t, true
	}
	c, ok := primaryComposites()[pairKey(a, b)]
	return c, ok
}

func pairKey(a, b rune) uint64 { return uint64(a)<<21 | uint64(b) }

// primaryComposites maps each canonical pair to its primary composite. It
// is derived from x/text's tables: a primary composite is a character with
// a canonical decomposition that NFC keeps (which excludes singletons,
// non-starter decompositions and the composition exclusions), and its pair
// is the NFC of its full decomposition without the last character, then
// that last character. A character whose pair cannot be derived that way
// panics, so an x/text upgrade that broke the derivation fails loudly
// instead of leaving text uncomposed. TestJSUnicodeTables checks NFKC of
// every code point against V8, which composes every primary composite back
// from its full decomposition.
var primaryComposites = sync.OnceValue(func() map[uint64]rune {
	m := make(map[uint64]rune, 1024)
	var buf [utf8.UTFMax]byte
	for r := rune(utf8.RuneSelf); r <= unicode.MaxRune; r++ {
		if r >= 0xD800 && r <= 0xDFFF {
			continue
		}
		b := buf[:utf8.EncodeRune(buf[:], r)]
		d := norm.NFD.Properties(b).Decomposition()
		if d == nil || norm.NFC.String(string(b)) != string(b) {
			continue
		}
		full := []rune(string(d))
		if len(full) < 2 {
			panic("jsNFKC: primary composite with a one-character decomposition: " + string(b))
		}
		first := []rune(norm.NFC.String(string(full[:len(full)-1])))
		second := full[len(full)-1]
		if len(first) != 1 || norm.NFC.String(string(first)+string(second)) != string(b) {
			panic("jsNFKC: cannot derive the canonical pair of " + string(b))
		}
		key := pairKey(first[0], second)
		if _, dup := m[key]; dup {
			panic("jsNFKC: two primary composites for one pair, the second " + string(b))
		}
		m[key] = r
	}
	return m
})

var lowerCasers = sync.Pool{New: func() any {
	c := cases.Lower(language.Und)
	return &c
}}

// jsLower is String.prototype.toLowerCase (ICU, root locale). Final_Sigma
// is the only context-dependent lowercase mapping there, so the text
// between capital sigmas is lowercased by x/text's per-character mapping
// and each Σ is decided here.
func jsLower(s string) string {
	lower := func(t string) string {
		if isASCII(t) {
			return strings.ToLower(t) // A-Z only, as JS lowercases ASCII
		}
		// A Caser is stateful: each call takes one from the pool (String resets it).
		c := lowerCasers.Get().(*cases.Caser)
		defer lowerCasers.Put(c)
		return c.String(t)
	}
	i := strings.IndexRune(s, 'Σ')
	if i < 0 {
		return lower(s)
	}
	var b strings.Builder
	b.Grow(len(s))
	start := 0
	for {
		b.WriteString(lower(s[start:i]))
		if finalSigma(s, i) {
			b.WriteRune('ς')
		} else {
			b.WriteRune('σ')
		}
		start = i + len("Σ")
		j := strings.IndexRune(s[start:], 'Σ')
		if j < 0 {
			break
		}
		i = start + j
	}
	b.WriteString(lower(s[start:]))
	return b.String()
}

// finalSigma reports whether the Σ at byte offset i of s lowercases to the
// final form ς (SpecialCasing.txt Final_Sigma, as ICU evaluates it):
// skipping case-ignorable characters, even ones that are also cased, the
// nearest character before it is cased and the nearest one after it is
// not. Neither look is bounded.
func finalSigma(s string, i int) bool {
	before := false
	for t := s[:i]; t != ""; {
		r, n := utf8.DecodeLastRuneInString(t)
		if !isCaseIgnorable(r) {
			before = isCased(r)
			break
		}
		t = t[:len(t)-n]
	}
	if !before {
		return false
	}
	for _, r := range s[i+len("Σ"):] {
		if !isCaseIgnorable(r) {
			return !isCased(r)
		}
	}
	return true
}

// isCased is \p{Cased} (DerivedCoreProperties.txt): Lowercase (Ll and
// Other_Lowercase), Uppercase (Lu and Other_Uppercase) or Lt.
func isCased(r rune) bool {
	return unicode.In(r, unicode.Ll, unicode.Lu, unicode.Lt, unicode.Other_Lowercase, unicode.Other_Uppercase)
}

// isCaseIgnorable is \p{Case_Ignorable} (DerivedCoreProperties.txt): Mn,
// Me, Cf, Lm or Sk, or Word_Break MidLetter, MidNumLet or Single_Quote,
// which Go's unicode package has no table for, so they are listed
// (WordBreakProperty.txt, Unicode 17).
func isCaseIgnorable(r rune) bool {
	switch r {
	case '\'', // Single_Quote
		'.', '‘', '’', '․', '﹒', '＇', '．', // MidNumLet
		':', '·', '·', '՟', '״', '‧', '︓', '﹕', '：': // MidLetter
		return true
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk)
}
