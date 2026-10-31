package domain

import "testing"

// EncodeURIComponent is JS encodeURIComponent: every UTF-8 byte is %XX
// (upper-case hex) except A-Z a-z 0-9 - _ . ! ~ * ' ( ). Expected values
// are what V8 returns for the same strings.
func TestEncodeURIComponent(t *testing.T) {
	for in, want := range map[string]string{
		"paracelin":            "paracelin",
		"DR-XY99001":           "DR-XY99001",
		"para celin":           "para%20celin",
		"a+b&c=d/e?f#g":        "a%2Bb%26c%3Dd%2Fe%3Ff%23g",
		"-_.!~*'()":            "-_.!~*'()",
		"\u00E4":               "%C3%A4",
		"\u20AC":               "%E2%82%AC",
		"\U0001F600":           "%F0%9F%98%80",
		"%":                    "%25",
		"":                     "",
		"tab\there\nnewline":   "tab%09here%0Anewline",
		"@:;,$[]{}|\x5c^`\"<>": "%40%3A%3B%2C%24%5B%5D%7B%7D%7C%5C%5E%60%22%3C%3E",
	} {
		got, ok := EncodeURIComponent(in)
		if !ok || got != want {
			t.Errorf("EncodeURIComponent(%q) = (%q, %v), want %q", in, got, ok, want)
		}
	}
	// JS throws URIError ("URI malformed") on a lone surrogate; a Go string
	// that is not valid UTF-8 is the counterpart.
	if _, ok := EncodeURIComponent("bad\xffbyte"); ok {
		t.Error("invalid UTF-8 was encoded")
	}
}

func TestJSTrimAndJSLowerAreTheDomainHelpers(t *testing.T) {
	if got := JSTrim("\u00A0\uFEFF paracelin \u3000\n"); got != "paracelin" {
		t.Errorf("JSTrim = %q", got)
	}
	if got := JSTrim("\u200Bparacelin"); got != "\u200Bparacelin" {
		t.Errorf("JSTrim removed U+200B, which is not JS whitespace: %q", got)
	}
	if got := JSLower("PARACELIN \u03A3\u0391\u03A3"); got != jsLower("PARACELIN \u03A3\u0391\u03A3") {
		t.Errorf("JSLower = %q", got)
	}
	if got := JSLower("\u0130"); got != "i\u0307" {
		t.Errorf("JSLower(U+0130) = %q, want i + U+0307 as V8", got)
	}
}
