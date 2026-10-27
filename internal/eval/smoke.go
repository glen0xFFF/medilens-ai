package eval

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/metaapi"
)

// The live smoke test (services/smoke, spec §9) runs the production
// adapters with these recorders on their HTTP clients. They record
// metadata only: model id, finish reason, token counts, HTTP status and
// response key names. No label text, raw text, evidence or registry value
// is ever recorded or printed.

// CompletionRecord is the metadata of one chat completion. A nil field was
// not in the response (or not a string or number there).
type CompletionRecord struct {
	Model            *string  `json:"model"`
	FinishReason     *string  `json:"finishReason"`
	PromptTokens     *float64 `json:"promptTokens"`
	CompletionTokens *float64 `json:"completionTokens"`
	TotalTokens      *float64 `json:"totalTokens"`
	// ReasoningTokens is usage.completion_tokens_details.reasoning_tokens.
	ReasoningTokens *float64 `json:"reasoningTokens"`
}

// FetchRecord is the metadata of one registry response.
type FetchRecord struct {
	Status int `json:"status"`
	// TopLevelKeys are the key names of a JSON object body, sorted; empty
	// when the body is not a JSON object.
	TopLevelKeys []string `json:"topLevelKeys"`
	// AdvisoryRowKeys are the key names of the first fdawebsite row (the
	// advisory field names to confirm), sorted.
	AdvisoryRowKeys []string `json:"advisoryRowKeys"`
}

// IsContributorModel is the ToS routing caveat (spec §3): a contributor
// model, or no model id at all, aborts. An empty model id aborts too: the
// Go port spec says so, and the final review's ruling is that the spec wins
// over the TS script here (which let "" through), matching the production
// adapter (internal/ai/muse_spark.go). The match folds ASCII case only, as
// /contributor/i (no u flag) does: a JS RegExp never folds a non-ASCII
// letter such as U+0130 onto an ASCII one, while strings.ToLower would.
func IsContributorModel(model *string) bool {
	if model == nil || *model == "" {
		return true
	}
	lower := []byte(*model)
	for i, c := range lower {
		if c >= 'A' && c <= 'Z' {
			lower[i] = c + ('a' - 'A')
		}
	}
	return bytes.Contains(lower, []byte("contributor"))
}

// recordingTransport passes every round trip through to inner and hands
// each response's status and body (up to limit bytes) to record. The
// caller still reads the whole body: the bytes read here are put back in
// front of the rest.
type recordingTransport struct {
	inner  http.RoundTripper
	limit  int64
	record func(status int, body []byte, complete bool)
}

func (t recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	res, err := t.inner.RoundTrip(req)
	if err != nil {
		return res, err
	}
	buf, readErr := io.ReadAll(io.LimitReader(res.Body, t.limit+1))
	complete := readErr == nil && int64(len(buf)) <= t.limit
	rest := res.Body
	res.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(buf), rest), rest}
	if complete {
		t.record(res.StatusCode, buf, true)
	} else {
		t.record(res.StatusCode, nil, false)
	}
	return res, nil
}

// parseJSON is JSON.parse of a body read as text: a leading UTF-8 BOM is
// dropped, numbers stay json.Number, trailing data is an error.
func parseJSON(body []byte) (any, bool) {
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimPrefix(body, []byte("\xef\xbb\xbf"))))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, false
	}
	return v, true
}

func object(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func str(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func num(v any) *float64 {
	n, ok := v.(json.Number)
	if !ok {
		return nil
	}
	// a JSON number beyond float64 is ±Infinity in JS, as ParseFloat's
	// value on a range error
	f, _ := strconv.ParseFloat(string(n), 64)
	return &f
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, CompareUTF16)
	return keys
}

// CompletionLog records one CompletionRecord per chat completion the
// Meta Model API returned (a 2xx JSON body), as the Node recordingClient
// did per completion the SDK returned. It is safe for concurrent use.
type CompletionLog struct {
	mu      sync.Mutex
	records []CompletionRecord
}

// Transport wraps inner (http.DefaultTransport when nil) to record into l.
func (l *CompletionLog) Transport(inner http.RoundTripper) http.RoundTripper {
	if inner == nil {
		inner = http.DefaultTransport
	}
	return recordingTransport{inner: inner, limit: metaapi.MaxResponseBytes, record: func(status int, body []byte, complete bool) {
		if status < 200 || status > 299 || !complete {
			return
		}
		v, ok := parseJSON(body)
		if !ok {
			return
		}
		r := object(v)
		usage := object(r["usage"])
		details := object(usage["completion_tokens_details"])
		choice := map[string]any{}
		if choices, ok := r["choices"].([]any); ok && len(choices) > 0 {
			choice = object(choices[0])
		}
		rec := CompletionRecord{
			Model:            str(r["model"]),
			FinishReason:     str(choice["finish_reason"]),
			PromptTokens:     num(usage["prompt_tokens"]),
			CompletionTokens: num(usage["completion_tokens"]),
			TotalTokens:      num(usage["total_tokens"]),
			ReasoningTokens:  num(details["reasoning_tokens"]),
		}
		l.mu.Lock()
		l.records = append(l.records, rec)
		l.mu.Unlock()
	}}
}

// Records returns a copy of the records so far.
func (l *CompletionLog) Records() []CompletionRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.records)
}

// maxFetchRecordBytes bounds the body read to list key names: the PH FDA
// provider's own limit (16 MiB), which rejects a larger body anyway. A
// larger body is recorded with empty key lists.
const maxFetchRecordBytes = 16 << 20

