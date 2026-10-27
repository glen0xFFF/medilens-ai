package contracts

import (
	"regexp"
	"strings"
)

// ParseHTTPURL is zod's z.httpUrl() (zod 4.6.7), the rule match.ts applies
// to ReferenceRecord.sourceUrl and Advisory.url. It returns the value the
// schema outputs, which is s trimmed (JS String.prototype.trim) with every
// ASCII tab, LF and CR removed, and true; or "", false when the schema
// rejects s.
//
// zod accepts a string that, once trimmed, starts with http:// or https://
// (any case), parses as a WHATWG URL, and has a hostname matching zod's
// domain pattern: dot-separated letter-digit-hyphen labels of 1 to 63
// characters that neither start nor end with a hyphen, a final label of 2
// to 63 letters, 253 characters at most. So localhost, IP addresses and
// "https:/host" are rejected.
//
// This reproduces the WHATWG host parse for http(s) URLs: leading and
// trailing C0 controls and spaces are ignored, tabs and newlines removed,
// any run of / and \ after the scheme skipped, the host is what follows the
// last @ of the authority (which ends at /, \, ? or #), the port must be
// decimal and at most 65535, and the host is percent-decoded and
// lowercased. One deliberate difference, on the fail-closed side: a host
// that needs IDNA processing (non-ASCII after percent-decoding, or an xn--
// label) is rejected, because there is no UTS #46 table in the pinned
// dependencies. zod's parser accepts some of those. Checked against zod on
// fixtures/parity/providers/httpurl.jsonl.
func ParseHTTPURL(s string) (string, bool) {
	trimmed := strings.TrimFunc(s, isJSSpace)
	if !hasHTTPScheme(trimmed) {
		return "", false
	}
	host, ok := whatwgHTTPHost(trimmed)
	if !ok || !isZodDomain(host) {
		return "", false
	}
	return removeTabAndNewline(trimmed), true
}

// isJSSpace is the JS WhiteSpace and LineTerminator set that
// String.prototype.trim removes.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00A0', '\u1680',
		'\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF':
		return true
	}
	return r >= '\u2000' && r <= '\u200A'
}

// hasHTTPScheme is zod's guard /^https?:\/\//i. A non-unicode /i RegExp
// folds ASCII letters only.
func hasHTTPScheme(s string) bool {
	lower := strings.ToLower(prefix(s, len("https://")))
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// prefix is the first n bytes of s, or all of s.
func prefix(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}

func isTabOrNewline(r rune) bool { return r == '\t' || r == '\n' || r == '\r' }

func removeTabAndNewline(s string) string {
	if !strings.ContainsFunc(s, isTabOrNewline) {
		return s
	}
	return strings.Map(func(r rune) rune {
		if isTabOrNewline(r) {
			return -1
		}
		return r
	}, s)
}

// whatwgHTTPHost is the hostname the WHATWG URL parser gives s, which
// starts with http:// or https:// in any case, or false when the parser
// fails or the host needs IDNA processing.
func whatwgHTTPHost(s string) (string, bool) {
	// leading and trailing C0 control or space, then every tab and newline
	in := removeTabAndNewline(strings.TrimFunc(s, func(r rune) bool { return r <= 0x20 }))
	rest := in[strings.IndexByte(in, ':')+1:]
	rest = strings.TrimLeft(rest, `/\`)
	authority := rest
	if end := strings.IndexAny(rest, `/\?#`); end >= 0 {
		authority = rest[:end]
	}
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:]
	}
	// [ and ] are forbidden host code points, and an IPv6 address is never
	// a domain: either way zod rejects it
	if strings.ContainsAny(authority, "[]") {
		return "", false
	}
	host, port, hasPort := strings.Cut(authority, ":")
	if host == "" || (hasPort && !validPort(port)) {
		return "", false
	}
	decoded, ok := percentDecode(host)
	if !ok {
		return "", false
	}
	lower := strings.ToLower(decoded)
	for label := range strings.SplitSeq(lower, ".") {
		if strings.HasPrefix(label, "xn--") {
			return "", false
		}
	}
	return lower, true
}

// validPort is a WHATWG port: ASCII digits only (empty is allowed) with a
// value of at most 65535; leading zeros are allowed.
func validPort(p string) bool {
	n := 0
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c < '0' || c > '9' {
			return false
		}
		n = n*10 + int(c-'0')
		if n > 65535 {
			return false
		}
	}
	return true
}

func hexValue(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// percentDecode is WHATWG percent-decoding (a % not followed by two hex
// digits stays as it is), or false when the result is not ASCII: such a
// host needs IDNA processing, or is not UTF-8 and fails the parse.
func percentDecode(s string) (string, bool) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '%' && i+2 < len(s) {
			hi, ok1 := hexValue(s[i+1])
			lo, ok2 := hexValue(s[i+2])
			if ok1 && ok2 {
				c = hi<<4 | lo
				i += 2
			}
		}
		if c >= 0x80 {
			return "", false
		}
		b.WriteByte(c)
	}
	return b.String(), true
}

// zodDomain is zod's regexes.domain without its (?=.{1,253}$) lookahead,
// which isZodDomain checks as a length.
var zodDomain = regexp.MustCompile(`^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$`)

// isZodDomain is zod's hostname check for z.httpUrl(). The host is ASCII
// here, so its byte length is its length in characters.
func isZodDomain(host string) bool {
	return len(host) >= 1 && len(host) <= 253 && zodDomain.MatchString(host)
}
