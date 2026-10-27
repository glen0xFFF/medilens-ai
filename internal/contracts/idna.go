package contracts

import (
	"slices"
	"strings"
	"unicode/utf8"
)

// The WHATWG URL "domain to ASCII" (beStrict false), as the reference build
// runs it. Node v24.21.0's URL parser is ada 4.0.0 (process.versions.ada),
// and this ports its ada::idna::to_ascii (src/to_ascii.cpp, src/validity.cpp,
// src/punycode.cpp, src/mapping.cpp and src/normalization.cpp of ada v4.0.0)
// step by step, over ada's own tables (ada_tables.go). Where ada departs from
// the letter of UTS #46 the port follows ada, because zod's z.httpUrl()
// checks the hostname that ada gives:
//
//   - an all-ASCII domain is only ASCII-lowercased: its xn-- labels are never
//     decoded or validated (zod's domain pattern still applies to them);
//   - in a non-ASCII domain, an xn-- label must decode to a non-ASCII label
//     that the mapping and NFC leave unchanged and that isLabelValid accepts,
//     while any other ASCII label is copied unchecked;
//   - NFC is skipped when ada's quick check calls the string NFC, which it
//     can do wrongly (adaIDNATables.isAlreadyNFC);
//   - isLabelValid checks the Bidi rule label by label, and only on a label
//     that holds an R, AL or AN character; its ContextJ check is ada's
//     simplified rule over ada's own joining-type lists.
//
// Checked against Node on fixtures/parity/providers/httpurl*.jsonl and on
// every code point (TestParseHTTPURLMatchesZodOnEveryCodePoint).

// adaMaxDomainInputBytes is ada::idna::max_domain_input_bytes: to_ascii
// refuses a longer (percent-decoded) domain before anything else.
const adaMaxDomainInputBytes = 16384

// domainToASCII is ada::idna::to_ascii followed by ada's empty-result
// check: the ASCII domain, or false where ada fails.
func domainToASCII(domain string) (string, bool) {
	if len(domain) > adaMaxDomainInputBytes {
		return "", false
	}
	if isASCII(domain) {
		out := asciiLower(domain)
		return out, out != ""
	}
	t := adaTables()
	// ada converts UTF-8 to UTF-32 first and fails on invalid UTF-8
	if t == nil || !utf8.ValidString(domain) {
		return "", false
	}
	mapped, ok := t.mapRunes([]rune(domain))
	if !ok {
		return "", false
	}
	if !runesASCII(mapped) && !t.isAlreadyNFC(mapped) {
		mapped = t.normalize(mapped)
	}
	var out strings.Builder
	for i, label := range splitRunes(mapped, '.') {
		if i > 0 {
			out.WriteByte('.')
		}
		switch {
		case len(label) == 0:
		case isACEPrefix(label):
			if !runesASCII(label) || !t.validACELabel(string(label[len("xn--"):])) {
				return "", false
			}
			out.WriteString(string(label))
		case runesASCII(label):
			out.WriteString(string(label))
		default:
			if !t.isLabelValid(label) {
				return "", false
			}
			encoded, ok := punycodeEncode(label)
			if !ok {
				return "", false
			}
			out.WriteString("xn--" + encoded)
		}
	}
	return out.String(), out.Len() > 0
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

func runesASCII(s []rune) bool {
	for _, r := range s {
		if r < 0 || r >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// asciiLower is ada's ascii_map: A-Z to a-z, every other byte unchanged.
func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + ('a' - 'A')
		}
		return r
	}, s)
}

// splitRunes splits s at every sep, as ada walks the labels.
func splitRunes(s []rune, sep rune) [][]rune {
	var labels [][]rune
	start := 0
	for i, r := range s {
		if r == sep {
			labels = append(labels, s[start:i])
			start = i + 1
		}
	}
	return append(labels, s[start:])
}

// isACEPrefix is ada's is_ace_prefix on a mapped (so lowercased) label.
func isACEPrefix(label []rune) bool {
	return len(label) >= 4 && label[0] == 'x' && label[1] == 'n' && label[2] == '-' && label[3] == '-'
}