// FetchLog records one FetchRecord per HTTP response, whatever its status,
// as the Node recordingFetch did. Unlike fetch, which followed redirects
// before the recorder saw a response, a redirect hop is a response here
// too. It is safe for concurrent use.
type FetchLog struct {
	mu      sync.Mutex
	records []FetchRecord
}

// Transport wraps inner (http.DefaultTransport when nil) to record into l.
func (l *FetchLog) Transport(inner http.RoundTripper) http.RoundTripper {
	if inner == nil {
		inner = http.DefaultTransport
	}
	return recordingTransport{inner: inner, limit: maxFetchRecordBytes, record: func(status int, body []byte, complete bool) {
		rec := FetchRecord{Status: status, TopLevelKeys: []string{}, AdvisoryRowKeys: []string{}}
		if v, ok := parseJSON(body); ok && complete {
			if m, isObject := v.(map[string]any); isObject {
				rec.TopLevelKeys = sortedKeys(m)
				if rows, ok := m["fdawebsite"].([]any); ok && len(rows) > 0 {
					if row, ok := rows[0].(map[string]any); ok {
						rec.AdvisoryRowKeys = sortedKeys(row)
					}
				}
			}
		}
		l.mu.Lock()
		l.records = append(l.records, rec)
		l.mu.Unlock()
	}}
}

// Records returns a copy of the records so far.
func (l *FetchLog) Records() []FetchRecord {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.records)
}

// SmokeReportInput is what the smoke run saw.
type SmokeReportInput struct {
	Completions []CompletionRecord
	Read        ai.ReadResult
	Fetches     []FetchRecord
	// FDA is nil when the lookup was not run (after an abort).
	FDA *contracts.SearchResult
}

// jsNumberString is JS String(n). A count beyond float64 is ±Infinity
// (final review M13: it used to panic on the exponent slice).
func jsNumberString(n float64) string {
	switch {
	case n == 0:
		return "0"
	case math.IsInf(n, 1):
		return "Infinity"
	case math.IsInf(n, -1):
		return "-Infinity"
	case math.IsNaN(n):
		return "NaN"
	}
	if a := math.Abs(n); a >= 1e-6 && a < 1e21 {
		return strconv.FormatFloat(n, 'f', -1, 64)
	}
	s := strconv.FormatFloat(n, 'e', -1, 64) // 1.5e-07
	mant, exp, _ := strings.Cut(s, "e")
	sign := exp[:1]
	exp = strings.TrimLeft(exp[1:], "0")
	return mant + "e" + sign + exp
}

func show(n *float64) string {
	if n == nil {
		return "not reported"
	}
	return jsNumberString(*n)
}

func orNone(s *string) string {
	if s == nil {
		return "(none)"
	}
	return *s
}

func orNoneList(keys []string) string {
	if len(keys) == 0 {
		return "(none)"
	}
	return strings.Join(keys, ", ")
}

// RenderSmokeReport is the report lines, counts and metadata only, as the
// Node renderSmokeReport wrote them. aborted is true when any completion
// came from a contributor model (or named none); the registry lines are
// then left out.
func RenderSmokeReport(in SmokeReportInput) (lines []string, aborted bool) {
	for i, c := range in.Completions {
		lines = append(lines, "Muse Spark call "+strconv.Itoa(i+1)+": model="+orNone(c.Model)+
			" finish_reason="+orNone(c.FinishReason)+
			" prompt_tokens="+show(c.PromptTokens)+
			" completion_tokens="+show(c.CompletionTokens)+
			" total_tokens="+show(c.TotalTokens)+
			" reasoning_tokens="+show(c.ReasoningTokens))
		if IsContributorModel(c.Model) {
			aborted = true
		}
	}
	if len(in.Completions) == 0 {
		lines = append(lines, "Muse Spark: no completion returned.")
	}

	if in.Read.OK {
		fields := in.Read.Label.Fields
		withValue, clear := 0, 0
		for _, f := range fields {
			if f.Value != nil {
				withValue++
			}
			if f.Legibility == contracts.LegibilityClear {
				clear++
			}
		}
		lines = append(lines, "Label read: ok (imageKind="+string(in.Read.Label.ImageKind)+
			", fields with a value: "+strconv.Itoa(withValue)+"/"+strconv.Itoa(len(fields))+
			", clear: "+strconv.Itoa(clear)+")")
	} else {
		lines = append(lines, "Label read: failed ("+string(in.Read.Code())+": "+in.Read.Detail+")")
	}

	if aborted {
		lines = append(lines, "ABORT: a contributor model served this request; its output is not used.")
		return lines, true
	}

	for i, f := range in.Fetches {
		lines = append(lines, "PH FDA request "+strconv.Itoa(i+1)+": HTTP "+strconv.Itoa(f.Status)+
			"; top-level keys: "+orNoneList(f.TopLevelKeys)+
			"; fdawebsite row keys: "+orNoneList(f.AdvisoryRowKeys))
	}
	switch {
	case in.FDA == nil:
		lines = append(lines, "PH FDA lookup: not run")
	case in.FDA.Kind == contracts.SearchOK:
		unchecked := ""
		if in.FDA.AdvisoriesUnchecked {
			unchecked = ", advisories unchecked"
		}
		lines = append(lines, "PH FDA lookup: ok (records: "+strconv.Itoa(len(in.FDA.Records))+
			", advisories: "+strconv.Itoa(len(in.FDA.Advisories))+unchecked+")")
	case in.FDA.Kind == contracts.SearchUnavailable:
		lines = append(lines, "PH FDA lookup: unavailable ("+in.FDA.Reason+")")
	default:
		lines = append(lines, "PH FDA lookup: not attempted")
	}
	return lines, false
}
