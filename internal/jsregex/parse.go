package jsregex

import (
	"fmt"
	"sort"
	"unicode/utf16"
)

// kind is the type of a pattern node.
type kind uint8

const (
	kEmpty    kind = iota
	kLit           // a run of code units
	kClass         // one code unit from a set
	kSeq           // terms in order
	kAlt           // alternatives in order
	kGroup         // capturing group
	kRepeat        // quantified atom
	kBOL           // ^ (no m flag: start of input only)
	kEOL           // $ (no m flag: end of input only)
	kWordB         // \b
	kNotWordB      // \B
	kLook          // (?=, (?!, (?<=, (?<!
)

// node is the parsed pattern (direction-free).
type node struct {
	kind   kind
	lit    []uint16
	set    *charSet
	subs   []*node
	index  int // kGroup: capture index, 1-based
	min    int // kRepeat
	max    int // kRepeat; < 0 is unbounded
	greedy bool
	capLo  int // kRepeat: captures inside the atom are [capLo, capHi)
	capHi  int
	behind bool // kLook
	negate bool // kLook
}

// SyntaxError reports a pattern this package does not accept: a JS syntax
// error, or a construct the safety patterns never use (backreferences, named
// groups, flags, quantified assertions, identity escapes of letters and
// digits). Failing loudly keeps a pattern from being read differently from V8.
type SyntaxError struct {
	Source string
	Pos    int // code-unit offset
	Msg    string
}

func (e *SyntaxError) Error() string {
	return fmt.Sprintf("jsregex: %s at offset %d in /%s/", e.Msg, e.Pos, e.Source)
}

type parser struct {
	source string
	src    []uint16
	pos    int
	ncap   int
}

func (p *parser) fail(format string, args ...any) error {
	return &SyntaxError{Source: p.source, Pos: p.pos, Msg: fmt.Sprintf(format, args...)}
}

func (p *parser) more() bool { return p.pos < len(p.src) }

func (p *parser) peekIs(u uint16) bool { return p.more() && p.src[p.pos] == u }

func (p *parser) peekStr(s string) bool {
	for i, r := range []byte(s) {
		if p.pos+i >= len(p.src) || p.src[p.pos+i] != uint16(r) {
			return false
		}
	}
	return true
}

// parse parses a whole pattern. The pattern is read as UTF-16 code units,
// as a JS RegExp without the u flag reads it.
func parse(source string) (*node, int, error) {
	p := &parser{source: source, src: utf16.Encode([]rune(source))}
	n, err := p.disjunction()
	if err != nil {
		return nil, 0, err
	}
	if p.more() {
		return nil, 0, p.fail("unmatched ')'")
	}
	return n, p.ncap, nil
}

func (p *parser) disjunction() (*node, error) {
	var alts []*node
	for {
		a, err := p.alternative()
		if err != nil {
			return nil, err
		}
		alts = append(alts, a)
		if !p.peekIs('|') {
			break
		}
		p.pos++
	}
	if len(alts) == 1 {
		return alts[0], nil
	}
	return &node{kind: kAlt, subs: alts}, nil
}

func (p *parser) alternative() (*node, error) {
	var items []*node
	for p.more() && !p.peekIs('|') && !p.peekIs(')') {
		t, err := p.term()
		if err != nil {
			return nil, err
		}
		// Adjacent literal runs merge, so a word is one comparison.
		if t.kind == kLit && len(items) > 0 && items[len(items)-1].kind == kLit {
			last := items[len(items)-1]
			last.lit = append(last.lit, t.lit...)
			continue
		}
		items = append(items, t)
	}
	switch len(items) {
	case 0:
		return &node{kind: kEmpty}, nil
	case 1:
		return items[0], nil
	}
	return &node{kind: kSeq, subs: items}, nil
}

