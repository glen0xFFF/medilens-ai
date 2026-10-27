package config

import (
	"net/netip"
	"reflect"
	"strings"
	"testing"
)

// PORT is z.coerce.number().int().min(1).max(65535) in Node config.ts:
// JS Number() of the trimmed value, which must be a whole number in range.
func TestPort(t *testing.T) {
	for in, want := range map[string]int{
		"8080": 8080, " 3000 ": 3000, "1": 1, "65535": 65535, "0x1F90": 8080, "1e3": 1000, "8787.0": 8787, "+80": 80,
	} {
		if got := mustLoad(t, map[string]string{"PORT": in}).Port; got != want {
			t.Errorf("PORT %q: %d, want %d", in, got, want)
		}
	}
	for _, in := range []string{"0", "65536", "-1", "80.5", "http", "Infinity", "NaN", "1e999", "80 80", "0x"} {
		if _, err := Load(env(map[string]string{"PORT": in})); err == nil || !strings.Contains(err.Error(), "PORT") {
			t.Errorf("PORT %q: err %v", in, err)
		}
	}
}

// CORS_ORIGIN is an http(s) URL reduced to its origin, as Node's
// z.url({protocol: /^https?$/}).transform(u => new URL(u).origin): a
// trailing slash (or any path) is dropped, the scheme and an ASCII host are
// lower-cased, and a default port is dropped. The API compares it with the
// browser's Origin header exactly.
func TestCORSOrigin(t *testing.T) {
	for in, want := range map[string]string{
		"http://localhost:8081":         "http://localhost:8081",
		"http://localhost:8081/":        "http://localhost:8081",
		"http://localhost:8081/app?x#y": "http://localhost:8081",
		"HTTPS://Example.COM":           "https://example.com",
		"https://example.com:443/":      "https://example.com",
		"http://example.com:80":         "http://example.com",
		"http://example.com:443":        "http://example.com:443",
		"https://user:pw@example.com/":  "https://example.com",
		"http://127.0.0.1:8081":         "http://127.0.0.1:8081",
		"http://[::1]:8081/":            "http://[::1]:8081",
		// final review M15: Node's z.url() trims the value first
		" http://localhost:8081 ":   "http://localhost:8081",
		"\thttp://localhost:8081\n": "http://localhost:8081",
	} {
		if got := mustLoad(t, map[string]string{"CORS_ORIGIN": in}).CORSOrigin; got != want {
			t.Errorf("CORS_ORIGIN %q: %q, want %q", in, got, want)
		}
	}
	for _, in := range []string{
		"localhost:8081", "ftp://example.com", "http://", "https:///x", "javascript:alert(1)",
		"http://example.com:99999", "http://example.com:x", "not a url", "http://exämple.com",
		"//example.com", "*",
		// final review M15: Node rejects an IPv6 zone; a browser Origin never has one
		"http://[fe80::1%25en0]:8081", "http://[fe80::1%en0]:8081",
	} {
		if _, err := Load(env(map[string]string{"CORS_ORIGIN": in})); err == nil || !strings.Contains(err.Error(), "CORS_ORIGIN") {
			t.Errorf("CORS_ORIGIN %q: err %v", in, err)
		}
	}
}

// TRUSTED_PROXIES is a comma-separated CIDR list (Go port spec §4), empty
// by default: only those hops' X-Forwarded-For is honoured.
func TestTrustedProxies(t *testing.T) {
	p := netip.MustParsePrefix
	for in, want := range map[string][]netip.Prefix{
		"10.0.0.0/8":                    {p("10.0.0.0/8")},
		" 10.0.0.0/8 , 192.168.1.0/24 ": {p("10.0.0.0/8"), p("192.168.1.0/24")},
		"10.1.2.3/8":                    {p("10.0.0.0/8")},
		"::1/128,2001:db8::/32":         {p("::1/128"), p("2001:db8::/32")},
		"10.0.0.0/8,,":                  {p("10.0.0.0/8")},
	} {
		if got := mustLoad(t, map[string]string{"TRUSTED_PROXIES": in}).TrustedProxies; !reflect.DeepEqual(got, want) {
			t.Errorf("TRUSTED_PROXIES %q: %v, want %v", in, got, want)
		}
	}
	for _, in := range []string{"10.0.0.1", "abc", "10.0.0.0/33", "10.0.0.0/8 192.168.0.0/16", "10.0.0.0/8;", ",", "fe80::1%eth0/64"} {
		if _, err := Load(env(map[string]string{"TRUSTED_PROXIES": in})); err == nil || !strings.Contains(err.Error(), "TRUSTED_PROXIES") {
			t.Errorf("TRUSTED_PROXIES %q: err %v", in, err)
		}
	}
}
