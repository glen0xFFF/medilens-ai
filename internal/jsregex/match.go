package jsregex

// The matcher follows ECMA-262 §22.2.2 (Pattern Semantics) for a RegExp
// without flags: a backtracking matcher in continuation-passing style, with
// a direction. Lookbehind bodies are compiled backward (terms right to left,
// each atom consuming the code unit before the position), exactly as the
// spec evaluates them, so captures and greedy choices inside a lookbehind
// come out as in V8.
//
// Contract: run returns true when the continuation accepted. When it returns
// false, the captures are as they were on entry.

// inst is a node compiled for one direction.
type inst struct {
	kind   kind
	fwd    bool
	lit    []uint16
	set    *charSet
	subs   []*inst // kSeq in matching order; kAlt in order
	sub    *inst   // kGroup, kRepeat, kLook
	index  int
	min    int
	max    int
	greedy bool
	capLo  int
	capHi  int
	negate bool
	// single: a kRepeat whose atom matches exactly one code unit and has no
	// captures, matched by a loop instead of the recursive RepeatMatcher.
	single bool
	// hasCaps: a kLook whose body contains a capturing group.
	hasCaps bool
	// first and nullable describe what the inst can consume first in its
	// direction; an alternative that cannot start with the next code unit
	// is skipped (it would fail anyway).
	first    firstSet
	nullable bool
	// det: matches in at most one way and needs no continuation (a literal,
	// a class or a zero-width check), so a sequence steps over it in a loop.
	det bool
}

// firstSet is a set of code units below 256 plus "any unit >= 256".
type firstSet struct {
	lo [4]uint64
	hi bool
}

func (f *firstSet) add(u uint16) {
	if u < 256 {
		f.lo[u>>6] |= 1 << (u & 63)
	} else {
		f.hi = true
	}
}

func (f *firstSet) union(g firstSet) {
	for i := range f.lo {
		f.lo[i] |= g.lo[i]
	}
	f.hi = f.hi || g.hi
}

func (f *firstSet) has(c int) bool {
	if c < 0 {
		return false
	}
	if c < 256 {
		return f.lo[c>>6]&(1<<(uint(c)&63)) != 0
	}
	return f.hi
}

func (n *inst) canStart(c int) bool { return n.nullable || n.first.has(c) }

func setFirst(s *charSet) firstSet {
	var f firstSet
	for u := uint16(0); u < 256; u++ {
		if s.has(u) {
			f.add(u)
		}
	}
	for _, r := range s.ranges {
		if r.hi >= 256 {
			f.hi = true
			break
		}
	}
	return f
}

func hasGroup(n *node) bool {
	if n.kind == kGroup {
		return true
	}
	for _, s := range n.subs {
		if hasGroup(s) {
			return true
		}
	}
	return false
}

// compile builds the inst tree for direction fwd.
func compile(n *node, fwd bool) *inst {
	c := &inst{kind: n.kind, fwd: fwd, lit: n.lit, set: n.set, index: n.index,
		min: n.min, max: n.max, greedy: n.greedy, capLo: n.capLo, capHi: n.capHi, negate: n.negate}
	switch n.kind {
	case kEmpty:
		c.nullable, c.det = true, true
	case kLit:
		if fwd {
			c.first.add(n.lit[0])
		} else {
			c.first.add(n.lit[len(n.lit)-1])
		}
		c.det = true
	case kClass:
		c.first = setFirst(n.set)
		c.det = true
	case kBOL, kEOL, kWordB, kNotWordB:
		c.nullable, c.det = true, true
	case kSeq:
		c.subs = make([]*inst, len(n.subs))
		for i, s := range n.subs {
			j := i
			if !fwd {
				j = len(n.subs) - 1 - i
			}
			c.subs[j] = compile(s, fwd)
		}
		c.nullable = true
		for _, s := range c.subs {
			c.first.union(s.first)
			if !s.nullable {
				c.nullable = false
				break
			}
		}
	case kAlt:
		for _, s := range n.subs {
			a := compile(s, fwd)
			c.subs = append(c.subs, a)
			c.first.union(a.first)
			c.nullable = c.nullable || a.nullable
		}
	case kGroup:
		c.sub = compile(n.subs[0], fwd)
		c.first, c.nullable = c.sub.first, c.sub.nullable
	case kRepeat:
		c.sub = compile(n.subs[0], fwd)
		c.first = c.sub.first
		c.nullable = n.min == 0 || c.sub.nullable
		c.single = (c.sub.kind == kClass || (c.sub.kind == kLit && len(c.sub.lit) == 1)) && n.capHi == n.capLo
	case kLook:
		// A lookahead body runs forward and a lookbehind body backward,
		// whatever the direction around it.
		c.sub = compile(n.subs[0], !n.behind)
		c.hasCaps = hasGroup(n.subs[0])
		c.nullable = true
	}
	return c
}

