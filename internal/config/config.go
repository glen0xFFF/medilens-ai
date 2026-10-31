// Package config loads and validates the server environment (ruling R7):
// which model and reference providers run, the Muse Spark key, the daily
// spend cap and the repository URL in the PH FDA User-Agent, and (task G8)
// the API's HTTP settings: PORT, CORS_ORIGIN and TRUSTED_PROXIES. The .env
// loader is in dotenv.go.
//
// Blank values mean "not set" (KEY= in a .env file), as in the Node
// loader. An invalid setting is a startup error naming each bad variable;
// the error never contains a value, so a key can never reach a startup log.
//
// Node variables the Go API does not read: PROVIDER_MODE (replaced by
// MODEL_PROVIDER and REFERENCE_PROVIDER; a non-blank PROVIDER_MODE is a
// startup error, final review M3), TRUST_PROXY and NODE_ENV (a proxy hop
// count, one hop by default in production; replaced by the TRUSTED_PROXIES
// CIDR list, empty by default).
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/domain"
)

// ModelProvider is MODEL_PROVIDER.
type ModelProvider string

// The model providers. There is no fallback between them.
const (
	ModelMock      ModelProvider = "mock"
	ModelMuseSpark ModelProvider = "muse_spark"
)

// ReferenceProvider is REFERENCE_PROVIDER.
type ReferenceProvider string

// The reference providers.
const (
	ReferenceFixture ReferenceProvider = "fixture"
	ReferencePHFDA   ReferenceProvider = "ph_fda"
)

const (
	// DefaultDailySpendCapUSD is DAILY_SPEND_CAP_USD when unset.
	DefaultDailySpendCapUSD = 5
	// DefaultRepoURL is used in the PH FDA User-Agent when PUBLIC_REPO_URL
	// is unset.
	DefaultRepoURL = "https://github.com/medilens-ai"
)

const redacted = "[redacted]"

// Secret is a value that must never be printed: every fmt verb, JSON and
// slog show "[redacted]". Reveal returns the value.
type Secret string

// Reveal returns the secret itself, for the one place that sends it.
func (s Secret) Reveal() string { return string(s) }

// Format prints [redacted] whatever the verb.
func (s Secret) Format(f fmt.State, _ rune) { _, _ = f.Write([]byte(redacted)) }

// MarshalJSON encodes [redacted].
func (s Secret) MarshalJSON() ([]byte, error) { return []byte(`"` + redacted + `"`), nil }

// LogValue logs [redacted].
func (s Secret) LogValue() slog.Value { return slog.StringValue(redacted) }

// Config is the validated provider configuration.
type Config struct {
	ModelProvider     ModelProvider
	ReferenceProvider ReferenceProvider
	// ModelAPIKey is the server-only Meta Model API key; set (non-blank)
	// whenever ModelProvider is muse_spark.
	ModelAPIKey Secret
	// DailySpendCapUSD caps live model spend per UTC day.
	DailySpendCapUSD float64
	// PublicRepoURL is "" when unset.
	PublicRepoURL string
	// Port is PORT, the API's TCP port (1 to 65535).
	Port int
	// CORSOrigin is CORS_ORIGIN reduced to an origin (scheme://host[:port],
	// lower-case, no default port, no path), the one browser origin the API
	// answers CORS for; "" when unset (no CORS headers at all).
	CORSOrigin string
	// TrustedProxies is TRUSTED_PROXIES, the CIDR ranges of the proxies in
	// front of the API whose X-Forwarded-For is honoured for the client
	// address the rate limits key on; nil when unset (the socket peer is
	// the client).
	TrustedProxies []netip.Prefix
}

// DefaultPort is PORT when unset (Node config.ts).
const DefaultPort = 8787

// UserAgent is the honest User-Agent for PH FDA lookups.
func (c Config) UserAgent() string {
	repo := c.PublicRepoURL
	if repo == "" {
		repo = DefaultRepoURL
	}
	return "MediLensAI/0.1 (+" + repo + ")"
}

