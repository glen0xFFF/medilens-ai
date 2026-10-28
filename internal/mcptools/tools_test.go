package mcptools

import (
	"context"
	"encoding/json"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/medilens-ai/medilens/internal/ai"
	"github.com/medilens-ai/medilens/internal/contracts"
	"github.com/medilens-ai/medilens/internal/demo"
	"github.com/medilens-ai/medilens/internal/imaging"
	"github.com/medilens-ai/medilens/internal/pipeline"
)

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

var allTools = []string{
	"assess_image_quality",
	"extract_medication_label",
	"lookup_medication_reference",
	"compare_medication_evidence",
	"explain_verified_label",
	"get_reference_details",
}

/* ------------------------------------------------------------ the tool list */

func TestTheServerListsExactlyTheSixTools(t *testing.T) {
	cs := connect(t, newService(t, svcOptions{}))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range res.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)
	want := slices.Clone(allTools)
	slices.Sort(want)
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("tools %v, want %v", names, want)
	}
}

// Go port spec §5: tool descriptions state that label text is untrusted
// data; there are no URL, shell or free query inputs; every tool is
// read-only except the transient analysis.
func TestToolDefinitionsAreClosedAndSayLabelTextIsUntrusted(t *testing.T) {
	cs := connect(t, newService(t, svcOptions{}))
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	allowedInputs := map[string][]string{
		"assess_image_quality":        {"image_base64"},
		"extract_medication_label":    {"images_base64", "scenario_id"},
		"lookup_medication_reference": {"analysis_id"},
		"compare_medication_evidence": {"analysis_id"},
		"explain_verified_label":      {"analysis_id", "question"},
		"get_reference_details":       {"analysis_id", "registration_number"},
	}
	for _, tool := range res.Tools {
		if !strings.Contains(tool.Description, UntrustedNotice) {
			t.Errorf("%s: description lacks the untrusted-data notice:\n%s", tool.Name, tool.Description)
		}
		b, _ := json.Marshal(tool.InputSchema)
		var schema struct {
			Type                 string                     `json:"type"`
			AdditionalProperties *bool                      `json:"additionalProperties"`
			Properties           map[string]json.RawMessage `json:"properties"`
		}
		if err := json.Unmarshal(b, &schema); err != nil {
			t.Fatal(err)
		}
		if schema.Type != "object" || schema.AdditionalProperties == nil || *schema.AdditionalProperties {
			t.Errorf("%s: input schema is not a closed object: %s", tool.Name, b)
		}
		var props []string
		for p := range schema.Properties {
			props = append(props, p)
		}
		slices.Sort(props)
		if !reflect.DeepEqual(props, allowedInputs[tool.Name]) {
			t.Errorf("%s: inputs %v, want %v", tool.Name, props, allowedInputs[tool.Name])
		}
		if tool.OutputSchema == nil {
			t.Errorf("%s: no output schema", tool.Name)
		}
		a := tool.Annotations
		if a == nil {
			t.Errorf("%s: no annotations", tool.Name)
			continue
		}
		wantReadOnly := tool.Name != "extract_medication_label"
		if a.ReadOnlyHint != wantReadOnly {
			t.Errorf("%s: readOnlyHint %v", tool.Name, a.ReadOnlyHint)
		}
		if a.DestructiveHint == nil || *a.DestructiveHint {
			t.Errorf("%s: destructiveHint must be false", tool.Name)
		}
		// only extract (the model and the registry) and explain (the Muse
		// Spark phrase explainer on a live result, final review M9) may
		// reach the configured providers; no tool browses or takes a URL
		openWorld := tool.Name == "extract_medication_label" || tool.Name == "explain_verified_label"
		if a.OpenWorldHint == nil || *a.OpenWorldHint != openWorld {
			t.Errorf("%s: openWorldHint %v", tool.Name, a.OpenWorldHint)
		}
	}
}