// startsWithBOL reports whether every match must begin with ^, so only
// position 0 can match (there is no m flag).
func startsWithBOL(n *inst) bool {
	switch n.kind {
	case kBOL:
		return true
	case kSeq:
		return len(n.subs) > 0 && startsWithBOL(n.subs[0])
	case kGroup:
		return startsWithBOL(n.sub)
	case kAlt:
		for _, s := range n.subs {
			if !startsWithBOL(s) {
				return false
			}
		}
		return len(n.subs) > 0
	}
	return false
}

type machine struct {
	in   []uint16
	caps []int // 2 per group, group 0 included; -1 is undefined
}

type cont func(int) bool

func accept(int) bool { return true }

// isWord is IsWordChar without the u and i flags: ASCII [A-Za-z0-9_].
func (m *machine) isWord(i int) bool {
	if i < 0 || i >= len(m.in) {
		return false
	}
	u := m.in[i]
	return (u >= 'a' && u <= 'z') || (u >= 'A' && u <= 'Z') || (u >= '0' && u <= '9') || u == '_'
}

// peek is the code unit an inst in direction fwd would consume next, or -1.
func (m *machine) peek(fwd bool, pos int) int {
	if fwd {
		if pos < len(m.in) {
			return int(m.in[pos])
		}
		return -1
	}
	if pos > 0 {
		return int(m.in[pos-1])
	}
	return -1
}

// step matches a det inst at pos and returns the new position.
func (m *machine) step(n *inst, pos int) (int, bool) {
	switch n.kind {
	case kEmpty:
		return pos, true
	case kLit:
		l := len(n.lit)
		if n.fwd {
			if pos+l > len(m.in) {
				return 0, false
			}
			for i, u := range n.lit {
				if m.in[pos+i] != u {
					return 0, false
				}
			}
			return pos + l, true
		}
		if pos-l < 0 {
			return 0, false
		}
		for i, u := range n.lit {
			if m.in[pos-l+i] != u {
				return 0, false
			}
		}
		return pos - l, true
	case kClass:
		if n.fwd {
			if pos >= len(m.in) || !n.set.has(m.in[pos]) {
				return 0, false
			}
			return pos + 1, true
		}
		if pos <= 0 || !n.set.has(m.in[pos-1]) {
			return 0, false
		}
		return pos - 1, true
	case kBOL:
		return pos, pos == 0
	case kEOL:
		return pos, pos == len(m.in)
	case kWordB:
		return pos, m.isWord(pos-1) != m.isWord(pos)
	case kNotWordB:
		return pos, m.isWord(pos-1) == m.isWord(pos)
	}
	panic("jsregex: step on a non-deterministic inst")
}

