package observability

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/config"
	"github.com/medilens-ai/medilens/internal/contracts"
)

// All label data here is synthetic DEMO DATA; the SECRET-* strings are
// sentinels that must never reach a log line.

func logLines(t *testing.T, log func(*slog.Logger)) (string, []map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	log(New(&buf))
	out := buf.String()
	var lines []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("not a JSON line %q: %v", l, err)
		}
		lines = append(lines, m)
	}
	return out, lines
}

// Final review M15: slog calls ReplaceAttr for the attributes inside a
// group with the group path, never for the group itself, so a sensitive
// group name (as pino's *.question redacted an object) redacts every value
// under it.
func TestASensitiveGroupRedactsItsValues(t *testing.T) {
	out, _ := logLines(t, func(l *slog.Logger) {
		l.Info("x",
			slog.Group("question", "text", "SECRET question"),
			slog.Group("label", slog.Group("rawText", "first", "SECRET raw")),
			slog.Group("req", "status", 200),
		)
	})
	noSentinel(t, out)
	if !strings.Contains(out, `"status":200`) {
		t.Errorf("an ordinary group lost its value:\n%s", out)
	}
}

func noSentinel(t *testing.T, out string) {
	t.Helper()
	if strings.Contains(out, "SECRET") {
		t.Errorf("a sentinel reached the log:\n%s", out)
	}
}

// Go port spec §4: ReplaceAttr redacts rawText, question, evidenceText and
// authorization, at any depth and in any letter case.
func TestRedactsTheSensitiveKeys(t *testing.T) {
	out, lines := logLines(t, func(l *slog.Logger) {
		l.Info("x",
			"question", "SECRET-question",
			"rawText", "SECRET-raw",
			"evidenceText", "SECRET-evidence",
			"authorization", "Bearer SECRET-token",
			"Authorization", "Bearer SECRET-token-2",
			"QUESTION", "SECRET-question-2",
			slog.Group("label", "rawText", "SECRET-raw-2", slog.Group("field", "evidenceText", "SECRET-evidence-2")),
			slog.Group("req", slog.Group("headers", "authorization", "Bearer SECRET-token-3")),
		)
	})
	noSentinel(t, out)
	if lines[0]["question"] != Redacted || lines[0]["rawText"] != Redacted {
		t.Errorf("line %v", lines[0])
	}
}

// The research negative control: the JSON handler marshals a struct, map
// or slice with encoding/json, so ReplaceAttr never sees its fields. Here
// such a value (and an error, whose text may carry label text) is never
// written out.
func TestNeverWritesACompositeValue(t *testing.T) {
	type result struct {
		RawText string `json:"rawText"`
		Brand   string `json:"brand"`
	}
	out, lines := logLines(t, func(l *slog.Logger) {
		l.Info("x",
			slog.Any("result", result{"SECRET-raw", "SECRET-brand"}),
			slog.Any("ptr", &result{"SECRET-raw-p", "SECRET-brand-p"}),
			slog.Any("map", map[string]string{"k": "SECRET-map"}),
			slog.Any("list", []string{"SECRET-list"}),
			slog.Any("err", errors.New("SECRET-error-text")),
		)
	})
	noSentinel(t, out)
	for _, k := range []string{"result", "ptr", "map", "list", "err"} {
		if lines[0][k] != Redacted {
			t.Errorf("%s = %v", k, lines[0][k])
		}
	}
}

func TestKeepsPlainValuesAndSecretsStayRedacted(t *testing.T) {
	out, lines := logLines(t, func(l *slog.Logger) {
		l.Info("request", "requestId", "r-1", "status", 200, "route", "GET /healthz", "durationMs", 1.5, "ok", true,
			"apiKey", config.Secret("SECRET-key"))
	})
	noSentinel(t, out)
	m := lines[0]
	if m["msg"] != "request" || m["requestId"] != "r-1" || m["status"] != float64(200) || m["route"] != "GET /healthz" ||
		m["durationMs"] != 1.5 || m["ok"] != true || m["apiKey"] != "[redacted]" {
		t.Errorf("line %v", m)
	}
	// the record's own level is kept (found by the task G8 smoke run: it is
	// an Any value, and the backstop redacted it)
	if m["level"] != "INFO" {
		t.Errorf("level %v", m["level"])
	}
	_, lines = logLines(t, func(l *slog.Logger) { l.Warn("w"); l.Error("e", "level", struct{ X string }{"SECRET"}) })
	if lines[0]["level"] != "WARN" || lines[1]["level"] != Redacted {
		t.Errorf("levels %v %v", lines[0]["level"], lines[1]["level"])
	}
}

