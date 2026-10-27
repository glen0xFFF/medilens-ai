package domain

import (
	"strings"
	"unicode/utf8"
)

// JSTrim is String.prototype.trim: it removes JS WhiteSpace and
// LineTerminator from both ends (not U+200B or other format characters).
func JSTrim(s string) string { return jsTrim(s) }

// JSLower is String.prototype.toLowerCase (ICU, root locale, Final_Sigma).
func JSLower(s string) string { return jsLower(s) }

// EncodeURIComponent is JS encodeURIComponent: every UTF-8 byte of s is
// written as %XX with upper-case hex, except the ASCII letters, digits and
// - _ . ! ~ * ' ( ). It returns false where JS throws URIError ("URI
// malformed"): JS on a lone surrogate, Go on a string that is not UTF-8.
func EncodeURIComponent(s string) (string, bool) {
	if !utf8.ValidString(s) {
		return "", false
	}
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if uriUnreserved(c) {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0F])
	}
	return b.String(), true
}

func uriUnreserved(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("-_.!~*'()", c) >= 0
}