func (p *parser) term() (*node, error) {
	c := p.src[p.pos]
	switch c {
	case '^':
		p.pos++
		return p.noQuantifier(&node{kind: kBOL})
	case '$':
		p.pos++
		return p.noQuantifier(&node{kind: kEOL})
	case '\\':
		if p.pos+1 < len(p.src) {
			switch p.src[p.pos+1] {
			case 'b':
				p.pos += 2
				return p.noQuantifier(&node{kind: kWordB})
			case 'B':
				p.pos += 2
				return p.noQuantifier(&node{kind: kNotWordB})
			}
		}
	case '(':
		for _, look := range []struct {
			open           string
			behind, negate bool
		}{{"(?=", false, false}, {"(?!", false, true}, {"(?<=", true, false}, {"(?<!", true, true}} {
			if !p.peekStr(look.open) {
				continue
			}
			p.pos += len(look.open)
			body, err := p.disjunction()
			if err != nil {
				return nil, err
			}
			if !p.peekIs(')') {
				return nil, p.fail("unterminated group")
			}
			p.pos++
			return p.noQuantifier(&node{kind: kLook, subs: []*node{body}, behind: look.behind, negate: look.negate})
		}
	}
	before := p.ncap
	atom, err := p.atom()
	if err != nil {
		return nil, err
	}
	after := p.ncap
	min, max, greedy, ok, err := p.quantifier()
	if err != nil {
		return nil, err
	}
	if !ok {
		return atom, nil
	}
	return &node{kind: kRepeat, subs: []*node{atom}, min: min, max: max, greedy: greedy, capLo: before + 1, capHi: after + 1}, nil
}

// noQuantifier rejects a quantifier after an assertion. JS rejects it for
// ^, $, \b, \B and lookbehind; Annex B accepts it after a lookahead, which
// the safety patterns never do.
func (p *parser) noQuantifier(n *node) (*node, error) {
	if p.more() {
		switch p.src[p.pos] {
		case '*', '+', '?':
			return nil, p.fail("quantifier after an assertion")
		case '{':
			if _, _, ok := p.braceQuantifier(); ok {
				return nil, p.fail("quantifier after an assertion")
			}
		}
	}
	return n, nil
}

func (p *parser) atom() (*node, error) {
	c := p.src[p.pos]
	switch c {
	case '(':
		if p.peekStr("(?:") {
			p.pos += 3
			body, err := p.disjunction()
			if err != nil {
				return nil, err
			}
			if !p.peekIs(')') {
				return nil, p.fail("unterminated group")
			}
			p.pos++
			return body, nil
		}
		if p.peekStr("(?") {
			return nil, p.fail("unsupported group syntax")
		}
		p.pos++
		p.ncap++
		idx := p.ncap
		body, err := p.disjunction()
		if err != nil {
			return nil, err
		}
		if !p.peekIs(')') {
			return nil, p.fail("unterminated group")
		}
		p.pos++
		return &node{kind: kGroup, subs: []*node{body}, index: idx}, nil
	case ')':
		return nil, p.fail("unmatched ')'")
	case '[':
		return p.class()
	case '.':
		p.pos++
		return &node{kind: kClass, set: dotSet}, nil
	case '*', '+', '?':
		return nil, p.fail("nothing to repeat")
	case '{':
		if _, _, ok := p.braceQuantifier(); ok {
			return nil, p.fail("nothing to repeat")
		}
		// Annex B: a '{' that does not start a quantifier is a literal.
		p.pos++
		return &node{kind: kLit, lit: []uint16{'{'}}, nil
	case '\\':
		p.pos++
		return p.atomEscape()
	}
	// Any other code unit is itself, including ']' and '}' (Annex B).
	p.pos++
	return &node{kind: kLit, lit: []uint16{c}}, nil
}

func (p *parser) atomEscape() (*node, error) {
	if !p.more() {
		return nil, p.fail(`\ at end of pattern`)
	}
	if set := classEscapeSet(p.src[p.pos]); set != nil {
		p.pos++
		return &node{kind: kClass, set: set}, nil
	}
	u, err := p.characterEscape(false)
	if err != nil {
		return nil, err
	}
	return &node{kind: kLit, lit: []uint16{u}}, nil
}

