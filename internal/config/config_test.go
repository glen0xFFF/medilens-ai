package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func mustLoad(t *testing.T, m map[string]string) Config {
	t.Helper()
	cfg, err := Load(env(m))
	if err != nil {
		t.Fatalf("Load(%v): %v", m, err)
	}
	return cfg
}

func TestDefaults(t *testing.T) {
	want := Config{ModelProvider: ModelMock, ReferenceProvider: ReferenceFixture, DailySpendCapUSD: 5}
	if got := mustLoad(t, nil); got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
	if DefaultDailySpendCapUSD != 5 {
		t.Errorf("DefaultDailySpendCapUSD = %v", DefaultDailySpendCapUSD)
	}
}

// KEY= in a .env file means "not set": blank values fall back to the default.
func TestBlankValuesMeanTheDefault(t *testing.T) {
	for _, blank := range []string{"", "   ", "\t\n"} {
		got := mustLoad(t, map[string]string{
			"MODEL_PROVIDER": blank, "REFERENCE_PROVIDER": blank, "MODEL_API_KEY": blank,
			"DAILY_SPEND_CAP_USD": blank, "PUBLIC_REPO_URL": blank,
		})
		if got != (Config{ModelProvider: ModelMock, ReferenceProvider: ReferenceFixture, DailySpendCapUSD: 5}) {
			t.Errorf("%q: %+v", blank, got)
		}
	}
}

func TestReadsEveryVariable(t *testing.T) {
	got := mustLoad(t, map[string]string{
		"MODEL_PROVIDER":      "muse_spark",
		"REFERENCE_PROVIDER":  "ph_fda",
		"MODEL_API_KEY":       "  test-key  ",
		"DAILY_SPEND_CAP_USD": "2.5",
		"PUBLIC_REPO_URL":     "https://github.com/example/medilens-ai",
	})
	want := Config{
		ModelProvider:     ModelMuseSpark,
		ReferenceProvider: ReferencePHFDA,
		ModelAPIKey:       "test-key",
		DailySpendCapUSD:  2.5,
		PublicRepoURL:     "https://github.com/example/medilens-ai",
	}
	if got != want {
		t.Errorf("got %+v", got)
	}
	if got.ModelAPIKey.Reveal() != "test-key" {
		t.Errorf("Reveal = %q", got.ModelAPIKey.Reveal())
	}
}

// Go port spec \u00A73: muse_spark without MODEL_API_KEY is a startup error.
func TestMuseSparkWithoutAKeyFails(t *testing.T) {
	for _, key := range []string{"", "   ", "\u00A0"} {
		_, err := Load(env(map[string]string{"MODEL_PROVIDER": "muse_spark", "MODEL_API_KEY": key}))
		if err == nil || !strings.Contains(err.Error(), "MODEL_API_KEY") {
			t.Errorf("key %q: err %v", key, err)
		}
	}
	if _, err := Load(env(map[string]string{"MODEL_PROVIDER": "muse_spark"})); err == nil {
		t.Error("absent key accepted")
	}
}

func TestMockNeedsNoKey(t *testing.T) {
	if cfg := mustLoad(t, map[string]string{"MODEL_PROVIDER": "mock"}); cfg.ModelProvider != ModelMock {
		t.Errorf("%+v", cfg)
	}
}

func TestRejectsInvalidValues(t *testing.T) {
	for _, tc := range []struct {
		env  map[string]string
		name string
	}{
		{map[string]string{"MODEL_PROVIDER": "production"}, "MODEL_PROVIDER"},
		{map[string]string{"MODEL_PROVIDER": "MOCK"}, "MODEL_PROVIDER"},
		{map[string]string{"MODEL_PROVIDER": " mock"}, "MODEL_PROVIDER"},
		{map[string]string{"MODEL_PROVIDER": "claude"}, "MODEL_PROVIDER"},
		{map[string]string{"REFERENCE_PROVIDER": "live"}, "REFERENCE_PROVIDER"},
		{map[string]string{"REFERENCE_PROVIDER": "ph-fda"}, "REFERENCE_PROVIDER"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "-1"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "lots"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "Infinity"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "1e999"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "NaN"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "1_000"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "5 USD"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "0x"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"DAILY_SPEND_CAP_USD": "-0x10"}, "DAILY_SPEND_CAP_USD"},
		{map[string]string{"PUBLIC_REPO_URL": "javascript:alert(1)"}, "PUBLIC_REPO_URL"},
		{map[string]string{"PUBLIC_REPO_URL": "not a url"}, "PUBLIC_REPO_URL"},
		{map[string]string{"PUBLIC_REPO_URL": "https://localhost/x"}, "PUBLIC_REPO_URL"},
	} {
		_, err := Load(env(tc.env))
		if err == nil || !strings.Contains(err.Error(), tc.name) {
			t.Errorf("%v: err %v", tc.env, err)
		}
	}
}