/* ------------------------------------------------------------ assess_image_quality */

func TestAssessImageQualityMeasuresTheNormalisedPhoto(t *testing.T) {
	cs := connect(t, newService(t, svcOptions{}))
	for _, c := range []struct {
		name       string
		img        []byte
		wantOK     bool
		nextAction string
	}{
		{"sharp", sharp(t), true, NextActionExtract},
		{"blurry", blurry(t), false, NextActionRetake},
	} {
		got := ok[AssessOutput](t, call(t, cs, "assess_image_quality", map[string]any{"image_base64": b64(c.img)}))
		n, err := imaging.Normalize(c.img)
		if err != nil {
			t.Fatal(err)
		}
		want, err := imaging.AssessWith(n, imaging.DefaultThresholds())
		if err != nil {
			t.Fatal(err)
		}
		if got.OK != c.wantOK || got.OK != want.OK || got.Sharpness != want.Sharpness || got.Luminance != want.Luminance ||
			got.GlareFraction != want.GlareFraction || !reflect.DeepEqual(got.Reasons, want.Reasons) || got.NextAction != c.nextAction {
			t.Errorf("%s: got %+v, want %+v next %s", c.name, got, want, c.nextAction)
		}
		if got.Reasons == nil {
			t.Errorf("%s: reasons must be [], not null", c.name)
		}
	}
}

func TestAssessImageQualityErrors(t *testing.T) {
	cs := connect(t, newService(t, svcOptions{}))
	assess := func(arg any) *mcp.CallToolResult {
		return call(t, cs, "assess_image_quality", map[string]any{"image_base64": arg})
	}
	// not base64
	toolErr(t, assess("SECRET-not base64!!"), contracts.ErrValidationFailed)
	// base64 of something that is no image
	toolErr(t, assess(b64([]byte("SECRET hello, not a photo"))), contracts.ErrInvalidImage)
	// one byte over 8 MiB decoded
	toolErr(t, assess(b64(make([]byte, imaging.MaxImageBytes+1))), contracts.ErrImageTooLarge)
	// far over: refused from its length, before any decode (decoding this
	// would fail as VALIDATION_FAILED)
	toolErr(t, assess(strings.Repeat("#", 12<<20)), contracts.ErrImageTooLarge)
	// the longest base64 of an 8 MiB photo, wrapped every 76 characters,
	// passes the length check (and fails later only as a non-image)
	raw := b64(make([]byte, imaging.MaxImageBytes))
	var wrapped strings.Builder
	for i := 0; i < len(raw); i += 76 {
		wrapped.WriteString(raw[i:min(i+76, len(raw))])
		wrapped.WriteString("\r\n")
	}
	toolErr(t, assess(wrapped.String()), contracts.ErrInvalidImage)
	// schema: missing, empty, wrong type, an extra argument
	for _, args := range []map[string]any{
		{},
		{"image_base64": ""},
		{"image_base64": 5},
		{"image_base64": b64(sharp(t)), "url": "https://example.org/SECRET.jpg"},
	} {
		res := call(t, cs, "assess_image_quality", args)
		if !res.IsError {
			t.Errorf("%v: accepted", args)
		}
	}
}

/* ------------------------------------------------------------ extract_medication_label */

func wantFields(label contracts.ExtractedLabel) []Field {
	out := make([]Field, len(label.Fields))
	for i, f := range label.Fields {
		out[i] = Field{Key: f.Key, Value: f.Value, Legibility: f.Legibility, EvidenceText: f.EvidenceText}
	}
	return out
}

