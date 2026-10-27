package eval

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/metaapi"
	"github.com/medilens-ai/medilens/internal/parity"
)

// The cases port apps/server/test/eval/smoke.test.ts (tag
// node-fallback-v1). The Muse Spark replies are the recorded synthetic
// fixtures (DEMO DATA, fictional product), served by a local fake: no
// network.

func museFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	dir, err := parity.Dir()
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "providers", "muse", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// readThrough runs one Muse Spark label read against a fake serving body,
// with log recording the completions.
func readThrough(t *testing.T, body map[string]any, log *CompletionLog) ai.ReadResult {
	t.Helper()
	raw, _ := json.Marshal(body)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	t.Cleanup(srv.Close)
	client, err := metaapi.New("test-key", metaapi.WithBaseURL(srv.URL),
		metaapi.WithHTTPClient(&http.Client{Transport: log.Transport(http.DefaultTransport)}))
	if err != nil {
		t.Fatal(err)
	}
	res, err := ai.NewMuseSpark(client, ai.MuseSparkOptions{}).Read(context.Background(), [][]byte{[]byte("not-decoded-by-the-reader")})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func f64(v float64) *float64 { return &v }

func TestCompletionLogRecordsUsage(t *testing.T) {
	body := museFixture(t, "label-ok")
	body["usage"] = map[string]any{
		"prompt_tokens": 1200, "completion_tokens": 900, "total_tokens": 2100,
		"completion_tokens_details": map[string]any{"reasoning_tokens": 640},
	}
	var log CompletionLog
	if res := readThrough(t, body, &log); !res.OK {
		t.Fatalf("read failed: %s", res.Detail)
	}
	want := []CompletionRecord{{
		Model: contracts.Ptr("muse-spark-1.3"), FinishReason: contracts.Ptr("stop"),
		PromptTokens: f64(1200), CompletionTokens: f64(900), TotalTokens: f64(2100), ReasoningTokens: f64(640),
	}}
	if got := log.Records(); !reflect.DeepEqual(got, want) {
		t.Errorf("records %s, want %s", dump(got), dump(want))
	}
}

func TestCompletionLogReasoningTokensAbsent(t *testing.T) {
	body := museFixture(t, "label-ok")
	body["usage"] = map[string]any{"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30}
	var log CompletionLog
	readThrough(t, body, &log)
	recs := log.Records()
	if len(recs) != 1 || recs[0].ReasoningTokens != nil {
		t.Errorf("records %s, want reasoningTokens null", dump(recs))
	}
}

func TestIsContributorModel(t *testing.T) {
	if !IsContributorModel(contracts.Ptr("muse-spark-1.3-Contributor")) {
		t.Error("contributor not flagged")
	}
	if IsContributorModel(contracts.Ptr("muse-spark-1.3")) {
		t.Error("muse-spark-1.3 flagged")
	}
	if !IsContributorModel(nil) {
		t.Error("no model not flagged")
	}
	// node: /contributor/i.test('muse-CONTRİBUTOR') is false (ASCII
	// folding only), /contributor/i.test('x-CONTRIBUTOR') is true
	if IsContributorModel(contracts.Ptr("muse-CONTRİBUTOR")) || !IsContributorModel(contracts.Ptr("x-CONTRIBUTOR")) {
		t.Error("contributor match is not JS /contributor/i")
	}
}

func TestFetchLogRecordsKeysOnly(t *testing.T) {
	body := `{"cdrr":[{"brand_name":"Paracelin"}],"fdawebsite":[{"title":"Advisory","link":"https://example.org/a"}]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/html" {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(w, "<html>")
			return
		}
		_, _ = io.WriteString(w, body)
	}))
	defer srv.Close()
	var log FetchLog
	client := &http.Client{Transport: log.Transport(http.DefaultTransport)}
	res, err := client.Get(srv.URL + "/api/search?q=a")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(got) != body {
		t.Errorf("body %q, want %q", got, body)
	}
	res, err = client.Get(srv.URL + "/html")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	want := []FetchRecord{
		{Status: 200, TopLevelKeys: []string{"cdrr", "fdawebsite"}, AdvisoryRowKeys: []string{"link", "title"}},
		{Status: 503, TopLevelKeys: []string{}, AdvisoryRowKeys: []string{}},
	}
	recs := log.Records()
	if !reflect.DeepEqual(recs, want) {
		t.Errorf("records %+v, want %+v", recs, want)
	}
	if strings.Contains(dump(recs), "Paracelin") {
		t.Error("a value was recorded")
	}
}

var smokeCompletion = CompletionRecord{
	Model: contracts.Ptr("muse-spark-1.3"), FinishReason: contracts.Ptr("stop"),
	PromptTokens: f64(1200), CompletionTokens: f64(900), TotalTokens: f64(2100), ReasoningTokens: f64(640),
}

func secretLabel() contracts.ExtractedLabel {
	return contracts.ExtractedLabel{
		ImageKind: contracts.ImageKindLabel,
		Fields: []contracts.LabelField{
			{Key: contracts.FieldBrandName, Value: contracts.Ptr("SECRET BRAND"), Legibility: contracts.LegibilityClear, EvidenceText: contracts.Ptr("SECRET EVIDENCE")},
			{Key: contracts.FieldStrength, Legibility: contracts.LegibilityUnreadable},
		},
		RawText:  "SECRET RAW TEXT",
		Warnings: []string{"SECRET WARNING"},
	}
}

func TestRenderSmokeReportNeverPrintsReadText(t *testing.T) {
	lines, aborted := RenderSmokeReport(SmokeReportInput{
		Completions: []CompletionRecord{smokeCompletion},
		Read:        ai.ReadResult{OK: true, Label: secretLabel(), Model: "muse-spark-1.3"},
		Fetches:     []FetchRecord{{Status: 200, TopLevelKeys: []string{"cdrr"}, AdvisoryRowKeys: []string{}}},
		FDA:         &contracts.SearchResult{Kind: contracts.SearchOK},
	})
	out := strings.Join(lines, "\n")
	if aborted {
		t.Error("aborted")
	}
	for _, s := range []string{"model=muse-spark-1.3", "reasoning_tokens=640", "prompt_tokens=1200", "Label read: ok", "PH FDA lookup: ok"} {
		if !strings.Contains(out, s) {
			t.Errorf("missing %q in:\n%s", s, out)
		}
	}
	if strings.Contains(out, "SECRET") {
		t.Errorf("read text printed:\n%s", out)
	}
	// the exact lines, as the Node report wrote them
	want := []string{
		"Muse Spark call 1: model=muse-spark-1.3 finish_reason=stop prompt_tokens=1200 completion_tokens=900 total_tokens=2100 reasoning_tokens=640",
		"Label read: ok (imageKind=label, fields with a value: 1/2, clear: 1)",
		"PH FDA request 1: HTTP 200; top-level keys: cdrr; fdawebsite row keys: (none)",
		"PH FDA lookup: ok (records: 0, advisories: 0)",
	}
	if !reflect.DeepEqual(lines, want) {
		t.Errorf("lines:\n%s\nwant:\n%s", out, strings.Join(want, "\n"))
	}
}

func TestRenderSmokeReportNotReported(t *testing.T) {
	c := smokeCompletion
	c.ReasoningTokens = nil
	lines, _ := RenderSmokeReport(SmokeReportInput{
		Completions: []CompletionRecord{c},
		Read:        ai.ReadResult{Detail: "invalid_output"},
	})
	out := strings.Join(lines, "\n")
	for _, s := range []string{"reasoning_tokens=not reported", "Label read: failed (OCR_FAILED: invalid_output)", "PH FDA lookup: not run"} {
		if !strings.Contains(out, s) {
			t.Errorf("missing %q in:\n%s", s, out)
		}
	}
}

func TestRenderSmokeReportAbortsOnContributor(t *testing.T) {
	c := smokeCompletion
	c.Model = contracts.Ptr("muse-spark-1.3-contributor")
	lines, aborted := RenderSmokeReport(SmokeReportInput{
		Completions: []CompletionRecord{c},
		Read:        ai.ReadResult{Detail: "contributor_model"},
	})
	if !aborted || !strings.Contains(strings.Join(lines, "\n"), "ABORT") {
		t.Errorf("aborted=%v lines=%v", aborted, lines)
	}
}

func TestRenderSmokeReportOtherLines(t *testing.T) {
	lines, _ := RenderSmokeReport(SmokeReportInput{
		Read: ai.ReadResult{Detail: "request_failed"},
		FDA:  &contracts.SearchResult{Kind: contracts.SearchUnavailable, Reason: "lookup failed: HTTP 503"},
	})
	want := []string{
		"Muse Spark: no completion returned.",
		"Label read: failed (OCR_FAILED: request_failed)",
		"PH FDA lookup: unavailable (lookup failed: HTTP 503)",
	}
	if !reflect.DeepEqual(lines, want) {
		t.Errorf("lines %q, want %q", lines, want)
	}
	lines, _ = RenderSmokeReport(SmokeReportInput{
		Completions: []CompletionRecord{{}},
		Read:        ai.ReadResult{Detail: "request_failed"},
		FDA:         &contracts.SearchResult{Kind: contracts.SearchOK, Records: make([]contracts.ReferenceRecord, 2), AdvisoriesUnchecked: true},
	})
	if lines[0] != "Muse Spark call 1: model=(none) finish_reason=(none) prompt_tokens=not reported completion_tokens=not reported total_tokens=not reported reasoning_tokens=not reported" {
		t.Errorf("line 0 %q", lines[0])
	}
	if lines[len(lines)-1] != "ABORT: a contributor model served this request; its output is not used." {
		t.Errorf("no model must abort: %q", lines)
	}
	lines, _ = RenderSmokeReport(SmokeReportInput{
		Read: ai.ReadResult{Detail: "request_failed"},
		FDA:  &contracts.SearchResult{Kind: contracts.SearchOK, Records: make([]contracts.ReferenceRecord, 2), AdvisoriesUnchecked: true},
	})
	if got := lines[len(lines)-1]; got != "PH FDA lookup: ok (records: 2, advisories: 0, advisories unchecked)" {
		t.Errorf("last line %q", got)
	}
	lines, _ = RenderSmokeReport(SmokeReportInput{
		Read: ai.ReadResult{Detail: "request_failed"},
		FDA:  &contracts.SearchResult{Kind: contracts.SearchNotAttempted},
	})
	if got := lines[len(lines)-1]; got != "PH FDA lookup: not attempted" {
		t.Errorf("last line %q", got)
	}
}

func TestJSNumberString(t *testing.T) {
	for in, want := range map[float64]string{0: "0", 1200: "1200", 0.5: "0.5", 1e21: "1e+21", 1.5e-7: "1.5e-7", -3: "-3", 123456789012: "123456789012"} {
		if got := jsNumberString(in); got != want {
			t.Errorf("jsNumberString(%v) = %q, want %q", in, got, want)
		}
	}
}

func dump(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