// z.coerce.number() is JS Number(): whitespace is trimmed, and hex, octal,
// binary and exponent forms are numbers.
func TestSpendCapIsReadAsAJSNumber(t *testing.T) {
	for in, want := range map[string]float64{
		"5": 5, " 3 ": 3, "1e1": 10, "0x10": 16, "0o7": 7, "0b11": 3, ".5": 0.5, "5.": 5, "+5": 5, "0": 0, "-0": 0, "2.50": 2.5,
	} {
		if got := mustLoad(t, map[string]string{"DAILY_SPEND_CAP_USD": in}).DailySpendCapUSD; got != want {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
}

// Every problem is named in one error; no value is ever echoed.
func TestErrorsNameEveryProblemAndNeverAValue(t *testing.T) {
	_, err := Load(env(map[string]string{
		"MODEL_PROVIDER":      "prod",
		"MODEL_API_KEY":       "sk-secret-value-123",
		"DAILY_SPEND_CAP_USD": "secret-cap-value",
		"PUBLIC_REPO_URL":     "secret-url-value",
		"REFERENCE_PROVIDER":  "secret-ref-value",
	}))
	if err == nil {
		t.Fatal("no error")
	}
	msg := err.Error()
	for _, name := range []string{"MODEL_PROVIDER", "REFERENCE_PROVIDER", "DAILY_SPEND_CAP_USD", "PUBLIC_REPO_URL"} {
		if !strings.Contains(msg, name) {
			t.Errorf("message lacks %s: %s", name, msg)
		}
	}
	for _, value := range []string{"sk-secret-value-123", "secret-cap-value", "secret-url-value", "secret-ref-value", "prod"} {
		if strings.Contains(msg, value) {
			t.Errorf("message echoes %q: %s", value, msg)
		}
	}
}

// The key never reaches a log line, a format verb or JSON.
func TestTheKeyIsNeverPrinted(t *testing.T) {
	const key = "sk-secret-value-123"
	cfg := mustLoad(t, map[string]string{"MODEL_PROVIDER": "muse_spark", "MODEL_API_KEY": key})
	var outs []string
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%d"} {
		outs = append(outs, fmt.Sprintf(verb, cfg), fmt.Sprintf(verb, cfg.ModelAPIKey))
	}
	b, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	outs = append(outs, string(b))
	var buf bytes.Buffer
	slog.New(slog.NewJSONHandler(&buf, nil)).Info("config", "config", cfg, "key", cfg.ModelAPIKey)
	outs = append(outs, buf.String())
	for _, out := range outs {
		if strings.Contains(out, key) || strings.Contains(out, fmt.Sprintf("%x", key)) {
			t.Errorf("key printed: %s", out)
		}
	}
	if !strings.Contains(buf.String(), "[redacted]") {
		t.Errorf("log line %s", buf.String())
	}
}

func TestUserAgent(t *testing.T) {
	if DefaultRepoURL != "https://github.com/medilens-ai" {
		t.Errorf("DefaultRepoURL %q", DefaultRepoURL)
	}
	if got := mustLoad(t, nil).UserAgent(); got != "MediLensAI/0.1 (+https://github.com/medilens-ai)" {
		t.Errorf("%q", got)
	}
	got := mustLoad(t, map[string]string{"PUBLIC_REPO_URL": "https://github.com/example/medilens-ai"}).UserAgent()
	if got != "MediLensAI/0.1 (+https://github.com/example/medilens-ai)" {
		t.Errorf("%q", got)
	}
}