// classEscapeSet is the set of \d \D \s \S \w \W, or nil.
func classEscapeSet(c uint16) *charSet {
	switch c {
	case 'd':
		return digitSet
	case 'D':
		return notDigitSet
	case 's':
		return spaceSet
	case 'S':
		return notSpaceSet
	case 'w':
		return wordSet
	case 'W':
		return notWordSet
	}
	return nil
}

func isHex(u uint16) bool {
	return (u >= '0' && u <= '9') || (u >= 'a' && u <= 'f') || (u >= 'A' && u <= 'F')
}

func hexVal(u uint16) uint16 {
	switch {
	case u >= '0' && u <= '9':
		return u - '0'
	case u >= 'a' && u <= 'f':
		return u - 'a' + 10
	}
	return u - 'A' + 10
}

func isASCIIAlnum(u uint16) bool {
	return (u >= '0' && u <= '9') || (u >= 'a' && u <= 'z') || (u >= 'A' && u <= 'Z')
}

// characterEscape reads the escape after a backslash (p.pos is on the
// character after it) and returns the code unit it stands for.
func (p *parser) characterEscape(inClass bool) (uint16, error) {
	c := p.src[p.pos]
	switch c {
	case 'f':
		p.pos++
		return 0x0C, nil
	case 'n':
		p.pos++
		return 0x0A, nil
	case 'r':
		p.pos++
		return 0x0D, nil
	case 't':
		p.pos++
		return 0x09, nil
	case 'v':
		p.pos++
		return 0x0B, nil
	case 'b':
		if inClass {
			p.pos++
			return 0x08, nil
		}
	case '0':
		if p.pos+1 < len(p.src) && p.src[p.pos+1] >= '0' && p.src[p.pos+1] <= '9' {
			return 0, p.fail("legacy octal escape")
		}
		p.pos++
		return 0, nil
	case 'x':
		if p.pos+2 < len(p.src) && isHex(p.src[p.pos+1]) && isHex(p.src[p.pos+2]) {
			v := hexVal(p.src[p.pos+1])<<4 | hexVal(p.src[p.pos+2])
			p.pos += 3
			return v, nil
		}
		return 0, p.fail(`\x without two hex digits`)
	case 'u':
		if p.pos+4 < len(p.src) && isHex(p.src[p.pos+1]) && isHex(p.src[p.pos+2]) && isHex(p.src[p.pos+3]) && isHex(p.src[p.pos+4]) {
			v := hexVal(p.src[p.pos+1])<<12 | hexVal(p.src[p.pos+2])<<8 | hexVal(p.src[p.pos+3])<<4 | hexVal(p.src[p.pos+4])
			p.pos += 5
			return v, nil
		}
		return 0, p.fail(`\u without four hex digits`)
	case 'c':
		if p.pos+1 < len(p.src) {
			l := p.src[p.pos+1]
			if (l >= 'a' && l <= 'z') || (l >= 'A' && l <= 'Z') {
				p.pos += 2
				return l % 32, nil
			}
		}
		return 0, p.fail(`\c without a control letter`)
	}
	if isASCIIAlnum(c) {
		// \1..\9 (backreference or legacy octal), \k, \p, \P, and identity
		// escapes of letters: none is used, and each is read differently in
		// different modes.
		return 0, p.fail(`unsupported escape \%c`, rune(c))
	}
	// Identity escape of a non-alphanumeric character (\/, \., \-, \', ...).
	p.pos++
	return c, nil
}