func TestExtractADemoScenario(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	got := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"scenario_id": "s1-clear"}))
	s1 := scenario(t, "s1-clear")
	if !uuidV4.MatchString(got.AnalysisID) || got.PipelineState != contracts.PipelineExplanationReady ||
		got.ImageKind == nil || *got.ImageKind != contracts.ImageKindLabel || !got.IsDemo ||
		!reflect.DeepEqual(got.Fields, wantFields(s1.Label)) || !reflect.DeepEqual(got.Warnings, s1.Label.Warnings) {
		t.Fatalf("%s", jsonOf(t, got))
	}
	// the analysis is stored for the follow-up tools, as the API stores it
	r, err := svc.Result(got.AnalysisID)
	if err != nil || r.ID != got.AnalysisID || !r.IsDemo {
		t.Fatalf("stored %+v %v", r, err)
	}
	// a quality failure: no label was read
	s2 := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"scenario_id": "s2-blurry"}))
	if s2.PipelineState != contracts.PipelineLabelUnreadable || s2.ImageKind != nil || s2.Fields == nil || len(s2.Fields) != 0 ||
		s2.Warnings == nil || !s2.IsDemo {
		t.Fatalf("s2 %s", jsonOf(t, s2))
	}
	// a loose pill keeps no transcribed values
	s6 := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"scenario_id": "s6-loose-pill"}))
	if s6.PipelineState != contracts.PipelineLoosePill {
		t.Fatalf("s6 %s", jsonOf(t, s6))
	}
	for _, f := range s6.Fields {
		if f.Value != nil || f.EvidenceText != nil || f.Legibility != contracts.LegibilityUnreadable {
			t.Errorf("s6 field %+v", f)
		}
	}
}

func TestExtractUploadsWithTheMockProviderAreDemoData(t *testing.T) {
	cs := connect(t, newService(t, svcOptions{}))
	got := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"images_base64": []string{b64(sharp(t))}}))
	if !got.IsDemo || got.PipelineState != contracts.PipelineExplanationReady ||
		!reflect.DeepEqual(got.Fields, wantFields(scenario(t, demo.UploadScenario).Label)) {
		t.Fatalf("%s", jsonOf(t, got))
	}
	// a blurry photo is a result that needs attention, not an error
	bl := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"images_base64": []string{b64(blurry(t))}}))
	if bl.PipelineState != contracts.PipelineLabelUnreadable || bl.ImageKind != nil || !bl.IsDemo {
		t.Fatalf("blurry %s", jsonOf(t, bl))
	}
}

func TestExtractLiveUploadIsNotDemoData(t *testing.T) {
	p := liveProviders(fixedReader{ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel}},
		scenario(t, "s1-clear").Reference, &countingExplainer{})
	cs := connect(t, newService(t, svcOptions{providers: &p}))
	got := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"images_base64": []string{b64(sharp(t))}}))
	if got.IsDemo || got.PipelineState != contracts.PipelineExplanationReady {
		t.Fatalf("%s", jsonOf(t, got))
	}
}

func TestExtractErrors(t *testing.T) {
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"}
	var created atomic.Int32
	p := liveProviders(fixedReader{ai.ReadResult{OK: false, Detail: "invalid_output"}}, scenario(t, "s1-clear").Reference, &countingExplainer{})
	svc := newService(t, svcOptions{providers: &p, newID: func() string { return ids[int(created.Add(1)-1)%len(ids)] }})
	cs := connect(t, svc)
	extract := func(args map[string]any) *mcp.CallToolResult { return call(t, cs, "extract_medication_label", args) }

	// neither or both inputs
	toolErr(t, extract(map[string]any{}), contracts.ErrValidationFailed)
	toolErr(t, extract(map[string]any{"images_base64": []string{b64(sharp(t))}, "scenario_id": "s1-clear"}), contracts.ErrValidationFailed)
	// too few or too many photos, an unknown scenario, an extra argument
	for _, args := range []map[string]any{
		{"images_base64": []string{}},
		{"images_base64": []string{"a", "b", "c", "d"}},
		{"scenario_id": "SECRET-no-such-scenario"},
		{"scenario_id": "s1-clear", "query": "SECRET"},
	} {
		if res := extract(args); !res.IsError {
			t.Errorf("%v: accepted", args)
		}
	}
	// bad photos are refused synchronously, before an analysis exists
	toolErr(t, extract(map[string]any{"images_base64": []string{"SECRET not base64 ###"}}), contracts.ErrValidationFailed)
	toolErr(t, extract(map[string]any{"images_base64": []string{b64(make([]byte, imaging.MaxImageBytes+1))}}), contracts.ErrImageTooLarge)
	toolErr(t, extract(map[string]any{"images_base64": []string{b64([]byte("SECRET not a photo"))}}), contracts.ErrInvalidImage)
	if n := created.Load(); n != 0 {
		t.Fatalf("an analysis was created for an invalid upload")
	}
	// a failed analysis is an error result, and is not left behind
	toolErr(t, extract(map[string]any{"images_base64": []string{b64(sharp(t))}}), contracts.ErrOCRFailed)
	if n := created.Load(); n != 1 {
		t.Fatalf("analyses created: %d", n)
	}
	if _, err := svc.Status(ids[0]); !isCode(err, contracts.ErrNotFound) {
		t.Errorf("the failed analysis is still stored: %v", err)
	}
}