func (m *machine) run(n *inst, pos int, k cont) bool {
	if n.det {
		p, ok := m.step(n, pos)
		return ok && k(p)
	}
	switch n.kind {
	case kSeq:
		return m.seq(n, 0, pos, k)
	case kAlt:
		c := m.peek(n.fwd, pos)
		for _, a := range n.subs {
			if a.canStart(c) && m.run(a, pos, k) {
				return true
			}
		}
		return false
	case kGroup:
		i := 2 * n.index
		return m.run(n.sub, pos, func(p int) bool {
			s, e := m.caps[i], m.caps[i+1]
			if n.fwd {
				m.caps[i], m.caps[i+1] = pos, p
			} else {
				m.caps[i], m.caps[i+1] = p, pos
			}
			if k(p) {
				return true
			}
			m.caps[i], m.caps[i+1] = s, e
			return false
		})
	case kRepeat:
		if n.single {
			return m.repeatSingle(n, pos, k)
		}
		return m.repeat(n, pos, n.min, n.max, k)
	case kLook:
		var saved []int
		if n.hasCaps {
			saved = append([]int(nil), m.caps...)
		}
		ok := m.run(n.sub, pos, accept)
		if n.negate {
			if ok {
				if saved != nil {
					copy(m.caps, saved)
				}
				return false
			}
			return k(pos)
		}
		// Positive: the body's captures stand; the assertion is atomic.
		if ok && k(pos) {
			return true
		}
		if saved != nil {
			copy(m.caps, saved)
		}
		return false
	}
	panic("jsregex: unknown inst kind")
}

// seq runs the terms from i on. Deterministic terms are stepped in a loop.
func (m *machine) seq(n *inst, i, pos int, k cont) bool {
	for i < len(n.subs) && n.subs[i].det {
		p, ok := m.step(n.subs[i], pos)
		if !ok {
			return false
		}
		pos = p
		i++
	}
	switch {
	case i == len(n.subs):
		return k(pos)
	case i == len(n.subs)-1:
		return m.run(n.subs[i], pos, k)
	}
	return m.run(n.subs[i], pos, func(p int) bool { return m.seq(n, i+1, p, k) })
}

// repeat is RepeatMatcher (ECMA-262 §22.2.2.3.1): the empty-iteration
// check, and the atom's captures reset before each iteration.
func (m *machine) repeat(n *inst, x, min, max int, k cont) bool {
	if max == 0 {
		return k(x)
	}
	d := func(y int) bool {
		if min == 0 && y == x {
			return false
		}
		nmin, nmax := min, max
		if nmin > 0 {
			nmin--
		}
		if nmax > 0 {
			nmax--
		}
		return m.repeat(n, y, nmin, nmax, k)
	}
	lo, hi := 2*n.capLo, 2*n.capHi
	var saved []int
	if hi > lo {
		saved = append([]int(nil), m.caps[lo:hi]...)
	}
	reset := func() {
		for i := lo; i < hi; i++ {
			m.caps[i] = -1
		}
	}
	restore := func() { copy(m.caps[lo:hi], saved) }
	if min != 0 {
		reset()
		if m.run(n.sub, x, d) {
			return true
		}
		restore()
		return false
	}
	if !n.greedy {
		if k(x) {
			return true
		}
		reset()
		if m.run(n.sub, x, d) {
			return true
		}
		restore()
		return false
	}
	reset()
	if m.run(n.sub, x, d) {
		return true
	}
	restore()
	return k(x)
}

// repeatSingle is repeat for an atom that matches exactly one code unit and
// has no captures: every iteration consumes one unit, so the empty check
// never fires, and the order of attempts (longest first when greedy,
// shortest first when lazy) is the RepeatMatcher order.
func (m *machine) repeatSingle(n *inst, pos int, k cont) bool {
	dir := 1
	if !n.fwd {
		dir = -1
	}
	if n.greedy {
		cnt, p := 0, pos
		for n.max < 0 || cnt < n.max {
			q, ok := m.step(n.sub, p)
			if !ok {
				break
			}
			p = q
			cnt++
		}
		for ; cnt >= n.min; cnt-- {
			if k(pos + dir*cnt) {
				return true
			}
		}
		return false
	}
	cnt, p := 0, pos
	for cnt < n.min {
		q, ok := m.step(n.sub, p)
		if !ok {
			return false
		}
		p = q
		cnt++
	}
	for {
		if k(p) {
			return true
		}
		if n.max >= 0 && cnt >= n.max {
			return false
		}
		q, ok := m.step(n.sub, p)
		if !ok {
			return false
		}
		p = q
		cnt++
	}
}