// quantifier reads an optional quantifier after an atom.
func (p *parser) quantifier() (min, max int, greedy, ok bool, err error) {
	if !p.more() {
		return 0, 0, false, false, nil
	}
	switch p.src[p.pos] {
	case '*':
		p.pos++
		min, max = 0, -1
	case '+':
		p.pos++
		min, max = 1, -1
	case '?':
		p.pos++
		min, max = 0, 1
	case '{':
		var q bool
		min, max, q = p.braceQuantifier()
		if !q {
			return 0, 0, false, false, nil
		}
		// skip the brace quantifier text
		for p.src[p.pos] != '}' {
			p.pos++
		}
		p.pos++
		if max >= 0 && min > max {
			return 0, 0, false, false, p.fail("numbers out of order in {} quantifier")
		}
	default:
		return 0, 0, false, false, nil
	}
	greedy = true
	if p.peekIs('?') {
		p.pos++
		greedy = false
	}
	return min, max, greedy, true, nil
}

// braceQuantifier reports whether a {n}, {n,} or {n,m} quantifier starts at
// p.pos, without consuming it. Counts saturate at 1<<30.
func (p *parser) braceQuantifier() (min, max int, ok bool) {
	i := p.pos + 1
	readInt := func() (int, bool) {
		start := i
		v := 0
		for i < len(p.src) && p.src[i] >= '0' && p.src[i] <= '9' {
			if v < 1<<30 {
				v = v*10 + int(p.src[i]-'0')
			}
			i++
		}
		if v > 1<<30 {
			v = 1 << 30
		}
		return v, i > start
	}
	min, ok = readInt()
	if !ok || i >= len(p.src) {
		return 0, 0, false
	}
	switch p.src[i] {
	case '}':
		return min, min, true
	case ',':
		i++
		if i < len(p.src) && p.src[i] == '}' {
			return min, -1, true
		}
		max, ok = readInt()
		if !ok || i >= len(p.src) || p.src[i] != '}' {
			return 0, 0, false
		}
		return min, max, true
	}
	return 0, 0, false
}

// class parses [...] with Annex B semantics for a class escape in a range
// ([\w-x] is \w, '-' and 'x').
func (p *parser) class() (*node, error) {
	p.pos++ // '['
	negate := false
	if p.peekIs('^') {
		negate = true
		p.pos++
	}
	b := &setBuilder{}
	for {
		if !p.more() {
			return nil, p.fail("unterminated character class")
		}
		if p.peekIs(']') {
			p.pos++
			break
		}
		a, aSet, err := p.classAtom()
		if err != nil {
			return nil, err
		}
		if p.peekIs('-') && p.pos+1 < len(p.src) && p.src[p.pos+1] != ']' {
			p.pos++ // '-'
			z, zSet, err := p.classAtom()
			if err != nil {
				return nil, err
			}
			if aSet != nil || zSet != nil {
				b.addAtom(a, aSet)
				b.addRange('-', '-')
				b.addAtom(z, zSet)
				continue
			}
			if a > z {
				return nil, p.fail("range out of order in character class")
			}
			b.addRange(a, z)
			continue
		}
		b.addAtom(a, aSet)
	}
	return &node{kind: kClass, set: b.build(negate)}, nil
}

func (p *parser) classAtom() (uint16, *charSet, error) {
	c := p.src[p.pos]
	if c != '\\' {
		p.pos++
		return c, nil, nil
	}
	p.pos++
	if !p.more() {
		return 0, nil, p.fail(`\ at end of pattern`)
	}
	if set := classEscapeSet(p.src[p.pos]); set != nil {
		p.pos++
		return 0, set, nil
	}
	if p.src[p.pos] == '-' {
		p.pos++
		return '-', nil, nil
	}
	u, err := p.characterEscape(true)
	return u, nil, err
}

/* ------------------------------------------------------------ char sets */

// urange is an inclusive range of code units.
type urange struct{ lo, hi uint16 }

// charSet is a set of UTF-16 code units: a bitmap for ASCII and sorted,
// disjoint ranges for the rest.
type charSet struct {
	ascii  [2]uint64
	ranges []urange // only units >= 0x80
}