func isCode(err error, code contracts.ErrorCode) bool {
	pe, ok := err.(*pipeline.Error)
	return ok && pe.Code == code
}

// A full queue is RATE_LIMITED, as the API's 503.
func TestExtractQueueFull(t *testing.T) {
	g := newGate(ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel})
	p := liveProviders(g, scenario(t, "s1-clear").Reference, &countingExplainer{})
	svc := newService(t, svcOptions{providers: &p, workers: 1, queue: 1})
	// one running, one queued
	if _, err := svc.Create(context.Background(), [][]byte{sharp(t)}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, g.started, "the first read")
	if _, err := svc.Create(context.Background(), [][]byte{sharp(t)}); err != nil {
		t.Fatal(err)
	}
	cs := connect(t, svc)
	toolErr(t, call(t, cs, "extract_medication_label", map[string]any{"images_base64": []string{b64(sharp(t))}}), contracts.ErrRateLimited)
	close(g.release)
}

// A caller that gives up (its context ends) stops the analysis it
// started: the job is cancelled and the analysis deleted.
func TestExtractCancelledByTheCallerDropsItsAnalysis(t *testing.T) {
	const id = "00000000-0000-4000-8000-0000000000aa"
	g := newGate(ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel})
	p := liveProviders(g, scenario(t, "s1-clear").Reference, &countingExplainer{})
	svc := newService(t, svcOptions{providers: &p, newID: func() string { return id }})
	cs := connect(t, svc)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "extract_medication_label", Arguments: map[string]any{"images_base64": []string{b64(sharp(t))}}})
		done <- err
	}()
	waitFor(t, g.started, "the read")
	cancel()
	if err := <-done; err == nil {
		t.Error("the cancelled call returned a result")
	}
	waitFor(t, g.cancelled, "the job's cancellation")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := svc.Status(id); isCode(err, contracts.ErrNotFound) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the abandoned analysis is still stored")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

/* ------------------------------------------------------------ the analysis-bound tools */

func demoAnalysis(t testing.TB, cs *mcp.ClientSession, scenarioID string) string {
	t.Helper()
	return ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"scenario_id": scenarioID})).AnalysisID
}