// validACELabel is ada's check of an xn-- label in a non-ASCII domain;
// puny is the label without its xn-- prefix.
func (t *adaIDNATables) validACELabel(puny string) bool {
	working, ok := punycodeDecode(puny)
	// a label that decodes to ASCII only (or to nothing) should never have
	// been encoded (whatwg/url#760)
	if !ok || runesASCII(working) {
		return false
	}
	// the mapping must leave the label unchanged, and so must NFC
	postMap, ok := t.mapRunes(working)
	if !ok || !slices.Equal(working, postMap) {
		return false
	}
	if !runesASCII(postMap) && !t.isAlreadyNFC(postMap) {
		if !slices.Equal(t.normalize(postMap), working) {
			return false
		}
	}
	return len(postMap) > 0 && t.isLabelValid(postMap)
}

// isLabelValid is ada::idna::is_label_valid (src/validity.cpp), with its
// early returns: the ContextJ check returns at the first joiner, before the
// Bidi rule is looked at.
func (t *adaIDNATables) isLabelValid(label []rune) bool {
	if len(label) == 0 {
		return true
	}
	// the label must not begin with a combining mark
	if t.isCombiningMark(label[0]) {
		return false
	}
	// CheckJoiners: ada's simplified ContextJ rule
	for i, c := range label {
		switch c {
		case 0x200C: // ZERO WIDTH NON-JOINER
			if i > 0 && inSorted(adaVirama, label[i-1]) {
				return true
			}
			if i == 0 || i+1 >= len(label) {
				return false
			}
			return slices.ContainsFunc(label[:i], isJoiningLOrD) &&
				slices.ContainsFunc(label[i+1:], isJoiningROrD)
		case 0x200D: // ZERO WIDTH JOINER
			return i > 0 && inSorted(adaVirama, label[i-1])
		}
	}
	// CheckBidi: RFC 5893 section 2, on an RTL label only
	last := len(label) - 1
	for last >= 0 && t.direction(label[last]) == adaNSM {
		last--
	}
	if last < 0 {
		return false
	}
	if !slices.ContainsFunc(label, func(r rune) bool {
		d := t.direction(r)
		return d == adaR || d == adaAL || d == adaAN
	}) {
		return true
	}
	if t.direction(label[0]) == adaL {
		// evaluated as an LTR label (rules 5 and 6)
		for _, r := range label[:last+1] {
			switch t.direction(r) {
			case adaL, adaEN, adaES, adaCS, adaET, adaON, adaBN, adaNSM:
			default:
				return false
			}
		}
		d := t.direction(label[last])
		return d == adaL || d == adaEN
	}
	// evaluated as an RTL label (rules 1 to 4)
	if first := t.direction(label[0]); first != adaR && first != adaAL {
		return false
	}
	hasAN, hasEN := false, false
	for i, r := range label[:last+1] {
		d := t.direction(r)
		switch d {
		case adaEN:
			hasEN = true
			if hasAN {
				return false
			}
		case adaAN:
			hasAN = true
			if hasEN {
				return false
			}
		}
		switch d {
		case adaR, adaAL, adaAN, adaEN, adaES, adaCS, adaET, adaON, adaBN, adaNSM:
		default:
			return false
		}
		if i == last && d != adaR && d != adaAL && d != adaAN && d != adaEN {
			return false
		}
	}
	return true
}

func inSorted(table []rune, r rune) bool {
	_, found := slices.BinarySearch(table, r)
	return found
}

func isJoiningLOrD(r rune) bool { return inSorted(adaJoiningL, r) || inSorted(adaJoiningD, r) }

func isJoiningROrD(r rune) bool { return inSorted(adaJoiningR, r) || inSorted(adaJoiningD, r) }