func (s *charSet) has(u uint16) bool {
	if u < 0x80 {
		return s.ascii[u>>6]&(1<<(u&63)) != 0
	}
	// binary search for the first range with hi >= u
	rs := s.ranges
	lo, hi := 0, len(rs)
	for lo < hi {
		mid := int(uint(lo+hi) >> 1)
		if rs[mid].hi < u {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	return lo < len(rs) && rs[lo].lo <= u
}

type setBuilder struct{ rs []urange }

func (b *setBuilder) addRange(lo, hi uint16) { b.rs = append(b.rs, urange{lo, hi}) }

func (b *setBuilder) addAtom(u uint16, set *charSet) {
	if set == nil {
		b.addRange(u, u)
		return
	}
	b.rs = append(b.rs, set.toRanges()...)
}

// normalize sorts and merges ranges.
func normalizeRanges(rs []urange) []urange {
	rs = append([]urange(nil), rs...)
	sort.Slice(rs, func(i, j int) bool { return rs[i].lo < rs[j].lo })
	var out []urange
	for _, r := range rs {
		if n := len(out); n > 0 && uint32(r.lo) <= uint32(out[n-1].hi)+1 {
			if r.hi > out[n-1].hi {
				out[n-1].hi = r.hi
			}
			continue
		}
		out = append(out, r)
	}
	return out
}

func complementRanges(rs []urange) []urange {
	rs = normalizeRanges(rs)
	var out []urange
	next := uint32(0)
	for _, r := range rs {
		if uint32(r.lo) > next {
			out = append(out, urange{uint16(next), r.lo - 1})
		}
		next = uint32(r.hi) + 1
	}
	if next <= 0xFFFF {
		out = append(out, urange{uint16(next), 0xFFFF})
	}
	return out
}

func (b *setBuilder) build(negate bool) *charSet {
	rs := normalizeRanges(b.rs)
	if negate {
		rs = complementRanges(rs)
	}
	return fromRanges(rs)
}

func fromRanges(rs []urange) *charSet {
	s := &charSet{}
	for _, r := range normalizeRanges(rs) {
		for u := uint32(r.lo); u <= uint32(r.hi) && u < 0x80; u++ {
			s.ascii[u>>6] |= 1 << (u & 63)
		}
		if r.hi >= 0x80 {
			lo := r.lo
			if lo < 0x80 {
				lo = 0x80
			}
			s.ranges = append(s.ranges, urange{lo, r.hi})
		}
	}
	return s
}

func (s *charSet) toRanges() []urange {
	var out []urange
	for u := uint16(0); u < 0x80; u++ {
		if s.has(u) {
			out = append(out, urange{u, u})
		}
	}
	return normalizeRanges(append(out, s.ranges...))
}

func setOf(rs ...urange) *charSet { return fromRanges(rs) }

var (
	digitSet = setOf(urange{'0', '9'})
	wordSet  = setOf(urange{'0', '9'}, urange{'A', 'Z'}, urange{'_', '_'}, urange{'a', 'z'})
	// spaceSet is JS \s: WhiteSpace (TAB, VT, FF, ZWNBSP, Zs) and
	// LineTerminator (LF, CR, LS, PS). It is not unicode.IsSpace: U+0085 is
	// not in it and U+FEFF is.
	spaceSet = setOf(urange{0x09, 0x0D}, urange{0x20, 0x20}, urange{0xA0, 0xA0}, urange{0x1680, 0x1680},
		urange{0x2000, 0x200A}, urange{0x2028, 0x2029}, urange{0x202F, 0x202F}, urange{0x205F, 0x205F},
		urange{0x3000, 0x3000}, urange{0xFEFF, 0xFEFF})
	notDigitSet = fromRanges(complementRanges(digitSet.toRanges()))
	notWordSet  = fromRanges(complementRanges(wordSet.toRanges()))
	notSpaceSet = fromRanges(complementRanges(spaceSet.toRanges()))
	// dotSet is `.` without the s flag: anything but a LineTerminator.
	dotSet = fromRanges(complementRanges([]urange{{0x0A, 0x0A}, {0x0D, 0x0D}, {0x2028, 0x2029}}))
)