func TestLookupMedicationReference(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	for _, c := range []struct {
		scenario string
		status   string
	}{
		{"s1-clear", LookupOK},
		{"s3-similar", LookupOK},
		{"s5-nomatch", LookupOK},
		{"s8-registry-down", LookupUnavailable},
		{"s2-blurry", LookupNotAttempted},
		{"s6-loose-pill", LookupNotAttempted},
	} {
		id := demoAnalysis(t, cs, c.scenario)
		got := ok[LookupOutput](t, call(t, cs, "lookup_medication_reference", map[string]any{"analysis_id": id}))
		r, err := svc.Result(id)
		if err != nil {
			t.Fatal(err)
		}
		want := LookupOutput{
			Status: c.status, Candidates: r.Match.Candidates, Advisories: r.Match.Advisories,
			Limitations: r.Match.Limitations, IsDemo: true,
		}
		if jsonOf(t, got) != jsonOf(t, want) {
			t.Errorf("%s:\n got %s\nwant %s", c.scenario, jsonOf(t, got), jsonOf(t, want))
		}
	}
}

func TestCompareMedicationEvidence(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	for _, s := range []string{"s1-clear", "s3-similar", "s4-conflict", "s5-nomatch", "s8-registry-down", "s2-blurry"} {
		id := demoAnalysis(t, cs, s)
		got := ok[CompareOutput](t, call(t, cs, "compare_medication_evidence", map[string]any{"analysis_id": id}))
		r, err := svc.Result(id)
		if err != nil {
			t.Fatal(err)
		}
		// the MatchAssessment keys, unchanged, plus isDemo
		var m map[string]any
		if err := json.Unmarshal([]byte(jsonOf(t, got)), &m); err != nil {
			t.Fatal(err)
		}
		if m["isDemo"] != true {
			t.Errorf("%s: isDemo %v", s, m["isDemo"])
		}
		delete(m, "isDemo")
		if jsonOf(t, m) != canonical(t, jsonOf(t, r.Match)) {
			t.Errorf("%s:\n got %s\nwant %s", s, jsonOf(t, m), jsonOf(t, r.Match))
		}
	}
}

func canonical(t testing.TB, s string) string {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatal(err)
	}
	return jsonOf(t, v)
}

func TestAnalysisBoundToolsRefuseUnknownOrUnfinishedAnalyses(t *testing.T) {
	g := newGate(ai.ReadResult{OK: true, Label: scenario(t, "s1-clear").Label, Model: ai.MuseModel})
	p := liveProviders(g, scenario(t, "s1-clear").Reference, &countingExplainer{})
	svc := newService(t, svcOptions{providers: &p})
	cs := connect(t, svc)
	running, err := svc.Create(context.Background(), [][]byte{sharp(t)})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, g.started, "the read")
	defer close(g.release)
	for _, tool := range []struct {
		name  string
		extra map[string]any
	}{
		{"lookup_medication_reference", nil},
		{"compare_medication_evidence", nil},
		{"explain_verified_label", map[string]any{"question": "What strength is printed here?"}},
		{"get_reference_details", map[string]any{"registration_number": "DR-XY12345"}},
	} {
		args := func(id any) map[string]any {
			m := map[string]any{"analysis_id": id}
			for k, v := range tool.extra {
				m[k] = v
			}
			return m
		}
		toolErr(t, call(t, cs, tool.name, args("00000000-0000-4000-8000-00000000dead")), contracts.ErrNotFound)
		toolErr(t, call(t, cs, tool.name, args(running)), pipeline.CodeAnalysisNotReady)
		if res := call(t, cs, tool.name, args("")); !res.IsError {
			t.Errorf("%s: an empty id was accepted", tool.name)
		}
		if res := call(t, cs, tool.name, args(strings.Repeat("x", 65))); !res.IsError {
			t.Errorf("%s: a 65-character id was accepted", tool.name)
		}
		if res := call(t, cs, tool.name, args(42)); !res.IsError {
			t.Errorf("%s: a number id was accepted", tool.name)
		}
	}
}

/* ------------------------------------------------------------ get_reference_details */