func ptr(s string) *string { return &s }

// Domain types log a whitelist (LogValue): counts and states, never a
// printed value, a question, an answer text or the analysis id (the only
// capability to read a result).
func TestDomainTypesLogOnlyTheirWhitelist(t *testing.T) {
	field := contracts.LabelField{
		Key: contracts.FieldStrength, Value: ptr("SECRET-500 mg"), Legibility: contracts.LegibilityClear,
		EvidenceText: ptr("SECRET-evidence"), Notes: ptr("SECRET-notes"),
	}
	label := contracts.ExtractedLabel{
		ImageKind: contracts.ImageKindLabel, Fields: []contracts.LabelField{field, field},
		RawText: "SECRET-raw", Warnings: []string{"SECRET-warning"},
	}
	match := contracts.MatchAssessment{
		Status:      contracts.MatchConflicting,
		Matched:     []contracts.FieldKey{contracts.FieldBrandName},
		Conflicting: []contracts.FieldConflict{{Key: contracts.FieldStrength, LabelValue: "SECRET-lv", ReferenceValue: "SECRET-rv"}},
		Candidates: []contracts.ReferenceRecord{{
			Provider: "SECRET-provider", SourceURL: "https://example.org/SECRET", RegistrationNumber: "SECRET-reg",
			BrandName: ptr("SECRET-brand"), CheckedAt: "2026-10-27T08:00:00.000Z",
		}},
		Advisories:  []contracts.Advisory{{Title: "SECRET-advisory", URL: "https://example.org/SECRET-a"}},
		Limitations: []string{"SECRET-limitation"},
	}
	result := contracts.AnalysisResult{
		ID: "SECRET-id", IsDemo: true, CreatedAt: "2026-10-27T08:00:00.000Z", ExpiresAt: "2026-10-27T08:15:00.000Z",
		PipelineState: contracts.PipelineExplanationReady, Label: &label, Match: match,
		Quality: contracts.QualityReport{OK: true, Sharpness: 20, Luminance: 120, GlareFraction: 0.01},
		Explanation: contracts.Explanation{
			DisplayText: "SECRET-display", SpokenChunks: []string{"SECRET-chunk"},
			SafetyNotices: []string{"SECRET-notice"}, SupportingFields: []contracts.FieldKey{contracts.FieldStrength},
		},
		ImageRetention: contracts.ImageRetentionNone,
	}
	answer := contracts.Answer{
		Status: contracts.AnswerAnswered, Text: "SECRET-answer", SpokenChunks: []string{"SECRET-a-chunk"},
		CitedFields: []contracts.FieldKey{contracts.FieldStrength}, SafetyNotice: ptr("SECRET-safety"),
	}
	out, lines := logLines(t, func(l *slog.Logger) {
		l.Info("domain", "result", result, "resultPtr", &result, "label", label, "field", field, "match", match,
			"answer", answer, "explain", contracts.ExplainRequest{Question: "SECRET-question"})
	})
	noSentinel(t, out)
	m := lines[0]
	want := map[string]map[string]any{
		"result": {"isDemo": true, "pipelineState": "explanation_ready", "matchStatus": "conflicting", "qualityOk": true, "fields": float64(2)},
		"label":  {"imageKind": "label", "fields": float64(2), "warnings": float64(1)},
		"field":  {"key": "strength", "legibility": "clear", "hasValue": true},
		"match":  {"status": "conflicting", "matched": float64(1), "conflicting": float64(1), "candidates": float64(1), "advisories": float64(1)},
		"answer": {"status": "answered", "citedFields": float64(1)},
	}
	for k, fields := range want {
		got, ok := m[k].(map[string]any)
		if !ok {
			t.Errorf("%s = %v", k, m[k])
			continue
		}
		for f, v := range fields {
			if got[f] != v {
				t.Errorf("%s.%s = %v, want %v (%v)", k, f, got[f], v, got)
			}
		}
	}
	if m["resultPtr"] == nil {
		t.Error("a pointer to a result logs nothing")
	}
}

func TestErrorName(t *testing.T) {
	if got := ErrorName(errors.New("SECRET")); got != "*errors.errorString" {
		t.Errorf("ErrorName = %q", got)
	}
	if got := ErrorName(nil); got != "" {
		t.Errorf("ErrorName(nil) = %q", got)
	}
}
