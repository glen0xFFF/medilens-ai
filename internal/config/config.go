// Package config loads and validates the server environment (ruling R7):
// which model and reference providers run, the Muse Spark key, the daily
// spend cap and the repository URL in the PH FDA User-Agent. Task G8 adds
// the HTTP settings and the .env loader.
//
// Blank values mean "not set" (KEY= in a .env file), as in the Node
// loader. An invalid setting is a startup error naming each bad variable;
// the error never contains a value, so a key can never reach a startup log.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
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
}

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
	cfg := Config{ModelProvider: ModelMock, ReferenceProvider: ReferenceFixture, DailySpendCapUSD: DefaultDailySpendCapUSD}
	var problems []string
	bad := func(name, rule string) { problems = append(problems, name+": "+rule) }
	value := func(name string) (string, bool) {
		v := getenv(name)
		return v, domain.JSTrim(v) != ""
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