func TestGetReferenceDetailsForAStoredCandidate(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	id := demoAnalysis(t, cs, "s3-similar")
	r, err := svc.Result(id)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Match.Candidates) < 2 {
		t.Fatalf("s3 has %d candidates", len(r.Match.Candidates))
	}
	for _, rec := range r.Match.Candidates {
		got := ok[DetailsOutput](t, call(t, cs, "get_reference_details", map[string]any{
			"analysis_id": id, "registration_number": rec.RegistrationNumber,
		}))
		want := DetailsOutput{
			SourceName: DemoSourceName, SourceURL: rec.SourceURL, Record: rec, CheckedAt: nil,
			Limitations: r.Match.Limitations, IsDemo: true,
		}
		if jsonOf(t, got) != jsonOf(t, want) {
			t.Errorf("\n got %s\nwant %s", jsonOf(t, got), jsonOf(t, want))
		}
	}
}

func TestGetReferenceDetailsOfALiveResult(t *testing.T) {
	s1 := scenario(t, "s1-clear")
	search := s1.Reference
	search.Records = slices.Clone(search.Records)
	for i := range search.Records {
		search.Records[i].Provider = "ph-fda"
		search.Records[i].SourceURL = "https://verification.fda.gov.ph/?search=Paracelin"
		search.Records[i].CheckedAt = "2026-10-27T09:00:00.000Z"
	}
	p := liveProviders(fixedReader{ai.ReadResult{OK: true, Label: s1.Label, Model: ai.MuseModel}}, search, &countingExplainer{})
	svc := newService(t, svcOptions{providers: &p})
	cs := connect(t, svc)
	id := ok[ExtractOutput](t, call(t, cs, "extract_medication_label", map[string]any{"images_base64": []string{b64(sharp(t))}})).AnalysisID
	r, err := svc.Result(id)
	if err != nil || len(r.Match.Candidates) == 0 {
		t.Fatalf("%+v %v", r.Match, err)
	}
	rec := r.Match.Candidates[0]
	got := ok[DetailsOutput](t, call(t, cs, "get_reference_details", map[string]any{"analysis_id": id, "registration_number": rec.RegistrationNumber}))
	if got.SourceName != PHFDASourceName || got.SourceURL != rec.SourceURL || got.IsDemo ||
		got.CheckedAt == nil || *got.CheckedAt != rec.CheckedAt || jsonOf(t, got.Record) != jsonOf(t, rec) {
		t.Fatalf("%s", jsonOf(t, got))
	}
}

// Hunt: a registration number that is not one of the stored candidates is
// refused, whatever its spelling, and never echoed back.
func TestGetReferenceDetailsRefusesANumberThatIsNotACandidate(t *testing.T) {
	svc := newService(t, svcOptions{})
	cs := connect(t, svc)
	id := demoAnalysis(t, cs, "s1-clear")
	r, err := svc.Result(id)
	if err != nil || len(r.Match.Candidates) == 0 {
		t.Fatalf("%+v %v", r.Match, err)
	}
	reg := r.Match.Candidates[0].RegistrationNumber
	for _, n := range []string{
		"SECRET-DR-00000",
		strings.ToLower(reg),
		" " + reg,
		reg + " ",
		reg + "\u200b",
		reg[:len(reg)-1],
	} {
		text := toolErr(t, call(t, cs, "get_reference_details", map[string]any{"analysis_id": id, "registration_number": n}), contracts.ErrValidationFailed)
		if strings.Contains(text, "SECRET") || (n != reg && strings.Contains(text, n)) {
			t.Errorf("%q: the error echoes the input: %q", n, text)
		}
	}
	// a scan with no candidates has nothing to detail
	s2 := demoAnalysis(t, cs, "s2-blurry")
	toolErr(t, call(t, cs, "get_reference_details", map[string]any{"analysis_id": s2, "registration_number": reg}), contracts.ErrValidationFailed)
	// schema: empty, too long
	for _, n := range []any{"", strings.Repeat("D", 65), 7} {
		if res := call(t, cs, "get_reference_details", map[string]any{"analysis_id": id, "registration_number": n}); !res.IsError {
			t.Errorf("%v: accepted", n)
		}
	}
}