// Punycode (RFC 3492) as ada implements it, with its overflow checks.
const (
	punyBase        = 36
	punyTMin        = 1
	punyTMax        = 26
	punySkew        = 38
	punyDamp        = 700
	punyInitialBias = 72
	punyInitialN    = 128
	punyMaxInt      = 0x7fffffff
)

// punyDigit is ada's char_to_digit_value: lowercase letters and digits only.
func punyDigit(c byte) int64 {
	switch {
	case c >= 'a' && c <= 'z':
		return int64(c - 'a')
	case c >= '0' && c <= '9':
		return int64(c-'0') + 26
	}
	return -1
}

func punyDigitChar(d int64) byte {
	if d < 26 {
		return byte(d + 'a')
	}
	return byte(d - 26 + '0')
}

func punyAdapt(d, n int64, first bool) int64 {
	if first {
		d /= punyDamp
	} else {
		d /= 2
	}
	d += d / n
	k := int64(0)
	for d > ((punyBase-punyTMin)*punyTMax)/2 {
		d /= punyBase - punyTMin
		k += punyBase
	}
	return k + ((punyBase-punyTMin+1)*d)/(d+punySkew)
}

func punyThreshold(k, bias int64) int64 {
	switch {
	case k <= bias:
		return punyTMin
	case k >= bias+punyTMax:
		return punyTMax
	}
	return k - bias
}

// punycodeDecode is ada's punycode_to_utf32. The decoded values are not
// range-checked here, as in ada; validACELabel rejects the invalid ones.
func punycodeDecode(input string) ([]rune, bool) {
	var out []rune
	n, i, bias := int64(punyInitialN), int64(0), int64(punyInitialBias)
	if end := strings.LastIndexByte(input, '-'); end >= 0 {
		for j := 0; j < end; j++ {
			if input[j] >= utf8.RuneSelf {
				return nil, false
			}
			out = append(out, rune(input[j]))
		}
		input = input[end+1:]
	}
	for input != "" {
		oldi, w := i, int64(1)
		for k := int64(punyBase); ; k += punyBase {
			if input == "" {
				return nil, false
			}
			digit := punyDigit(input[0])
			input = input[1:]
			if digit < 0 || digit > (punyMaxInt-i)/w {
				return nil, false
			}
			i += digit * w
			t := punyThreshold(k, bias)
			if digit < t {
				break
			}
			if w > punyMaxInt/(punyBase-t) {
				return nil, false
			}
			w *= punyBase - t
		}
		written := int64(len(out)) + 1
		bias = punyAdapt(i-oldi, written, oldi == 0)
		if i/written > punyMaxInt-n {
			return nil, false
		}
		n += i / written
		i %= written
		if n < 0x80 {
			return nil, false
		}
		out = slices.Insert(out, int(i), rune(n))
		i++
	}
	// a label that decodes to one starting with xn-- is double-encoded
	// (whatwg/url#803)
	if len(out) >= 4 && string(out[:4]) == "xn--" {
		return nil, false
	}
	return out, true
}

// punycodeEncode is ada's utf32_to_punycode.
func punycodeEncode(input []rune) (string, bool) {
	var out []byte
	h := int64(0)
	for _, c := range input {
		if c < 0x80 {
			h++
			out = append(out, byte(c))
		}
		if c > 0x10FFFF || (c >= 0xD800 && c < 0xE000) {
			return "", false
		}
	}
	b := h
	if b > 0 {
		out = append(out, '-')
	}
	n, d, bias := int64(punyInitialN), int64(0), int64(punyInitialBias)
	for h < int64(len(input)) {
		m := int64(0x10FFFF)
		for _, c := range input {
			if int64(c) >= n && int64(c) < m {
				m = int64(c)
			}
		}
		if (m - n) > (punyMaxInt-d)/(h+1) {
			return "", false
		}
		d += (m - n) * (h + 1)
		n = m
		for _, c := range input {
			if int64(c) < n {
				if d == punyMaxInt {
					return "", false
				}
				d++
			}
			if int64(c) == n {
				q := d
				for k := int64(punyBase); ; k += punyBase {
					t := punyThreshold(k, bias)
					if q < t {
						break
					}
					out = append(out, punyDigitChar(t+(q-t)%(punyBase-t)))
					q = (q - t) / (punyBase - t)
				}
				out = append(out, punyDigitChar(q))
				bias = punyAdapt(d, h+1, h == b)
				d = 0
				h++
			}
		}
		d++
		n++
	}
	return string(out), true
}

