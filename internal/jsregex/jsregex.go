// Package jsregex matches JavaScript regular expressions with ECMAScript
// semantics (ECMA-262 §22.2), for the flagless (non-unicode) patterns the
// Node build's safety gate uses. Go's regexp (RE2) has no lookahead or
// lookbehind, and the safety patterns lean on both, nested and with lazy
// quantifiers, so the Go port re-expresses them by running the same pattern
// text through this matcher instead of hand-translating each one.
//
// What it implements, as V8 does for a RegExp with no flags:
//   - the input and the pattern are UTF-16 code units (`.` and `[^x]` match
//     half of an astral character; `{n}` counts units);
//   - backtracking in spec order: alternatives left to right, greedy and
//     lazy quantifiers, the RepeatMatcher empty-iteration check and capture
//     reset, atomic lookaround, lookbehind matched right to left;
//   - \b, \B, \w, \d are ASCII; \s is the JS WhiteSpace+LineTerminator set;
//     `.` excludes LF, CR, U+2028 and U+2029; ^ and $ are input start/end;
//   - Annex B syntax the patterns use: a '{' that is not a quantifier, a
//     ']' or '}' outside a class, identity escapes of punctuation, and a
//     class escape inside a range ([\w-]).
//
// It refuses (SyntaxError) flags, backreferences, named groups, modifiers,
// quantified lookarounds and identity escapes of letters or digits, so no
// pattern is silently read differently from V8. Matching has no step limit,
// as in V8; callers bound the input length (the safety gate refuses
// questions over 300 code units before any pattern runs).
package jsregex

import "unicode/utf16"

// Regexp is a compiled pattern. It is safe for concurrent use.
type Regexp struct {
	source string
	prog   *inst
	ncap   int
	bol    bool
}

// Compile parses a JS RegExp source (the text between the slashes of a
// literal, or the string given to new RegExp) with no flags.
func Compile(source string) (*Regexp, error) {
	n, ncap, err := parse(source)
	if err != nil {
		return nil, err
	}
	prog := compile(n, true)
	return &Regexp{source: source, prog: prog, ncap: ncap, bol: startsWithBOL(prog)}, nil
}

// MustCompile is Compile that panics on an error, for package-level patterns.
func MustCompile(source string) *Regexp {
	re, err := Compile(source)
	if err != nil {
		panic(err)
	}
	return re
}

// Source returns the pattern text as given to Compile.
func (re *Regexp) Source() string { return re.source }

// Input is a string as UTF-16 code units, so one text can be matched
// against many patterns without converting it each time.
type Input struct{ u []uint16 }

// NewInput converts s (invalid UTF-8 becomes U+FFFD, as a Go string
// decoded from JSON would be).
func NewInput(s string) Input { return Input{utf16.Encode([]rune(s))} }

// Len is the length in UTF-16 code units, JS `length`.
func (in Input) Len() int { return len(in.u) }

// Len is the JS `length` of s: its length in UTF-16 code units.
func Len(s string) int {
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

// Match is a successful Exec: the start of the match and its captures.
type Match struct {
	Index int // code-unit offset of the match, JS `index`
	in    []uint16
	caps  []int
}

// NumGroups is the length of the JS match array: 1 + the capture count.
func (m *Match) NumGroups() int { return len(m.caps) / 2 }

// Group returns capture i (0 is the whole match) and whether it
// participated; a group that did not is JS undefined.
func (m *Match) Group(i int) (string, bool) {
	s, e := m.caps[2*i], m.caps[2*i+1]
	if s < 0 {
		return "", false
	}
	return string(utf16.Decode(m.in[s:e])), true
}

// exec is RegExpBuiltinExec with lastIndex 0 and no g or y flag: try each
// start position from 0 to the length, the first match wins.
func (re *Regexp) exec(in []uint16) []int {
	m := &machine{in: in, caps: make([]int, 2*(re.ncap+1))}
	end := -1
	found := func(p int) bool { end = p; return true }
	for start := 0; start <= len(in); start++ {
		if re.bol && start > 0 {
			break
		}
		c := -1
		if start < len(in) {
			c = int(in[start])
		}
		if !re.prog.canStart(c) {
			continue
		}
		for i := range m.caps {
			m.caps[i] = -1
		}
		if m.run(re.prog, start, found) {
			m.caps[0], m.caps[1] = start, end
			return m.caps
		}
	}
	return nil
}

// Test is RegExp.prototype.test.
func (re *Regexp) Test(s string) bool { return re.exec(NewInput(s).u) != nil }

// TestInput is Test on a converted input.
func (re *Regexp) TestInput(in Input) bool { return re.exec(in.u) != nil }

// Exec is RegExp.prototype.exec: nil when there is no match.
func (re *Regexp) Exec(s string) *Match { return re.ExecInput(NewInput(s)) }

// ExecInput is Exec on a converted input.
func (re *Regexp) ExecInput(in Input) *Match {
	caps := re.exec(in.u)
	if caps == nil {
		return nil
	}
	return &Match{Index: caps[0], in: in.u, caps: caps}
}