// Load reads and validates the environment through getenv (os.Getenv, or a
// map in tests).
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{ModelProvider: ModelMock, ReferenceProvider: ReferenceFixture, DailySpendCapUSD: DefaultDailySpendCapUSD, Port: DefaultPort}
	var problems []string
	bad := func(name, rule string) { problems = append(problems, name+": "+rule) }
	value := func(name string) (string, bool) {
		v := getenv(name)
		return v, domain.JSTrim(v) != ""
	}

	// Final review M3: the Node variable is refused, not ignored, so a host
	// set up from the Node docs never starts on mock without a word.
	if _, ok := value("PROVIDER_MODE"); ok {
		bad("PROVIDER_MODE", "is no longer read; remove it and set MODEL_PROVIDER (mock or muse_spark) and REFERENCE_PROVIDER (fixture or ph_fda) instead")
	}
	if v, ok := value("MODEL_PROVIDER"); ok {
		switch p := ModelProvider(v); p {
		case ModelMock, ModelMuseSpark:
			cfg.ModelProvider = p
		default:
			bad("MODEL_PROVIDER", "must be mock or muse_spark")
		}
	}
	if v, ok := value("REFERENCE_PROVIDER"); ok {
		switch p := ReferenceProvider(v); p {
		case ReferenceFixture, ReferencePHFDA:
			cfg.ReferenceProvider = p
		default:
			bad("REFERENCE_PROVIDER", "must be fixture or ph_fda")
		}
	}
	if v, ok := value("MODEL_API_KEY"); ok {
		cfg.ModelAPIKey = Secret(domain.JSTrim(v))
	}
	if cfg.ModelProvider == ModelMuseSpark && cfg.ModelAPIKey == "" {
		bad("MODEL_API_KEY", "required when MODEL_PROVIDER=muse_spark")
	}
	if v, ok := value("DAILY_SPEND_CAP_USD"); ok {
		n, isNumber := jsNumber(v)
		if !isNumber || math.IsInf(n, 0) || n < 0 {
			bad("DAILY_SPEND_CAP_USD", "must be a finite number of US dollars, 0 or more")
		} else {
			cfg.DailySpendCapUSD = n + 0 // -0 is 0
		}
	}
	if v, ok := value("PUBLIC_REPO_URL"); ok {
		if u, ok := contracts.ParseHTTPURL(v); ok {
			cfg.PublicRepoURL = u
		} else {
			bad("PUBLIC_REPO_URL", "must be an http(s) URL with a public host name")
		}
	}
	if v, ok := value("PORT"); ok {
		// z.coerce.number().int().min(1).max(65535)
		n, isNumber := jsNumber(v)
		if !isNumber || n != math.Trunc(n) || n < 1 || n > 65535 {
			bad("PORT", "must be a whole number from 1 to 65535")
		} else {
			cfg.Port = int(n)
		}
	}
	if v, ok := value("CORS_ORIGIN"); ok {
		// trimmed first, as Node's z.url() does (final review M15)
		if o, ok := httpOrigin(domain.JSTrim(v)); ok {
			cfg.CORSOrigin = o
		} else {
			bad("CORS_ORIGIN", "must be the http(s) origin of the browser client, such as http://localhost:8081")
		}
	}
	if v, ok := value("TRUSTED_PROXIES"); ok {
		if ps, ok := cidrList(v); ok {
			cfg.TrustedProxies = ps
		} else {
			bad("TRUSTED_PROXIES", "must be a comma-separated list of CIDR ranges, such as 10.0.0.0/8")
		}
	}

	if len(problems) > 0 {
		return Config{}, errors.New("invalid server configuration: " + strings.Join(problems, "; "))
	}
	return cfg, nil
}

var (
	jsDecimal = regexp.MustCompile(`^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$`)
	jsRadix   = regexp.MustCompile(`^0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)
)

// jsNumber is JS Number(s) (what z.coerce.number() calls) for a non-blank
// string: false where JS gives NaN. Infinity and an overflowing exponent
// give ±Inf, as in JS.
func jsNumber(s string) (float64, bool) {
	t := domain.JSTrim(s)
	switch {
	case jsRadix.MatchString(t):
		base := map[byte]float64{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[t[1]]
		n := 0.0
		for _, c := range t[2:] {
			d, _ := strconv.ParseInt(string(c), 16, 8)
			n = n*base + float64(d)
		}
		return n, true
	case jsDecimal.MatchString(t):
		if strings.HasSuffix(t, "Infinity") {
			if t[0] == '-' {
				return math.Inf(-1), true
			}
			return math.Inf(1), true
		}
		n, err := strconv.ParseFloat(t, 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return 0, false
		}
		return n, true
	}
	return 0, false
}

// httpOrigin is CORS_ORIGIN as Node read it, z.url({protocol: /^https?$/})
// then new URL(u).origin: an http(s) URL with a host, reduced to
// scheme://host[:port] with the scheme and host lower-cased, the default
// port (80, 443) dropped and the port's leading zeros removed. A path,
// query, fragment or user info is dropped, as in Node.
//
// Differences from the WHATWG parser, all failing closed or loud: a
// non-ASCII host is rejected (Node converts it to its A-label), and an IP
// address is kept as written (WHATWG rewrites forms such as 127.000.0.1),
// so such a value never matches a browser's Origin and no CORS header is
// sent.
func httpOrigin(s string) (string, bool) {
	u, err := url.Parse(s)
	if err != nil || u.Opaque != "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	host := u.Hostname()
	// an IPv6 zone (fe80::1%en0) is refused, as Node refuses it; a
	// browser's Origin never carries one (final review M15)
	if host == "" || strings.Contains(host, "%") {
		return "", false
	}
	for i := 0; i < len(host); i++ {
		if host[i] >= 0x80 {
			return "", false
		}
	}
	host = strings.ToLower(host)
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	origin := scheme + "://" + host
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n > 65535 {
			return "", false
		}
		if !(scheme == "http" && n == 80) && !(scheme == "https" && n == 443) {
			origin += ":" + strconv.Itoa(n)
		}
	}
	return origin, true
}

// cidrList is TRUSTED_PROXIES: comma-separated CIDR ranges (spaces around
// an entry and empty entries are ignored; at least one range is needed).
// Each range is masked (10.1.2.3/8 is 10.0.0.0/8), and an IPv4-mapped IPv6
// range is stored as the IPv4 range, because client addresses are unmapped
// before they are compared.
func cidrList(s string) ([]netip.Prefix, bool) {
	var out []netip.Prefix
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		p, err := netip.ParsePrefix(part)
		if err != nil {
			return nil, false
		}
		if a := p.Addr(); a.Is4In6() && p.Bits() >= 96 {
			p = netip.PrefixFrom(a.Unmap(), p.Bits()-96)
		}
		out = append(out, p.Masked())
	}
	return out, len(out) > 0
}