// ada's ContextJ tables (src/validity.cpp of ada v4.0.0), sorted: the
// viramas, and the code points ada treats as joining type R, L and D.
var adaVirama = []rune{
	0x94D, 0x9CD, 0xA4D, 0xACD, 0xB4D, 0xBCD, 0xC4D, 0xCCD,
	0xD3B, 0xD3C, 0xD4D, 0xDCA, 0xE3A, 0xEBA, 0xF84, 0x1039,
	0x103A, 0x1714, 0x1734, 0x17D2, 0x1A60, 0x1B44, 0x1BAA, 0x1BAB,
	0x1BF2, 0x1BF3, 0x2D7F, 0xA806, 0xA82C, 0xA8C4, 0xA953, 0xA9C0,
	0xAAF6, 0xABED, 0x10A3F, 0x11046, 0x1107F, 0x110B9, 0x11133, 0x11134,
	0x111C0, 0x11235, 0x112EA, 0x1134D, 0x11442, 0x114C2, 0x115BF, 0x1163F,
	0x116B6, 0x1172B, 0x11839, 0x1193D, 0x1193E, 0x119E0, 0x11A34, 0x11A47,
	0x11A99, 0x11C3F, 0x11D44, 0x11D45, 0x11D97,
}

var adaJoiningR = []rune{
	0x622, 0x623, 0x624, 0x625, 0x627, 0x629, 0x62F, 0x630,
	0x631, 0x632, 0x648, 0x671, 0x672, 0x673, 0x675, 0x676,
	0x677, 0x688, 0x689, 0x68A, 0x68B, 0x68C, 0x68D, 0x68E,
	0x68F, 0x690, 0x691, 0x692, 0x693, 0x694, 0x695, 0x696,
	0x697, 0x698, 0x699, 0x6C0, 0x6C3, 0x6C4, 0x6C5, 0x6C6,
	0x6C7, 0x6C8, 0x6C9, 0x6CA, 0x6CB, 0x6CD, 0x6CF, 0x6D2,
	0x6D3, 0x6D5, 0x6EE, 0x6EF, 0x710, 0x715, 0x716, 0x717,
	0x718, 0x719, 0x71E, 0x728, 0x72A, 0x72C, 0x72F, 0x74D,
	0x759, 0x75A, 0x75B, 0x854, 0x8AA, 0x8AB, 0x8AC,
}

var adaJoiningL = []rune{
	0xA872,
}

var adaJoiningD = []rune{
	0x620, 0x626, 0x628, 0x62A, 0x62B, 0x62C, 0x62D, 0x62E,
	0x633, 0x634, 0x635, 0x636, 0x637, 0x638, 0x639, 0x63A,
	0x63B, 0x63C, 0x63D, 0x63E, 0x63F, 0x641, 0x642, 0x643,
	0x644, 0x645, 0x646, 0x647, 0x649, 0x64A, 0x66E, 0x66F,
	0x678, 0x679, 0x67A, 0x67B, 0x67C, 0x67D, 0x67E, 0x67F,
	0x680, 0x681, 0x682, 0x683, 0x684, 0x685, 0x686, 0x687,
	0x69A, 0x69B, 0x69C, 0x69D, 0x69E, 0x69F, 0x6A0, 0x6A1,
	0x6A2, 0x6A3, 0x6A4, 0x6A5, 0x6A6, 0x6A7, 0x6A8, 0x6A9,
	0x6AA, 0x6AB, 0x6AC, 0x6AD, 0x6AE, 0x6AF, 0x6B0, 0x6B1,
	0x6B2, 0x6B3, 0x6B4, 0x6B5, 0x6B6, 0x6B7, 0x6B8, 0x6B9,
	0x6BA, 0x6BB, 0x6BC, 0x6BD, 0x6BE, 0x6BF, 0x6C1, 0x6C2,
	0x6CC, 0x6CE, 0x6D0, 0x6D1, 0x6FA, 0x6FB, 0x6FC, 0x6FF,
	0x712, 0x713, 0x714, 0x71A, 0x71B, 0x71C, 0x71D, 0x71F,
	0x720, 0x721, 0x722, 0x723, 0x724, 0x725, 0x726, 0x727,
	0x729, 0x72B, 0x72D, 0x72E, 0x74E, 0x74F, 0x750, 0x751,
	0x752, 0x753, 0x754, 0x755, 0x756, 0x757, 0x758, 0x75C,
	0x75D, 0x75E, 0x75F, 0x760, 0x761, 0x762, 0x763, 0x764,
	0x765, 0x766, 0x850, 0x851, 0x852, 0x853, 0x855, 0x8A0,
	0x8A2, 0x8A3, 0x8A4, 0x8A5, 0x8A6, 0x8A7, 0x8A8, 0x8A9,
	0x1807, 0x1820, 0x1821, 0x1822, 0x1823, 0x1824, 0x1825, 0x1826,
	0x1827, 0x1828, 0x1829, 0x182A, 0x182B, 0x182C, 0x182D, 0x182E,
	0x182F, 0x1830, 0x1831, 0x1832, 0x1833, 0x1834, 0x1835, 0x1836,
	0x1837, 0x1838, 0x1839, 0x183A, 0x183B, 0x183C, 0x183D, 0x183E,
	0x183F, 0x1840, 0x1841, 0x1842, 0x1843, 0x1844, 0x1845, 0x1846,
	0x1847, 0x1848, 0x1849, 0x184A, 0x184B, 0x184C, 0x184D, 0x184E,
	0x184F, 0x1850, 0x1851, 0x1852, 0x1853, 0x1854, 0x1855, 0x1856,
	0x1857, 0x1858, 0x1859, 0x185A, 0x185B, 0x185C, 0x185D, 0x185E,
	0x185F, 0x1860, 0x1861, 0x1862, 0x1863, 0x1864, 0x1865, 0x1866,
	0x1867, 0x1868, 0x1869, 0x186A, 0x186B, 0x186C, 0x186D, 0x186E,
	0x186F, 0x1870, 0x1871, 0x1872, 0x1873, 0x1874, 0x1875, 0x1876,
	0x1877, 0x1887, 0x1888, 0x1889, 0x188A, 0x188B, 0x188C, 0x188D,
	0x188E, 0x188F, 0x1890, 0x1891, 0x1892, 0x1893, 0x1894, 0x1895,
	0x1896, 0x1897, 0x1898, 0x1899, 0x189A, 0x189B, 0x189C, 0x189D,
	0x189E, 0x189F, 0x18A0, 0x18A1, 0x18A2, 0x18A3, 0x18A4, 0x18A5,
	0x18A6, 0x18A7, 0x18A8, 0x18AA, 0xA840, 0xA841, 0xA842, 0xA843,
	0xA844, 0xA845, 0xA846, 0xA847, 0xA848, 0xA849, 0xA84A, 0xA84B,
	0xA84C, 0xA84D, 0xA84E, 0xA84F, 0xA850, 0xA851, 0xA852, 0xA853,
	0xA854, 0xA855, 0xA856, 0xA857, 0xA858, 0xA859, 0xA85A, 0xA85B,
	0xA85C, 0xA85D, 0xA85E, 0xA85F, 0xA860, 0xA861, 0xA862, 0xA863,
	0xA864, 0xA865, 0xA866, 0xA867, 0xA868, 0xA869, 0xA86A, 0xA86B,
	0xA86C, 0xA86D, 0xA86E, 0xA86F, 0xA870, 0xA871,
}
